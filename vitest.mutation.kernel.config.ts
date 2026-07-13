import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/agent-kernel.coverage.test.ts",
      "tests/agent-kernel.durable-reducer-contract.test.ts",
      "tests/agent-kernel.semantic-failure.test.ts",
    ],
    maxWorkers: 1,
    testTimeout: 10_000,
  },
});
