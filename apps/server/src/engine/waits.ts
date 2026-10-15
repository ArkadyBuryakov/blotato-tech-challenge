import { evaluateReply, findNode, type MessageEvent } from "@app/core";
import type { Tx } from "../db/client";
import type { EngineDeps } from "./deps";
import { loadGraph, refreshRunStatus, scheduleNext } from "./runs";

/**
 * Apply an inbound DM to a waiting step. Caller holds the run lock.
 * Returns true when the message was consumed by the conversation (accepted, re-asked or ignored).
 */
export const applyReply = async (
  deps: EngineDeps,
  trx: Tx,
  run: { id: string; version_id: string },
  nodeId: string,
  reply: MessageEvent,
): Promise<boolean> => {
  const step = await trx
    .selectFrom("run_steps")
    .selectAll()
    .where("run_id", "=", run.id)
    .where("node_id", "=", nodeId)
    .executeTakeFirst();
  if (step?.status !== "waiting") return false;

  const graph = await loadGraph(trx, run.version_id);
  const node = findNode(graph, nodeId)!;
  const decision = evaluateReply(node, reply, step.wait_retries);
  const now = deps.now();

  if (decision.kind === "accept") {
    await trx
      .updateTable("run_steps")
      .set({ status: "succeeded", output: decision.output, ended_at: now })
      .where("run_id", "=", run.id)
      .where("node_id", "=", nodeId)
      .execute();
    await scheduleNext(deps, trx, run.id, graph, nodeId, "received");
    await refreshRunStatus(trx, run.id, now);
  } else if (decision.kind === "retry") {
    const retry = step.wait_retries + 1;
    await trx
      .updateTable("run_steps")
      .set({ wait_retries: retry })
      .where("run_id", "=", run.id)
      .where("node_id", "=", nodeId)
      .execute();
    await deps.enqueue(trx, "send-wait-retry", { runId: run.id, nodeId, retry });
  }
  deps.log.info({ runId: run.id, nodeId, decision: decision.kind }, "reply applied to waiting step");
  return true;
};

/** Timer fired: the step moves to `timed_out` and the run continues through the `timeout` port. */
export const expireWait = async (deps: EngineDeps, runId: string, nodeId: string): Promise<void> =>
  deps.db.transaction().execute(async (trx) => {
    const run = await trx.selectFrom("runs").selectAll().where("id", "=", runId).forUpdate().executeTakeFirst();
    if (!run) return;
    const now = deps.now();
    // Conditional update: a reply that won the race already moved the step out of `waiting`.
    const res = await trx
      .updateTable("run_steps")
      .set({ status: "timed_out", output: {}, ended_at: now })
      .where("run_id", "=", runId)
      .where("node_id", "=", nodeId)
      .where("status", "=", "waiting")
      .where("wait_expires_at", "<=", now)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) return;
    await scheduleNext(deps, trx, runId, await loadGraph(trx, run.version_id), nodeId, "timeout");
    await refreshRunStatus(trx, runId, now);
  });
