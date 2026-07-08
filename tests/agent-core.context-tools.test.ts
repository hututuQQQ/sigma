import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolCall } from "../packages/agent-ai/src/index.js";
import {
  createDefaultToolRegistry,
  executeReadManyTool,
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

  it("honors .gitignore and .agentignore across repo query and symbol search", async () => {
    const { dir, context } = await workspace();
    await mkdir(path.join(dir, "src"), { recursive: true });
    await mkdir(path.join(dir, "scratch"), { recursive: true });
    await mkdir(path.join(dir, "local"), { recursive: true });
    await writeFile(path.join(dir, ".gitignore"), "scratch/\n", "utf8");
    await writeFile(path.join(dir, ".agentignore"), "local/\n", "utf8");
    await writeFile(path.join(dir, "src", "visible.ts"), "export function visibleSymbol() { return 1; }\n", "utf8");
    await writeFile(path.join(dir, "scratch", "ignored.ts"), "export function ignoredByGitignore() { return 1; }\n", "utf8");
    await writeFile(path.join(dir, "local", "ignored.ts"), "export function ignoredByAgentignore() { return 1; }\n", "utf8");

    const query = await executeRepoQueryTool({ query: "ignoredByGitignore ignoredByAgentignore visibleSymbol" }, context);
    expect(query.ok).toBe(true);
    const queryPaths = (query.metadata?.matches as Array<{ path: string }>).map((match) => match.path);
    expect(queryPaths).toContain("src/visible.ts");
    expect(queryPaths).not.toContain("scratch/ignored.ts");
    expect(queryPaths).not.toContain("local/ignored.ts");

    const ignoredSymbol = await executeSymbolSearchTool({ query: "ignoredByGitignore" }, context);
    expect(ignoredSymbol.ok).toBe(true);
    expect(ignoredSymbol.metadata?.matches).toEqual([]);
  });

  it("reads many workspace snippets and rejects escaped paths", async () => {
    const { dir, context } = await workspace();
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "a.ts"), "alpha\n", "utf8");
    await writeFile(path.join(dir, "src", "b.ts"), "bravo\n", "utf8");

    const result = await executeReadManyTool({ files: ["src/a.ts", { path: "src/b.ts", limit: 3 }] }, context);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("--- src/a.ts ---");
    expect(result.content).toContain("alpha");
    expect(result.content).toContain("--- src/b.ts ---");
    expect(result.content).toContain("bra");

    const escaped = await executeReadManyTool({ files: ["../outside.txt"] }, context);
    expect(escaped.ok).toBe(false);
    expect(escaped.content).toContain("outside the workspace");
  });

  it("invalidates symbol_search cache after edit, apply_patch, and bash mutations", async () => {
    const { dir, context } = await workspace();
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "index.ts"), "export function beforeEdit() { return 1; }\n", "utf8");
    const registry = createDefaultToolRegistry();
    try {
      await expect(executeSymbolSearchTool({ query: "beforeEdit" }, context)).resolves.toMatchObject({ ok: true });
      await registry.execute(
        toolCall("edit-symbol", "edit", {
          path: "src/index.ts",
          oldString: "beforeEdit",
          newString: "afterEdit",
          expectedReplacements: 1
        }),
        context
      );
      const afterEdit = await executeSymbolSearchTool({ query: "afterEdit" }, context);
      expect((afterEdit.metadata?.matches as Array<{ name: string }>)[0]).toMatchObject({ name: "afterEdit" });

      await registry.execute(
        toolCall("patch-symbol", "apply_patch", {
          patch: [
            "diff --git a/src/index.ts b/src/index.ts",
            "--- a/src/index.ts",
            "+++ b/src/index.ts",
            "@@ -1 +1 @@",
            "-export function afterEdit() { return 1; }",
            "+export function afterPatch() { return 2; }",
            ""
          ].join("\n")
        }),
        context
      );
      const afterPatch = await executeSymbolSearchTool({ query: "afterPatch" }, context);
      expect((afterPatch.metadata?.matches as Array<{ name: string }>)[0]).toMatchObject({ name: "afterPatch" });

      await registry.execute(
        toolCall("bash-symbol", "bash", {
          command: "printf 'export function afterBash() { return 3; }\\n' > src/index.ts"
        }),
        context
      );
      const afterBash = await executeSymbolSearchTool({ query: "afterBash" }, context);
      expect((afterBash.metadata?.matches as Array<{ name: string }>)[0]).toMatchObject({ name: "afterBash" });
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
