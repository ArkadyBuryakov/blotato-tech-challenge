import { findNode, parseConfig, type BlockConfig, type BlockType, type Graph, type InboundEvent, type NodeType } from "@app/core";
import type { UpdateObject } from "kysely";
import type { Tx } from "../db/client";
import type { Database } from "../db/schema";
import { handlerFor, type AnyBlockHandler, type Completion, type Resume, type Run, type StepState, type TxStepCtx } from "./blocks";
import type { EngineDeps } from "./deps";
import { loadGraph, lockRun, refreshRunStatus, scheduleNext } from "./runs";

/**
 * Block-agnostic step transitions. Every function taking a StepRef runs inside a transaction
 * that holds the run lock, so concurrent jobs of one run (parallel branches, an event racing a
 * deadline) are serialized.
 */
export type StepRef = { readonly deps: EngineDeps; readonly trx: Tx; readonly run: Run; readonly graph: Graph; readonly nodeId: string };

type StepUpdate = UpdateObject<Database, "run_steps">;

const updateStep = (ref: StepRef, set: StepUpdate) =>
  ref.trx.updateTable("run_steps").set(set).where("run_id", "=", ref.run.id).where("node_id", "=", ref.nodeId).execute();

export const completeStep = async (ref: StepRef, c: Completion, extra: StepUpdate = {}): Promise<void> => {
  const now = ref.deps.now();
  await updateStep(ref, { ...extra, status: c.status ?? "succeeded", output: c.output, error: null, ended_at: now });
  await scheduleNext(ref.deps, ref.trx, ref.run.id, ref.graph, ref.nodeId, c.port);
  await refreshRunStatus(ref.trx, ref.run.id, now);
};

export const failStep = async (ref: StepRef, error: string, extra: StepUpdate = {}): Promise<void> => {
  const now = ref.deps.now();
  await updateStep(ref, { ...extra, status: "failed", error, ended_at: now });
  await refreshRunStatus(ref.trx, ref.run.id, now);
};

export const suspendStep = async (ref: StepRef, until: Date, state: StepState, extra: StepUpdate = {}): Promise<void> => {
  await updateStep(ref, { ...extra, status: "waiting", expires_at: until, state });
  await refreshRunStatus(ref.trx, ref.run.id, ref.deps.now());
  await ref.deps.enqueue(ref.trx, "step-timer", { runId: ref.run.id, nodeId: ref.nodeId }, { startAfter: until });
};

/** Persist a suspended step's reaction. Returns whether the event (or deadline) was consumed. */
const applyResume = async (ref: StepRef, r: Resume<StepState>): Promise<boolean> => {
  if (r.kind === "ignore") return false;
  if (r.kind === "complete") {
    await completeStep(ref, r);
    return true;
  }
  if (r.state) await updateStep(ref, { state: r.state });
  for (const t of r.tasks ?? []) await ref.deps.enqueue(ref.trx, "step-task", { runId: ref.run.id, nodeId: ref.nodeId, task: t.name, data: t.data });
  return true;
};

/** The handler and its context for a step that is still suspended. */
const loadSuspended = async (
  ref: StepRef,
): Promise<{ handler: AnyBlockHandler; ctx: TxStepCtx<NodeType, StepState>; expiresAt: Date | null } | undefined> => {
  const step = await ref.trx
    .selectFrom("run_steps")
    .select(["status", "input", "state", "expires_at"])
    .where("run_id", "=", ref.run.id)
    .where("node_id", "=", ref.nodeId)
    .executeTakeFirst();
  if (step?.status !== "waiting") return undefined;
  const node = findNode(ref.graph, ref.nodeId);
  const handler = node && handlerFor(node.type);
  if (!node || !handler) return undefined;
  const config = parseConfig(node.type as BlockType, node.config) as BlockConfig<NodeType>;
  const ctx = { deps: ref.deps, trx: ref.trx, run: ref.run, node, config, input: (step.input ?? {}) as Record<string, string>, state: step.state };
  return { handler, ctx, expiresAt: step.expires_at };
};

/** Offer an event to a suspended step. Returns whether its block consumed it. */
export const deliverEvent = async (ref: StepRef, event: InboundEvent): Promise<boolean> => {
  const s = await loadSuspended(ref);
  const on = s?.handler.on as ((ctx: TxStepCtx<NodeType, StepState>, e: InboundEvent) => Promise<Resume<StepState>>) | undefined;
  if (!s || !on) return false;
  const consumed = await applyResume(ref, await on(s.ctx, event));
  if (consumed) ref.deps.log.info({ runId: ref.run.id, nodeId: ref.nodeId, event: event.externalId }, "event applied to suspended step");
  return consumed;
};

/** step-timer job: the deadline of a suspended step passed. */
export const fireStepTimer = async (deps: EngineDeps, runId: string, nodeId: string): Promise<void> =>
  deps.db.transaction().execute(async (trx) => {
    const run = await lockRun(trx, runId);
    if (!run) return;
    const ref = { deps, trx, run, graph: await loadGraph(trx, run.version_id), nodeId };
    const s = await loadSuspended(ref);
    // An event that won the race already moved the step out of `waiting`.
    if (!s?.handler.onTimer || !s.expiresAt || s.expiresAt > deps.now()) return;
    await applyResume(ref, await s.handler.onTimer(s.ctx));
  });

/** step-task job: a follow-up side effect requested by a suspended step. Runs outside any transaction. */
export const runStepTask = async (deps: EngineDeps, job: { runId: string; nodeId: string; task: string; data: Record<string, unknown> }) => {
  const run = await deps.db.selectFrom("runs").selectAll().where("id", "=", job.runId).executeTakeFirst();
  const step = await deps.db
    .selectFrom("run_steps")
    .select(["status", "input", "state"])
    .where("run_id", "=", job.runId)
    .where("node_id", "=", job.nodeId)
    .executeTakeFirst();
  if (!run || !step) return;
  const node = findNode(await loadGraph(deps.db, run.version_id), job.nodeId);
  const task = node && handlerFor(node.type)?.tasks?.[job.task];
  if (!node || !task) {
    deps.log.warn(job, "unknown step task");
    return;
  }
  const config = parseConfig(node.type as BlockType, node.config) as BlockConfig<NodeType>;
  await task({ deps, run, node, config, input: (step.input ?? {}) as Record<string, string>, state: step.state, status: step.status }, job.data);
};
