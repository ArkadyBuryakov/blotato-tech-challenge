import { loadConfig } from "../config";
import { createDb, createPool } from "../db/client";
import { migrate } from "../db/migrations";
import { startWorkers } from "../engine/workers";
import { buildApp } from "../http/app";
import { createRuntime, onSignals } from "../runtime";

// Local development: migrations + web + worker in one process.
// Migrate before creating the runtime: BetterAuth checks the schema once at initialization.
const cfg = loadConfig();
const migrationDb = createDb(createPool(cfg.DATABASE_URL, 1));
await migrate(migrationDb);
await migrationDb.destroy();

const rt = await createRuntime(cfg);
await startWorkers(rt.boss, rt.deps, { reconciler: cfg.COMMENT_RECONCILER });
const app = await buildApp(cfg, rt.auth, rt.deps, rt.mock);
await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
onSignals(async () => {
  await app.close();
  await rt.shutdown();
});
