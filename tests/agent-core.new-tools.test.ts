import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeShellSessions,
  executeApplyPatchTool,
  executeGitDiffTool,
  executeGitStatusTool,
  executeGlobTool,
  executeGrepTool,
  executeListTool,
  executeRepoQueryTool,
  executeShellSessionTool,
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

function quotedReplacementPatch(file: string, before: string, after: string): string {
  return [
    `diff --git "a/${file}" "b/${file}"`,
    `--- "a/${file}"`,
    `+++ "b/${file}"`,
    "@@ -1 +1 @@",
    `-${before}`,
    `+${after}`,
    ""
  ].join("\n");
}

async function installStallingGitOverride(dir: string): Promise<() => void> {
  const fakeBin = path.join(dir, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  const stallScript = path.join(fakeBin, "stall-git.mjs");
  await writeFile(
    stallScript,
    "process.stdout.write('fake git stdout\\n'); process.stderr.write('fake git stderr\\n'); setInterval(() => {}, 1000);\n",
    "utf8"
  );

  const originalGitPath = process.env.AGENT_GIT_PATH;
  const originalGitArgs = process.env.AGENT_GIT_ARGS;
  process.env.AGENT_GIT_PATH = process.execPath;
  process.env.AGENT_GIT_ARGS = JSON.stringify([stallScript]);
  return () => {
    if (originalGitPath === undefined) {
      delete process.env.AGENT_GIT_PATH;
    } else {
      process.env.AGENT_GIT_PATH = originalGitPath;
    }
    if (originalGitArgs === undefined) {
      delete process.env.AGENT_GIT_ARGS;
    } else {
      process.env.AGENT_GIT_ARGS = originalGitArgs;
    }
  };
}

describe("new core workspace tools", () => {
  afterEach(async () => {
    await closeShellSessions();
  });

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

  it("applies quoted patches for files with spaces in their path", async () => {
    const { dir, context } = await workspace();
    await writeFile(path.join(dir, "foo bar.txt"), "old\n", "utf8");
    const patch = quotedReplacementPatch("foo bar.txt", "old", "new");

    const applied = await executeApplyPatchTool({ patch, expectedFiles: ["foo bar.txt"] }, context);
    expect(applied.ok).toBe(true);
    expect((await readFile(path.join(dir, "foo bar.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("new\n");
    expect((applied.metadata as { changedFiles: string[] }).changedFiles).toEqual(["foo bar.txt"]);
  });

  it("validates quoted paths in check-only mode", async () => {
    const { dir, context } = await workspace();
    await writeFile(path.join(dir, "quoted path.txt"), "old\n", "utf8");
    const patch = quotedReplacementPatch("quoted path.txt", "old", "new");

    const check = await executeApplyPatchTool({ patch, checkOnly: true, expectedFiles: ["quoted path.txt"] }, context);
    expect(check.ok).toBe(true);
    expect((await readFile(path.join(dir, "quoted path.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("old\n");
    expect((check.metadata as { changedFiles: string[]; checkOnly: boolean }).changedFiles).toEqual(["quoted path.txt"]);
  });

  it("rejects quoted traversal paths and malformed diff headers", async () => {
    const { context } = await workspace();
    await expect(
      executeApplyPatchTool({ patch: quotedReplacementPatch("../outside.txt", "old", "new") }, context)
    ).resolves.toMatchObject({ ok: false });
    await expect(
      executeApplyPatchTool({ patch: "diff --git \"a/missing-second.txt\"\n--- a/missing-second.txt\n" }, context)
    ).resolves.toMatchObject({ ok: false });
  });

  it("times out stalled git apply subprocesses", async () => {
    const { dir, context } = await workspace();
    context.commandTimeoutSec = 1;
    await writeFile(path.join(dir, "a.txt"), "old\n", "utf8");
    const restorePath = await installStallingGitOverride(dir);
    try {
      const result = await executeApplyPatchTool({ patch: replacementPatch("a.txt", "old", "new") }, context);
      expect(result.ok).toBe(false);
      expect(result.content).toContain("timed out");
      expect(result.metadata).toMatchObject({ timedOut: true, changedFiles: ["a.txt"] });
      expect(result.metadata?.stdoutTail).toContain("fake git stdout");
      expect(result.metadata?.stderrTail).toContain("fake git stderr");
    } finally {
      restorePath();
    }
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

  it("repo_query finds symbols", async () => {
    const { dir, context } = await workspace();
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "math.ts"), "export function addNumbers(a: number, b: number) {\n  return a + b;\n}\n", "utf8");

    const result = await executeRepoQueryTool({ query: "addNumbers", kind: "symbol" }, context);

    expect(result.ok).toBe(true);
    const matches = (result.metadata as { matches: Array<{ path: string; lineStart: number }> }).matches;
    expect(matches[0]).toMatchObject({ path: "src/math.ts", lineStart: 1 });
  });

  it("repo_query finds config files and respects workspace boundaries", async () => {
    const { dir, context } = await workspace();
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");

    const config = await executeRepoQueryTool({ query: "scripts test", kind: "config" }, context);
    expect(config.ok).toBe(true);
    expect((config.metadata as { matches: Array<{ path: string }> }).matches[0].path).toBe("package.json");

    const outside = await executeRepoQueryTool({ query: "anything", path: "../outside" }, context);
    expect(outside.ok).toBe(false);
    expect(outside.content).toContain("outside the workspace");
  });

  it("repo_query respects max snippets and chars", async () => {
    const { dir, context } = await workspace();
    await writeFile(path.join(dir, "a.txt"), "needle one\nneedle two\nneedle three\n", "utf8");

    const result = await executeRepoQueryTool({ query: "needle", maxSnippets: 1, maxChars: 500 }, context);

    expect(result.ok).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(500);
    expect((result.metadata as { matches: unknown[] }).matches).toHaveLength(1);
  });

  it("shell_session start/send/read echoes output", async () => {
    const { context } = await workspace();
    const start = await executeShellSessionTool({ action: "start", sessionId: "echo-test" }, context);
    expect(start.ok).toBe(true);

    const sent = await executeShellSessionTool({ action: "send", sessionId: "echo-test", input: "printf hello" }, context);
    expect(sent.ok).toBe(true);
    expect(sent.content).toContain("hello");

    const read = await executeShellSessionTool({ action: "read", sessionId: "echo-test" }, context);
    expect(read.ok).toBe(true);
  });

  it("shell_session persists cwd across commands and stops cleanly", async () => {
    const { dir, context } = await workspace();
    await mkdir(path.join(dir, "nested"), { recursive: true });
    await expect(executeShellSessionTool({ action: "start", sessionId: "cwd-test" }, context)).resolves.toMatchObject({
      ok: true
    });

    await expect(executeShellSessionTool({ action: "send", sessionId: "cwd-test", input: "cd nested" }, context)).resolves.toMatchObject({
      ok: true
    });
    const pwd = await executeShellSessionTool({ action: "send", sessionId: "cwd-test", input: "basename \"$PWD\"" }, context);
    expect(pwd.ok).toBe(true);
    expect(pwd.content).toContain("nested");

    await expect(executeShellSessionTool({ action: "stop", sessionId: "cwd-test" }, context)).resolves.toMatchObject({
      ok: true
    });
    const listed = await executeShellSessionTool({ action: "list" }, context);
    expect((listed.metadata as { sessionIds: string[] }).sessionIds).not.toContain("cwd-test");
  });

  it("shell_session send timeout does not hang and output truncates", async () => {
    const { context } = await workspace();
    await expect(executeShellSessionTool({ action: "start", sessionId: "timeout-test" }, context)).resolves.toMatchObject({
      ok: true
    });

    const timeout = await executeShellSessionTool(
      { action: "send", sessionId: "timeout-test", input: "sleep 2", timeoutSec: 1 },
      context
    );
    expect(timeout.ok).toBe(false);
    expect(timeout.metadata?.timedOut).toBe(true);

    const truncated = await executeShellSessionTool(
      { action: "send", sessionId: "timeout-test", input: "printf 'abcdef%.0s' {1..80}", maxOutputChars: 200 },
      context
    );
    expect(truncated.content.length).toBeLessThanOrEqual(200);
  });
});
