import path from "node:path";
import type { ToolExecutionContext, ToolResult } from "../types.js";
import { truncateMiddle } from "../compaction.js";
import { resolveWorkspacePath, workspaceRelativePath } from "../policy.js";
import { runCommand } from "../command-runner.js";
import { gitCommandSpec } from "./git-command.js";

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
  signal: NodeJS.Signals | string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  settledOn: string;
}

function numberOrDefault(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

async function runGit(args: string[], cwd: string, timeoutSec: number): Promise<GitResult> {
  const git = gitCommandSpec();
  const result = await runCommand({
    command: git.command,
    args: [...git.argsPrefix, ...args],
    cwd,
    timeoutMs: Math.max(1, Math.floor(timeoutSec)) * 1000
  });
  return {
    exitCode: result.error ? 127 : result.exitCode,
    signal: result.signal,
    stdout: result.stdout.toString("utf8"),
    stderr: result.error ? result.error.message : result.stderr.toString("utf8"),
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    settledOn: result.settledOn
  };
}

function timeoutResult(tool: "git_status" | "git_diff", result: GitResult, timeoutSec: number): ToolResult {
  return {
    ok: false,
    content: `${tool} timed out after ${Math.max(1, Math.floor(timeoutSec))}s`,
    metadata: {
      exitCode: result.exitCode,
      timedOut: true,
      signal: result.signal,
      durationMs: result.durationMs,
      settledOn: result.settledOn
    }
  };
}

function isNotGitWorkspace(result: GitResult): boolean {
  return !result.timedOut && result.exitCode !== 0 && /not a git repository|not a git command|No such file/i.test(result.stderr);
}

export async function executeGitStatusTool(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  const parsed = (args && typeof args === "object" ? args : {}) as GitStatusArgs;
  const porcelain = parsed.porcelain !== false;
  const maxOutputChars = numberOrDefault(parsed.maxOutputChars, context.maxToolOutputChars, 1, 200000);
  const gitArgs = porcelain ? ["status", "--short", "--branch"] : ["status"];
  const timeoutSec = Math.max(1, Math.floor(context.commandTimeoutSec));
  const result = await runGit(gitArgs, context.workspacePath, timeoutSec);
  if (result.timedOut) return timeoutResult("git_status", result, timeoutSec);
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

  const timeoutSec = Math.max(1, Math.floor(context.commandTimeoutSec));
  const result = await runGit(gitArgs, context.workspacePath, timeoutSec);
  if (result.timedOut) return timeoutResult("git_diff", result, timeoutSec);
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
