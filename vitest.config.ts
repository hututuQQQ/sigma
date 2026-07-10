import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
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
        "packages/agent-store/src/**": { branches: 90 }
      }
    }
  }
});
