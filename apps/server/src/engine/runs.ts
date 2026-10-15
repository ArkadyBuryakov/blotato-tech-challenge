import { deriveRunStatus, nextNodes, type Graph, type Scope } from "@app/core";
import { sql } from "kysely";
import type { Tx } from "../db/client";
import type { EngineDeps } from "./deps";

/**
 * Run state helpers. Every state transition of a run happens inside a transaction that holds
 * the run row lock (`select ... for update`), so concurrent jobs of the same run (parallel
 * branches, a reply racing a timeout) are serialized and see each other's writes.
 */

export const lockRun = (trx: Tx, runId: string) =>
  trx.selectFrom("runs").selectAll().where("id", "=", runId).forUpdate().executeTakeFirst();

export const loadGraph = async (trx: Tx, versionId: string): Promise<Graph> =>
  (await trx.selectFrom("automation_versions").select("graph").where("id", "=", versionId).executeTakeFirstOrThrow()).graph;

/** Outputs of finished steps, keyed by node id: the scope for `{{node.path}}` templates. */
export const loadScope = async (trx: Tx, runId: string): Promise<Scope> => {
  const rows = await trx
    .selectFrom("run_steps")
    .select(["node_id", "output"])
    .where("run_id", "=", runId)
    .where("status", "in", ["succeeded", "timed_out"])
    .execute();
  return Object.fromEntries(rows.map((r) => [r.node_id, r.output ?? {}]));
};

/** Create pending steps for the successors reached through `port` and enqueue them, atomically. */
export const scheduleNext = async (
  deps: Pick<EngineDeps, "enqueue">,
  trx: Tx,
  runId: string,
  graph: Graph,
  nodeId: string,
  port: string,
): Promise<void> => {
  const targets = nextNodes(graph, nodeId, port);
  if (targets.length === 0) return;
  const inserted = await trx
    .insertInto("run_steps")
    .values(targets.map((t) => ({ run_id: runId, node_id: t, status: "pending" as const })))
    .onConflict((oc) => oc.columns(["run_id", "node_id"]).doNothing())
    .returning("node_id")
    .execute();
  for (const { node_id } of inserted) await deps.enqueue(trx, "execute-step", { runId, nodeId: node_id });
};

export const refreshRunStatus = async (trx: Tx, runId: string, now: Date): Promise<void> => {
  const steps = await trx.selectFrom("run_steps").select("status").where("run_id", "=", runId).execute();
  const status = deriveRunStatus(steps.map((s) => s.status));
  const terminal = status === "succeeded" || status === "failed";
  await trx
    .updateTable("runs")
    .set({ status, ended_at: terminal ? sql<Date>`coalesce(ended_at, ${now})` : null })
    .where("id", "=", runId)
    .execute();
};
