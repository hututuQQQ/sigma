import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "agent-ai": path.join(rootDir, "packages/agent-ai/src/index.ts"),
      "agent-core": path.join(rootDir, "packages/agent-core/src/index.ts")
    }
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 10000
  }
});
