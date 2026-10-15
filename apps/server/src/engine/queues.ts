import { PgBoss, type Queue } from "pg-boss";
import type { DB, Tx } from "../db/client";
import { bossDb } from "../db/client";

export const Q = {
  routeEvent: "route-event",
  executeStep: "execute-step",
  waitTimeout: "wait-timeout",
  sendWaitRetry: "send-wait-retry",
  refreshTokens: "refresh-tokens",
  reconcileComments: "reconcile-comments",
} as const;

export type JobData = {
  [Q.routeEvent]: { eventId: number };
  [Q.executeStep]: { runId: string; nodeId: string };
  [Q.waitTimeout]: { runId: string; nodeId: string };
  [Q.sendWaitRetry]: { runId: string; nodeId: string; retry: number };
  [Q.refreshTokens]: Record<string, never>;
  [Q.reconcileComments]: Record<string, never>;
};

// notify: NOTIFY on insert wakes workers immediately (polling stays as the fallback), so a
// multi-step run does not pay the polling interval on every hop.
const retrying = { retryLimit: 8, retryDelay: 5, retryBackoff: true, retryDelayMax: 600, notify: true } as const;

const queues: readonly Queue[] = [
  { name: Q.routeEvent, ...retrying },
  { name: Q.executeStep, ...retrying, expireInSeconds: 120 },
  { name: Q.waitTimeout, ...retrying },
  { name: Q.sendWaitRetry, ...retrying, expireInSeconds: 120 },
  // Crons: one at a time is enough.
  { name: Q.refreshTokens, policy: "singleton", retryLimit: 2 },
  { name: Q.reconcileComments, policy: "singleton", retryLimit: 0 },
];

export const createBoss = (connectionString: string) =>
  new PgBoss({
    connectionString,
    max: 5,
    useListenNotify: true,
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? undefined : { rejectUnauthorized: false },
  });

export const ensureQueues = async (boss: PgBoss) => {
  const existing = new Set((await boss.getQueues()).map((q) => q.name));
  for (const { name, policy, ...opts } of queues)
    // Policy is fixed at creation; other options are kept in sync on every release.
    await (existing.has(name) ? boss.updateQueue(name, opts) : boss.createQueue(name, { policy, ...opts }));
};

/** Enqueue inside the caller's transaction: the job exists iff the state change committed. */
export type Enqueue = <N extends keyof JobData>(
  trx: Tx | DB,
  name: N,
  data: JobData[N],
  opts?: { startAfter?: Date; singletonKey?: string },
) => Promise<void>;

export const createEnqueue =
  (boss: PgBoss): Enqueue =>
  async (trx, name, data, opts = {}) => {
    await boss.send(name, data, { ...opts, db: bossDb(trx) });
  };
