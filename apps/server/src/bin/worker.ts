import { startWorkers } from "../engine/workers";
import { createRuntime, onSignals } from "../runtime";

const rt = await createRuntime();
await startWorkers(rt.boss, rt.deps, { reconciler: rt.cfg.COMMENT_RECONCILER });
onSignals(rt.shutdown);
