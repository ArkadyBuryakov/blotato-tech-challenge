import type { PgBoss } from "pg-boss";
import { executeStep, sendWaitRetry } from "./executor";
import type { EngineDeps } from "./deps";
import { Q, type JobData } from "./queues";
import { routeEvent } from "./router";
import { expireWait } from "./waits";
import { reconcileComments, refreshTokens } from "../jobs/maintenance";

/** Registers all job handlers. Handlers are thin: decode job → call engine function. */
export const startWorkers = async (boss: PgBoss, deps: EngineDeps, opts: { reconciler: boolean }) => {
  const each =
    <N extends keyof JobData>(fn: (data: JobData[N], meta: { isLast: boolean }) => Promise<void>) =>
    async (jobs: { data: JobData[N]; retryCount: number; retryLimit: number }[]) => {
      for (const job of jobs) await fn(job.data, { isLast: job.retryCount >= job.retryLimit });
    };

  const opt = { includeMetadata: true, localConcurrency: 4 } as const;
  await boss.work(Q.routeEvent, opt, each<typeof Q.routeEvent>((d) => routeEvent(deps, d.eventId)));
  await boss.work(Q.executeStep, opt, each<typeof Q.executeStep>((d, m) => executeStep(deps, d, m)));
  await boss.work(Q.waitTimeout, opt, each<typeof Q.waitTimeout>((d) => expireWait(deps, d.runId, d.nodeId)));
  await boss.work(Q.sendWaitRetry, opt, each<typeof Q.sendWaitRetry>((d) => sendWaitRetry(deps, d)));
  await boss.work(Q.refreshTokens, () => refreshTokens(deps));
  await boss.schedule(Q.refreshTokens, "17 3 * * *");

  if (opts.reconciler) {
    await boss.work(Q.reconcileComments, () => reconcileComments(deps));
    await boss.schedule(Q.reconcileComments, "*/5 * * * *");
  } else {
    await boss.unschedule(Q.reconcileComments).catch(() => undefined);
  }
  deps.log.info("workers started");
};
