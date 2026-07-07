import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolCall } from "../packages/agent-ai/src/index.js";
import {
  createDefaultToolRegistry,
  executeRepoQueryTool,
  executeSymbolSearchTool,
  executeValidateTool,
  type ToolExecutionContext
} from "../packages/agent-core/src/index.js";

async function workspace(): Promise<{ dir: string; context: ToolExecutionContext }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sigma-context-tools-"));
  return {
    dir,
    context: {
      workspacePath: dir,
      permissionMode: "yolo",
      commandTimeoutSec: 5,
      maxToolOutputChars: 12000,
      runState: { todos: [], nextTodoId: 1, changedFiles: new Set<string>(), contextIndexes: new Map<string, unknown>() },
      alwaysAllowTools: new Set<string>()
    }
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: args } };
}

describe("repo context tools", () => {
  it("scores repo_query matches using symbols, paths, imports, and structured reasons", async () => {
    const { dir, context } = await workspace();
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(
      path.join(dir, "src", "session-manager.ts"),
      [
        "import { readFile } from 'node:fs/promises';",
        "export class SessionManager {}",
        "export function createSessionManager() { return new SessionManager(); }"
      ].join("\n"),
      "utf8"
    );
    await writeFile(path.join(dir, "src", "session-manager.test.ts"), "test('creates session manager', () => {});\n", "utf8");

    const result = await executeRepoQueryTool({ query: "createSessionManager session-manager.ts", kind: "symbol" }, context);
    expect(result.ok).toBe(true);
    const matches = result.metadata?.matches as Array<{ path: string; reasons: string[]; score: number }>;
    expect(matches[0].path).toBe("src/session-manager.ts");
    expect(matches[0].reasons).toEqual(expect.arrayContaining(["symbol:exact", "file-mention"]));
    expect(matches[0].score).toBeGreaterThan(40);
  });

  it("searches symbols directly", async () => {
    const { dir, context } = await workspace();
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "index.ts"), "export interface RunConfig {}\nexport function runAgent() {}\n", "utf8");

    const result = await executeSymbolSearchTool({ query: "RunConfig" }, context);
    expect(result.ok).toBe(true);
    const matches = result.metadata?.matches as Array<{ name: string; kind: string; path: string }>;
    expect(matches[0]).toMatchObject({ name: "RunConfig", kind: "interface", path: "src/index.ts" });
  });

  it("invalidates symbol_search cache after a same-file mutation", async () => {
    const { dir, context } = await workspace();
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "index.ts"), "export function oldName() { return 1; }\n", "utf8");

    const oldResult = await executeSymbolSearchTool({ query: "oldName" }, context);
    expect(oldResult.ok).toBe(true);
    expect((oldResult.metadata?.matches as Array<{ name: string }>)[0]).toMatchObject({ name: "oldName" });

    const registry = createDefaultToolRegistry();
    try {
      const writeResult = await registry.execute(
        toolCall("write-new-name", "write", {
          path: "src/index.ts",
          content: "export function newName() { return 2; }\n",
          createDirs: true
        }),
        context
      );
      expect(writeResult.ok).toBe(true);

      const newResult = await executeSymbolSearchTool({ query: "newName" }, context);
      expect(newResult.ok).toBe(true);
      expect((newResult.metadata?.matches as Array<{ name: string }>)[0]).toMatchObject({ name: "newName" });

      const staleResult = await executeSymbolSearchTool({ query: "oldName" }, context);
      expect(staleResult.ok).toBe(true);
      expect(staleResult.metadata?.matches).toEqual([]);
    } finally {
      await registry.close?.();
    }
  });
});

describe("validate tool", () => {
  it("runs explicit validation commands and returns structured results", async () => {
    const { context } = await workspace();
    const result = await executeValidateTool({ command: "node -e \"console.log('ok')\"", kind: "test" }, context);

    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({
      ok: true,
      command: "node -e \"console.log('ok')\"",
      exitCode: 0,
      diagnostics: []
    });
  });

  it("infers changed-file validation commands", async () => {
    const { dir, context } = await workspace();
    await writeFile(path.join(dir, "bad.js"), "function nope(\n", "utf8");
    context.runState.changedFiles.add("bad.js");

    const result = await executeValidateTool({ kind: "auto", scope: "changed", timeoutSec: 5 }, context);

    expect(result.ok).toBe(false);
    expect(result.metadata?.command).toContain("node --check bad.js");
    expect(result.metadata?.exitCode).not.toBe(0);
  });
});
