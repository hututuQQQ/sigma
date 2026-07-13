import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Several suites exercise real subprocess, broker, LSP, and filesystem timing.
    // Bounding file-level concurrency keeps their protocol deadlines meaningful
    // on high-core CI hosts instead of starving the child processes under test.
    maxWorkers: 4,
    testTimeout: 10000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.{ts,tsx}"],
      reporter: ["text-summary", "json-summary", "json"],
      thresholds: {
        statements: 80,
        lines: 80,
        functions: 80,
        branches: 80,
        "packages/agent-kernel/src/**": { branches: 90 },
        "packages/agent-protocol/src/**": { branches: 90 },
        "packages/agent-store/src/**": { branches: 90 },
        "packages/agent-kernel/src/durable-reducers.ts": { branches: 95 },
        "packages/agent-kernel/src/rehydrate.ts": { branches: 95 },
        "packages/agent-protocol/src/domain-validation.ts": { branches: 95 },
        "packages/agent-execution/src/framing.ts": { branches: 95 },
        "packages/agent-execution/src/protocol.ts": { branches: 95 },
        "packages/agent-execution/src/values.ts": { branches: 95 },
        "packages/agent-execution/src/environment.ts": { branches: 95 },
        "packages/agent-execution/src/redaction.ts": { branches: 95 }
      }
    }
  }
});
