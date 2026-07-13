import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/agent-protocol.test.ts",
      "tests/agent-protocol.property.test.ts",
      "tests/agent-protocol.enum-contract.test.ts",
      "tests/agent-protocol.validation-boundaries.test.ts",
      "tests/agent-store.validation-boundaries.test.ts",
    ],
    maxWorkers: 1,
    testTimeout: 10_000,
  },
});
