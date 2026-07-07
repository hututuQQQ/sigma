import { spawn } from "node:child_process";
import path from "node:path";
import type { ToolExecutionContext, ToolResult } from "../types.js";
import { truncateMiddle } from "../compaction.js";
import { resolveWorkspacePath, workspaceRelativePath } from "../policy.js";

interface GitStatusArgs {
  porcelain?: unknown;
  maxOutputChars?: unknown;
}

interface GitDiffArgs {
  path?: unknown;
  staged?: unknown;
  maxOutputChars?: unknown;
}

interface GitResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function numberOrDefault(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({ exitCode: 127, stdout, stderr: error.message });
    });
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function isNotGitWorkspace(result: GitResult): boolean {
  return result.exitCode !== 0 && /not a git repository|not a git command|No such file/i.test(result.stderr);
}

export async function executeGitStatusTool(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  const parsed = (args && typeof args === "object" ? args : {}) as GitStatusArgs;
  const porcelain = parsed.porcelain !== false;
  const maxOutputChars = numberOrDefault(parsed.maxOutputChars, context.maxToolOutputChars, 1, 200000);
  const gitArgs = porcelain ? ["status", "--short", "--branch"] : ["status"];
  const result = await runGit(gitArgs, context.workspacePath);
  if (isNotGitWorkspace(result)) {
    return { ok: true, content: "Not a git workspace.", metadata: { git: false } };
  }
  const content = result.stdout.trimEnd() || result.stderr.trimEnd() || "Clean working tree.";
  const truncated = truncateMiddle(content, maxOutputChars);
  return {
    ok: result.exitCode === 0,
    content: truncated.text,
    metadata: { exitCode: result.exitCode, truncated: truncated.truncated, porcelain }
  };
}

export async function executeGitDiffTool(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  const parsed = (args && typeof args === "object" ? args : {}) as GitDiffArgs;
  const maxOutputChars = numberOrDefault(parsed.maxOutputChars, context.maxToolOutputChars, 1, 500000);
  const gitArgs = ["diff"];
  if (parsed.staged === true) gitArgs.push("--staged");

  let relativePath: string | undefined;
  if (typeof parsed.path === "string" && parsed.path.length > 0) {
    try {
      const absolutePath = resolveWorkspacePath(context.workspacePath, parsed.path);
      relativePath = workspaceRelativePath(context.workspacePath, absolutePath);
      gitArgs.push("--", relativePath.split(path.sep).join("/"));
    } catch (error) {
      return { ok: false, content: error instanceof Error ? error.message : String(error) };
    }
  }

  const result = await runGit(gitArgs, context.workspacePath);
  if (isNotGitWorkspace(result)) {
    return { ok: true, content: "Not a git workspace.", metadata: { git: false } };
  }
  const content = result.stdout.trimEnd() || (result.exitCode === 0 ? "No diff." : result.stderr.trimEnd());
  const truncated = truncateMiddle(content, maxOutputChars);
  return {
    ok: result.exitCode === 0,
    content: truncated.text,
    metadata: {
      exitCode: result.exitCode,
      truncated: truncated.truncated,
      staged: parsed.staged === true,
      ...(relativePath ? { path: relativePath } : {})
    }
  };
}

