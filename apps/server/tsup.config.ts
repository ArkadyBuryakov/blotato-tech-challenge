import { defineConfig } from "tsup";

export default defineConfig({
  entry: { web: "src/bin/web.ts", worker: "src/bin/worker.ts", release: "src/bin/release.ts" },
  format: "esm",
  platform: "node",
  target: "node24",
  // Bundle the workspace package (TS sources); keep npm dependencies external.
  noExternal: ["@app/core"],
  sourcemap: true,
  clean: true,
});
