import pino from "pino";
import { createAuth } from "./auth";
import { loadConfig, type Config } from "./config";
import { createDb, createPool } from "./db/client";
import type { EngineDeps } from "./engine/deps";
import { createBoss, createEnqueue, ensureQueues } from "./engine/queues";
import { createLiveInstagramApi, type InstagramApi } from "./instagram/client";
import { createMockInstagramApi, type MockInstagram } from "./instagram/mock";
import { createTokenStore } from "./instagram/tokens";

/** Composition root: the only place that builds concrete dependencies. */
export const createRuntime = async (cfg: Config = loadConfig(), opts: { poolSize?: number; ig?: InstagramApi; mock?: MockInstagram } = {}) => {
  const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
  const pool = createPool(cfg.DATABASE_URL, opts.poolSize ?? 8);
  const db = createDb(pool);
  const boss = createBoss(cfg.DATABASE_URL);
  boss.on("error", (e) => log.error(e, "pg-boss error"));
  await boss.start();
  await ensureQueues(boss);

  // Mock mode keeps the fake's state in memory: run web and worker in one process (bin/dev.ts).
  const mock = opts.mock ?? (cfg.INSTAGRAM_MODE === "mock" ? createMockInstagramApi((msg, data) => log.info(data, msg)) : undefined);
  const ig = opts.ig ?? mock ?? createLiveInstagramApi({ version: cfg.INSTAGRAM_GRAPH_VERSION });
  const deps: EngineDeps = {
    db,
    enqueue: createEnqueue(boss),
    ig,
    tokens: createTokenStore(db, cfg.BETTER_AUTH_SECRET),
    log,
    now: () => new Date(),
  };
  const auth = createAuth(cfg, db, ig, (m, d) => log.warn(d, m));

  const shutdown = async () => {
    await boss.stop({ graceful: true }).catch(() => undefined);
    await db.destroy();
  };
  return { cfg, log, db, boss, deps, auth, mock, shutdown };
};

export type Runtime = Awaited<ReturnType<typeof createRuntime>>;

export const onSignals = (fn: () => Promise<void>) => {
  // Heroku sends SIGTERM and allows 30s before SIGKILL.
  for (const sig of ["SIGTERM", "SIGINT"] as const)
    process.once(sig, () => void fn().finally(() => process.exit(0)));
};
