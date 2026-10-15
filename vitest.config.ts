import { defineConfig } from "vitest/config";

// One test run for the whole monorepo: a single report, each file tagged with its project.
export default defineConfig({
  test: {
    projects: [
      { test: { name: "core", root: "packages/core" } },
      { test: { name: "server", root: "apps/server", testTimeout: 30_000, hookTimeout: 30_000 } },
    ],
  },
});
