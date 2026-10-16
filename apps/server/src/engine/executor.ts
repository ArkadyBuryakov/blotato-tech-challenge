import { findNode, incoming, parseConfig, renderInputs, waitEventKind, waitMatches, type BlockConfig, type BlockType, type GraphNode, type NodeType } from "@app/core";
import { sql } from "kysely";
import type { Tx } from "../db/client";
import { MetaApiError } from "../instagram/client";
import { handlerFor, type AnyBlockHandler, type Run } from "./blocks";
import type { EngineDeps } from "./deps";
import { loadGraph, loadScope, lockRun } from "./runs";
import { completeStep, deliverEvent, failStep, suspendStep, type StepRef } from "./steps";

/**
 * Step execution, block-agnostic: the block's handler decides, this module persists. Three
 * phases so that no transaction (and no run lock) is held during a network call to Meta.
 *
 *   1. claim   (tx): idempotency check, render inputs, `handler.start` → complete | fail |
 *                    suspend | effect (mark `running`)
 *   2. effect  (no tx): `handler.perform`
 *   3. settle  (tx): store output/error, create + enqueue successors, recompute run status
 *
 * Delivery is at-least-once: a crash between 2 and 3 retries the job and may resend. The
 * window is small and Meta has no idempotency keys; private replies are additionally
 * protected because Instagram itself accepts only one per comment.
 */

type Claim =
  | { kind: "done" }
  | { kind: "effect"; handler: AnyBlockHandler; plan: unknown; run: Run; input: Record<string, string> };

export type StepJob = { runId: string; nodeId: string };

export const executeStep = async (
  deps: EngineDeps,
  job: StepJob,
  attempt: { isLast: boolean },
): Promise<void> => {
  const claim = await deps.db.transaction().execute((trx) => claimStep(deps, trx, job));
  if (claim.kind === "done") return;

  let result: { ok: true; output: Record<string, unknown> } | { ok: false; error: string };
  try {
    if (!claim.handler.perform) throw new MetaApiError("Block has no effect to perform", false);
    result = { ok: true, output: await claim.handler.perform(deps, claim.plan, claim.run) };
  } catch (e) {
    const transient = e instanceof MetaApiError ? e.transient : true;
    if (transient && !attempt.isLast) throw e; // let pg-boss retry with backoff
    result = { ok: false, error: (e as Error).message };
  }

  await deps.db.transaction().execute(async (trx) => {
    const run = await lockRun(trx, job.runId);
    if (!run) return;
    const step = await trx.selectFrom("run_steps").select("status").where("run_id", "=", job.runId).where("node_id", "=", job.nodeId).executeTakeFirst();
    if (step?.status !== "running") return;
    const ref: StepRef = { deps, trx, run, graph: await loadGraph(trx, run.version_id), nodeId: job.nodeId };
    if (result.ok) {
      const output = { ...claim.input, execution_status: "succeeded", ...result.output };
      await completeStep(ref, { kind: "complete", port: claim.handler.effectPort ?? "out", output });
    } else {
      await failStep(ref, result.error, { output: { ...claim.input, execution_status: "failed" } });
    }
  });
  if (!result.ok) deps.log.warn({ ...job, error: result.error }, "step failed");
};

const claimStep = async (deps: EngineDeps, trx: Tx, job: StepJob): Promise<Claim> => {
  const run = await lockRun(trx, job.runId);
  const step = await trx
    .selectFrom("run_steps")
    .selectAll()
    .where("run_id", "=", job.runId)
    .where("node_id", "=", job.nodeId)
    .executeTakeFirst();
  // Idempotency: only pending steps (or running ones whose previous attempt crashed) execute.
  if (!run || !step || (step.status !== "pending" && step.status !== "running")) return { kind: "done" };

  const graph = await loadGraph(trx, run.version_id);
  const ref: StepRef = { deps, trx, run, graph, nodeId: job.nodeId };
  const started = { started_at: step.started_at ?? deps.now() };
  const node = findNode(graph, job.nodeId);
  if (!node) {
    await failStep(ref, "Block no longer exists in this version", started);
    return { kind: "done" };
  }
  const handler = handlerFor(node.type);
  if (!handler) {
    await failStep(ref, `Block type ${node.type} cannot be executed`, started);
    return { kind: "done" };
  }

  const input = renderInputs(node.inputs, await loadScope(trx, job.runId));
  const config = parseConfig(node.type as BlockType, node.config) as BlockConfig<NodeType>;
  const outcome = await handler.start({ deps, trx, run, node, config, input, state: step.state });
  const claimed = { ...started, input, attempts: sql<number>`attempts + 1` };
  switch (outcome.kind) {
    case "fail":
      await failStep(ref, outcome.error, claimed);
      return { kind: "done" };
    case "complete":
      await completeStep(ref, outcome, claimed);
      return { kind: "done" };
    case "suspend":
      await suspendStep(ref, outcome.until, outcome.state, claimed);
      await replayEarlyEvents(ref, node, input);
      return { kind: "done" };
    case "effect":
      await trx
        .updateTable("run_steps")
        .set({ ...claimed, status: "running" })
        .where("run_id", "=", job.runId)
        .where("node_id", "=", job.nodeId)
        .execute();
      return { kind: "effect", handler, plan: outcome.plan, run, input };
  }
};

/**
 * A fast user can answer before this step suspended (the question is sent by the previous
 * step, then this step is enqueued). Such events were routed while nothing was waiting, so
 * offer the ones this step matches, received since the previous step started, in order.
 */
const replayEarlyEvents = async (ref: StepRef, node: GraphNode, input: Record<string, string>): Promise<void> => {
  const kind = waitEventKind(node.type);
  if (!kind) return;
  const parentId = incoming(ref.graph, ref.nodeId)[0]?.source;
  const parent = parentId
    ? await ref.trx.selectFrom("run_steps").select("started_at").where("run_id", "=", ref.run.id).where("node_id", "=", parentId).executeTakeFirst()
    : undefined;
  const early = await ref.trx
    .selectFrom("inbox_events")
    .select("payload")
    .where("ig_account_id", "=", ref.run.ig_account_id)
    .where("kind", "=", kind)
    .where("received_at", ">=", parent?.started_at ?? ref.run.started_at)
    .orderBy("id")
    .execute();
  for (const { payload } of early) {
    if (!waitMatches(node, input, payload)) continue;
    await deliverEvent(ref, payload);
    const step = await ref.trx.selectFrom("run_steps").select("status").where("run_id", "=", ref.run.id).where("node_id", "=", ref.nodeId).executeTakeFirstOrThrow();
    if (step.status !== "waiting") break;
  }
};
