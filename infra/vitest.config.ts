import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Synthesizing stacks bundles the API with esbuild.
    testTimeout: 60_000,
  },
});
