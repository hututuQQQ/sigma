import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  executeApplyPatchTool,
  executeGitDiffTool,
  executeGitStatusTool,
  executeGlobTool,
  executeGrepTool,
  executeListTool,
  executeTodoTool,
  type ToolExecutionContext
} from "../packages/agent-core/src/index.js";

async function workspace(): Promise<{ dir: string; context: ToolExecutionContext }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sigma-tools-"));
  return {
    dir,
    context: {
      workspacePath: dir,
      permissionMode: "yolo",
      commandTimeoutSec: 2,
      maxToolOutputChars: 4000,
      runState: { todos: [], nextTodoId: 1, changedFiles: new Set<string>() },
      alwaysAllowTools: new Set<string>()
    }
  };
}

function replacementPatch(file: string, before: string, after: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1 +1 @@",
    `-${before}`,
    `+${after}`,
    ""
  ].join("\n");
}

describe("new core workspace tools", () => {
  it("lists workspace entries deterministically while skipping ignored directories", async () => {
    const { dir, context } = await workspace();
    await mkdir(path.join(dir, "src"), { recursive: true });
    await mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(dir, "src", "a.txt"), "a", "utf8");
    await writeFile(path.join(dir, "b.txt"), "b", "utf8");
    await writeFile(path.join(dir, "node_modules", "pkg", "skip.txt"), "skip", "utf8");

    const result = await executeListTool({ path: ".", depth: 2 }, context);
    expect(result.ok).toBe(true);
    const metadata = result.metadata as { entries: Array<{ path: string }> };
    expect(metadata.entries.map((entry) => entry.path)).toEqual(["b.txt", "src", "src/a.txt"]);
  });

  it("finds files with simple glob patterns", async () => {
    const { dir, context } = await workspace();
    await mkdir(path.join(dir, "src", "nested"), { recursive: true });
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    await writeFile(path.join(dir, "src", "a.ts"), "a", "utf8");
    await writeFile(path.join(dir, "src", "nested", "b.ts"), "b", "utf8");
    await writeFile(path.join(dir, "node_modules", "skip.ts"), "skip", "utf8");

    const result = await executeGlobTool({ pattern: "src/**/*.ts" }, context);
    expect(result.ok).toBe(true);
    expect((result.metadata as { matches: string[] }).matches).toEqual(["src/a.ts", "src/nested/b.ts"]);
  });

  it("greps text files with context through the Node fallback", async () => {
    const { dir, context } = await workspace();
    await writeFile(path.join(dir, "a.txt"), "before\nNeedle here\nafter", "utf8");
    await writeFile(path.join(dir, "b.md"), "Needle elsewhere", "utf8");

    const result = await executeGrepTool(
      { pattern: "needle", path: ".", glob: "**/*.txt", caseSensitive: false, contextLines: 1 },
      context
    );
    expect(result.ok).toBe(true);
    const matches = (result.metadata as { matches: Array<{ path: string; line: number; snippet: string }> }).matches;
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ path: "a.txt", line: 2 });
    expect(matches[0].snippet).toContain("before");
    expect(matches[0].snippet).toContain("after");
  });

  it("handles git status outside a git workspace and validates git diff paths", async () => {
    const { context } = await workspace();
    const status = await executeGitStatusTool({}, context);
    expect(status.ok).toBe(true);
    expect(status.content).toContain("Not a git workspace");

    const diff = await executeGitDiffTool({ path: "../outside.txt" }, context);
    expect(diff.ok).toBe(false);
    expect(diff.content).toContain("outside the workspace");
  });

  it("checks and applies unified patches in non-git workspaces", async () => {
    const { dir, context } = await workspace();
    await writeFile(path.join(dir, "a.txt"), "old\n", "utf8");
    const patch = replacementPatch("a.txt", "old", "new");

    const check = await executeApplyPatchTool({ patch, checkOnly: true, expectedFiles: ["a.txt"] }, context);
    expect(check.ok).toBe(true);
    await expect(readFile(path.join(dir, "a.txt"), "utf8")).resolves.toBe("old\n");

    const applied = await executeApplyPatchTool({ patch, expectedFiles: ["a.txt"] }, context);
    expect(applied.ok).toBe(true);
    expect((await readFile(path.join(dir, "a.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("new\n");
    expect([...context.runState.changedFiles]).toEqual(["a.txt"]);
  });

  it("rejects unsafe, malformed, and unexpected patches", async () => {
    const { context } = await workspace();
    await expect(
      executeApplyPatchTool({ patch: replacementPatch("../outside.txt", "old", "new") }, context)
    ).resolves.toMatchObject({ ok: false });
    await expect(executeApplyPatchTool({ patch: "not a patch" }, context)).resolves.toMatchObject({ ok: false });
    await expect(
      executeApplyPatchTool({ patch: replacementPatch("a.txt", "old", "new"), expectedFiles: ["b.txt"] }, context)
    ).resolves.toMatchObject({ ok: false });
  });

  it("persists todo state across calls in one run context", async () => {
    const { context } = await workspace();
    await expect(executeTodoTool({ action: "add", text: "inspect" }, context)).resolves.toMatchObject({ ok: true });
    await expect(executeTodoTool({ action: "update", id: "1", status: "done", note: "ok" }, context)).resolves.toMatchObject({
      ok: true
    });
    const listed = await executeTodoTool({ action: "list" }, context);
    expect(listed.ok).toBe(true);
    expect((listed.metadata as { todoItems: Array<{ text: string; status: string; note?: string }> }).todoItems).toEqual([
      { id: "1", text: "inspect", status: "done", note: "ok" }
    ]);
  });
});
