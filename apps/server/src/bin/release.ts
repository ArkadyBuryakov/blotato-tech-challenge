import { loadConfig } from "../config";
import { createDb, createPool } from "../db/client";
import { migrate } from "../db/migrations";
import { createBoss, ensureQueues } from "../engine/queues";

// Heroku release phase: runs once per deploy, before new dynos receive traffic.
const cfg = loadConfig();
const db = createDb(createPool(cfg.DATABASE_URL, 2));
await migrate(db);
await db.destroy();
const boss = createBoss(cfg.DATABASE_URL); // start() installs/migrates the pgboss schema
await boss.start();
await ensureQueues(boss);
await boss.stop({ graceful: false });
console.log("release: migrations applied");
