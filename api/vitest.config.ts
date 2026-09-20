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
          // sixteen suites doing it at once, that can take longer than 30 s on a busy laptop.
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
