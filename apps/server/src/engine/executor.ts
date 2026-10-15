import { chooseDelivery, findNode, parseConfig, renderInputs, waitTimeoutMs, type Delivery, type GraphNode } from "@app/core";
import { sql } from "kysely";
import type { Tx } from "../db/client";
import { MetaApiError, type Recipient } from "../instagram/client";
import type { EngineDeps } from "./deps";
import { loadGraph, loadScope, lockRun, refreshRunStatus, scheduleNext } from "./runs";
import { applyReply } from "./waits";

/**
 * Step execution: three phases so that no transaction (and no run lock) is held during a
 * network call to Meta.
 *
 *   1. claim   (tx): idempotency check, render inputs, mark `running`, decide what to send
 *   2. effect  (no tx): call Instagram
 *   3. settle  (tx): store output/error, create + enqueue successors, recompute run status
 *
 * Delivery is at-least-once: a crash between 2 and 3 retries the job and may resend. The
 * window is small and Meta has no idempotency keys; private replies are additionally
 * protected because Instagram itself accepts only one per comment.
 */

type Claim =
  | { kind: "done" }
  | { kind: "effect"; node: GraphNode; input: Record<string, string>; accountId: string; recipient?: Recipient };

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
    result = { ok: true, output: await performEffect(deps, claim) };
  } catch (e) {
    const transient = e instanceof MetaApiError ? e.transient : true;
    if (transient && !attempt.isLast) throw e; // let pg-boss retry with backoff
    result = { ok: false, error: (e as Error).message };
  }

  await deps.db.transaction().execute(async (trx) => {
    const run = await lockRun(trx, job.runId);
    if (!run) return;
    const now = deps.now();
    const output = result.ok
      ? { ...claim.input, execution_status: "succeeded", ...result.output }
      : { ...claim.input, execution_status: "failed" };
    await trx
      .updateTable("run_steps")
      .set({ status: result.ok ? "succeeded" : "failed", output, error: result.ok ? null : result.error, ended_at: now })
      .where("run_id", "=", job.runId)
      .where("node_id", "=", job.nodeId)
      .where("status", "=", "running")
      .execute();
    if (result.ok) await scheduleNext(deps, trx, job.runId, await loadGraph(trx, run.version_id), job.nodeId, "out");
    await refreshRunStatus(trx, job.runId, now);
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
  const node = findNode(graph, job.nodeId);
  const now = deps.now();
  const fail = async (error: string): Promise<Claim> => {
    await trx
      .updateTable("run_steps")
      .set({ status: "failed", error, started_at: step.started_at ?? now, ended_at: now })
      .where("run_id", "=", job.runId)
      .where("node_id", "=", job.nodeId)
      .execute();
    await refreshRunStatus(trx, job.runId, now);
    return { kind: "done" };
  };
  if (!node) return fail("Block no longer exists in this version");

  const input = renderInputs(node.inputs, await loadScope(trx, job.runId));

  if (node.type === "control.wait_for_reply") {
    if (input.user_id !== run.contact_id) return fail("Can only wait for a reply from the person who triggered the run");
    await trx
      .updateTable("run_steps")
      .set({ status: "waiting", input, attempts: sql`attempts + 1`, started_at: now, wait_expires_at: new Date(now.getTime() + waitTimeoutMs(node)) })
      .where("run_id", "=", job.runId)
      .where("node_id", "=", job.nodeId)
      .execute();
    await refreshRunStatus(trx, job.runId, now);
    const expiresAt = new Date(now.getTime() + waitTimeoutMs(node));
    await deps.enqueue(trx, "wait-timeout", { runId: job.runId, nodeId: job.nodeId }, { startAfter: expiresAt });
    await catchUpEarlyReplies(deps, trx, run, job.nodeId);
    return { kind: "done" };
  }

  let recipient: Recipient | undefined;
  if (node.type === "action.send_dm") {
    const delivery = await decideDelivery(trx, run, job.nodeId, input.user_id ?? "");
    recipient = delivery.kind === "user" ? { id: delivery.userId } : { comment_id: delivery.commentId };
    // Recorded with the input: shows how the DM was addressed, and lets later steps see it.
    input.delivery = delivery.kind;
  }

  await trx
    .updateTable("run_steps")
    .set({ status: "running", input, attempts: sql`attempts + 1`, started_at: step.started_at ?? now })
    .where("run_id", "=", job.runId)
    .where("node_id", "=", job.nodeId)
    .execute();
  return { kind: "effect", node, input, accountId: run.ig_account_id, recipient };
};

const performEffect = async (
  deps: EngineDeps,
  claim: Extract<Claim, { kind: "effect" }>,
): Promise<Record<string, unknown>> => {
  const token = await deps.tokens.get(claim.accountId);
  const text = claim.input.message_text ?? "";
  switch (claim.node.type) {
    case "action.send_dm": {
      const r = await deps.ig.sendMessage(token, claim.recipient!, text);
      return { message_id: r.messageId };
    }
    case "action.comment_reply": {
      const r = await deps.ig.replyToComment(token, claim.input.comment_id ?? "", text);
      return { reply_id: r.replyId };
    }
    default:
      throw new MetaApiError(`Block type ${claim.node.type} cannot be executed`, false);
  }
};

/**
 * Address a DM: private reply to the triggering comment, or the user id (see chooseDelivery).
 * Whether Instagram accepts it (24h window, one private reply per comment, ...) is Instagram's
 * call; a rejection fails the step with Instagram's error. Caller holds the run lock, so
 * parallel branches of one run see each other's choice.
 */
const decideDelivery = async (
  trx: Tx,
  run: { id: string; trigger_event_id: number },
  nodeId: string,
  userId: string,
): Promise<Delivery> => {
  const trigger = await trx.selectFrom("inbox_events").select("payload").where("id", "=", run.trigger_event_id).executeTakeFirstOrThrow();
  const comment = trigger.payload.kind === "comment" ? trigger.payload : null;
  const earlier = await trx
    .selectFrom("run_steps")
    .select("node_id")
    .where("run_id", "=", run.id)
    .where("node_id", "!=", nodeId)
    .where("status", "in", ["running", "succeeded"])
    .where(sql<string>`input->>'delivery'`, "=", "private_reply")
    .executeTakeFirst();
  return chooseDelivery({
    userId,
    sourceComment: comment ? { commentId: comment.commentId, fromId: comment.from.id } : null,
    privateReplySentInRun: !!earlier,
  });
};

/**
 * A fast user can answer the DM before this wait step started (the DM is sent by the previous
 * step, then this step is enqueued). Such messages were routed while the run was not waiting,
 * so look back at DMs from the contact received since the previous step started.
 */
const catchUpEarlyReplies = async (
  deps: EngineDeps,
  trx: Tx,
  run: { id: string; version_id: string; ig_account_id: string; contact_id: string; started_at: Date },
  nodeId: string,
): Promise<void> => {
  const graph = await loadGraph(trx, run.version_id);
  const parentId = graph.edges.find((e) => e.target === nodeId)?.source;
  const parent = parentId
    ? await trx.selectFrom("run_steps").select("started_at").where("run_id", "=", run.id).where("node_id", "=", parentId).executeTakeFirst()
    : undefined;
  const since = parent?.started_at ?? run.started_at;
  const early = await trx
    .selectFrom("inbox_events")
    .select("payload")
    .where("ig_account_id", "=", run.ig_account_id)
    .where("kind", "=", "message")
    .where(sql<string>`payload->>'senderId'`, "=", run.contact_id)
    .where("received_at", ">=", since)
    .orderBy("id")
    .execute();
  for (const { payload } of early) {
    if (payload.kind !== "message") continue;
    await applyReply(deps, trx, run, nodeId, payload);
    const step = await trx.selectFrom("run_steps").select("status").where("run_id", "=", run.id).where("node_id", "=", nodeId).executeTakeFirstOrThrow();
    if (step.status !== "waiting") break;
  }
};

/** Re-ask on an invalid reply (e.g. not an email). The user just wrote to us, so the DM window is open. */
export const sendWaitRetry = async (deps: EngineDeps, job: { runId: string; nodeId: string; retry: number }): Promise<void> => {
  const ctx = await deps.db
    .selectFrom("run_steps as s")
    .innerJoin("runs as r", "r.id", "s.run_id")
    .innerJoin("automation_versions as v", "v.id", "r.version_id")
    .select(["s.status", "s.wait_retries", "r.ig_account_id", "r.contact_id", "v.graph"])
    .where("s.run_id", "=", job.runId)
    .where("s.node_id", "=", job.nodeId)
    .executeTakeFirst();
  if (!ctx || ctx.status !== "waiting" || ctx.wait_retries !== job.retry) return;
  const node = findNode(ctx.graph, job.nodeId);
  if (!node) return;
  const { retryMessage } = parseConfig("control.wait_for_reply", node.config);
  const token = await deps.tokens.get(ctx.ig_account_id);
  await deps.ig.sendMessage(token, { id: ctx.contact_id }, retryMessage);
};
