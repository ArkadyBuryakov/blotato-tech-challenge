import { buildApp } from "../http/app";
import { createRuntime, onSignals } from "../runtime";

const rt = await createRuntime();
const app = await buildApp(rt.cfg, rt.auth, rt.deps, rt.mock);
await app.listen({ port: rt.cfg.PORT, host: "0.0.0.0" });
onSignals(async () => {
  await app.close();
  await rt.shutdown();
});
