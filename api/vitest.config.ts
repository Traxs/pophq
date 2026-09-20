import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          // Each test file gets its own table, so files can run in parallel.
          testTimeout: 20_000,
          // Setup creates a table and seeds the demo alliance; against DynamoDB Local, with a
          // dozen suites doing it at once, that takes longer than Vitest's 10 s default.
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
