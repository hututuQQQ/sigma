import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  executeBashTool,
  executeEditTool,
  executeReadTool,
  executeWriteTool,
  type ToolExecutionContext
} from "../packages/agent-core/src/index.js";

async function workspace(): Promise<{ dir: string; context: ToolExecutionContext }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-core-"));
  return {
    dir,
    context: {
      workspacePath: dir,
      permissionMode: "yolo",
      commandTimeoutSec: 2,
      maxToolOutputChars: 200
    }
  };
}

describe("agent-core tools", () => {
  it("runs bash successfully", async () => {
    const { context } = await workspace();
    const result = await executeBashTool({ command: "printf hello" }, context);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("hello");
    expect(result.metadata?.exitCode).toBe(0);
  });

  it("captures bash non-zero exits", async () => {
    const { context } = await workspace();
    const result = await executeBashTool({ command: "echo nope >&2; exit 7" }, context);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("nope");
    expect(result.metadata?.exitCode).toBe(7);
  });

  it("returns a failed bash result on timeout", async () => {
    const { context } = await workspace();
    const result = await executeBashTool({ command: "sleep 2; echo late", timeoutSec: 0.1 }, context);
    expect(result.ok).toBe(false);
    expect(result.metadata?.timedOut).toBe(true);
  });

  it("truncates large bash output with head and tail", async () => {
    const { context } = await workspace();
    context.maxToolOutputChars = 80;
    const result = await executeBashTool({ command: "printf 'abcdef%.0s' {1..80}" }, context);
    expect(result.metadata?.truncated).toBe(true);
    expect(result.content).toContain("[truncated]");
  });

  it("reads a relative file", async () => {
    const { dir, context } = await workspace();
    await writeFile(path.join(dir, "note.txt"), "hello world", "utf8");
    const result = await executeReadTool({ path: "note.txt" }, context);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("hello world");
  });

  it("rejects reads outside the workspace", async () => {
    const { dir, context } = await workspace();
    const outside = path.resolve(dir, "..", "outside.txt");
    const result = await executeReadTool({ path: outside }, context);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("outside the workspace");
  });

  it("writes a file", async () => {
    const { dir, context } = await workspace();
    const result = await executeWriteTool({ path: "nested/hello.txt", content: "hello", createDirs: true }, context);
    expect(result.ok).toBe(true);
    await expect(readFile(path.join(dir, "nested", "hello.txt"), "utf8")).resolves.toBe("hello");
  });

  it("edits exact replacements", async () => {
    const { dir, context } = await workspace();
    await writeFile(path.join(dir, "edit.txt"), "one two one", "utf8");
    const result = await executeEditTool(
      { path: "edit.txt", oldString: "one", newString: "three", expectedReplacements: 2 },
      context
    );
    expect(result.ok).toBe(true);
    await expect(readFile(path.join(dir, "edit.txt"), "utf8")).resolves.toBe("three two three");
  });

  it("rejects edit expectedReplacements mismatches", async () => {
    const { dir, context } = await workspace();
    await writeFile(path.join(dir, "edit.txt"), "one two one", "utf8");
    const result = await executeEditTool(
      { path: "edit.txt", oldString: "one", newString: "three", expectedReplacements: 1 },
      context
    );
    expect(result.ok).toBe(false);
    await expect(readFile(path.join(dir, "edit.txt"), "utf8")).resolves.toBe("one two one");
  });
});
