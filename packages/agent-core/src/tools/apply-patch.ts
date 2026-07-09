import path from "node:path";
import type { ToolExecutionContext, ToolResult } from "../types.js";
import { requestToolPermission, resolveWorkspacePath } from "../policy.js";
import { runCommand } from "../command-runner.js";
import { gitCommandSpec } from "./git-command.js";
import { invalidateReadFileState } from "./read.js";

interface ApplyPatchArgs {
  patch?: unknown;
  expectedFiles?: unknown;
  checkOnly?: unknown;
}

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled?: boolean;
  settledOn: string;
}

interface ParsedPathToken {
  value: string;
  rest: string;
}

const OUTPUT_TAIL_CHARS = 4000;

async function runGitApply(args: string[], patch: string, cwd: string, timeoutSec: number, abortSignal?: AbortSignal): Promise<ProcessResult> {
  const git = gitCommandSpec();
  const result = await runCommand({
    command: git.command,
    args: [...git.argsPrefix, "apply", ...args],
    cwd,
    stdin: patch,
    timeoutMs: Math.max(1, Math.floor(timeoutSec)) * 1000,
    abortSignal
  });
  return {
    exitCode: result.error ? 127 : result.exitCode,
    signal: result.signal,
    stdout: result.stdout.toString("utf8"),
    stderr: result.error ? result.error.message : result.stderr.toString("utf8"),
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    settledOn: result.settledOn
  };
}

function textTail(value: string): string {
  return value.length > OUTPUT_TAIL_CHARS ? value.slice(-OUTPUT_TAIL_CHARS) : value;
}

function timeoutMetadata(result: ProcessResult, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...extra,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    settledOn: result.settledOn,
    ...(result.stdout ? { stdoutTail: textTail(result.stdout) } : {}),
    ...(result.stderr ? { stderrTail: textTail(result.stderr) } : {})
  };
}

function timeoutContent(command: string, timeoutSec: number): string {
  return `${command} timed out after ${Math.max(1, Math.floor(timeoutSec))}s`;
}

function decodeQuotedEscape(input: string, index: number): { value: string; index: number } | null {
  const escaped = input[index];
  if (escaped === undefined) return null;
  if (/[0-7]/.test(escaped)) {
    let octal = escaped;
    let nextIndex = index;
    for (let count = 0; count < 2 && nextIndex + 1 < input.length && /[0-7]/.test(input[nextIndex + 1]); count += 1) {
      nextIndex += 1;
      octal += input[nextIndex];
    }
    return { value: String.fromCharCode(Number.parseInt(octal, 8)), index: nextIndex };
  }
  const escapes: Record<string, string> = {
    "\\": "\\",
    "\"": "\"",
    t: "\t",
    n: "\n",
    r: "\r",
    b: "\b",
    f: "\f"
  };
  return { value: escapes[escaped] ?? escaped, index };
}

function readQuotedPathToken(input: string): ParsedPathToken | null {
  if (!input.startsWith("\"")) return null;
  let value = "";
  for (let index = 1; index < input.length; index += 1) {
    const char = input[index];
    if (char === "\"") return { value, rest: input.slice(index + 1) };
    if (char !== "\\") {
      value += char;
      continue;
    }
    const decoded = decodeQuotedEscape(input, index + 1);
    if (!decoded) return null;
    value += decoded.value;
    index = decoded.index;
  }
  return null;
}

function readDiffPathToken(input: string): ParsedPathToken | null {
  const trimmed = input.trimStart();
  if (!trimmed) return null;
  if (trimmed.startsWith("\"")) return readQuotedPathToken(trimmed);
  const match = trimmed.match(/^(\S+)/);
  return match ? { value: match[1], rest: trimmed.slice(match[1].length) } : null;
}

function parseDiffGitPaths(line: string): [string, string] | null {
  const first = readDiffPathToken(line.slice("diff --git ".length));
  if (!first) return null;
  const second = readDiffPathToken(first.rest);
  if (!second || second.rest.trim().length > 0) return null;
  return [first.value, second.value];
}

function parseFileHeaderPath(line: string): string | null {
  const body = line.slice(4).trimStart();
  if (!body) return null;
  if (body.startsWith("\"")) return readQuotedPathToken(body)?.value ?? null;
  const tabIndex = body.indexOf("\t");
  return tabIndex === -1 ? body : body.slice(0, tabIndex);
}

function stripPatchPrefix(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (trimmed === "/dev/null") return null;
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) return trimmed.slice(2);
  return trimmed;
}

function normalizePatchPath(rawPath: string): string {
  const stripped = stripPatchPrefix(rawPath);
  if (!stripped) return "";
  const normalized = stripped.replace(/\\/g, "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    throw new Error(`Patch targets an invalid path: ${rawPath}`);
  }
  return path.posix.normalize(normalized);
}

function parsePatchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const paths = parseDiffGitPaths(line);
      if (!paths) throw new Error(`Malformed patch: invalid diff --git header: ${line}`);
      for (const candidate of paths) {
        const normalized = normalizePatchPath(candidate);
        if (normalized) files.add(normalized);
      }
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const rawPath = parseFileHeaderPath(line);
      if (rawPath === null) throw new Error(`Malformed patch: invalid file header: ${line}`);
      const normalized = normalizePatchPath(rawPath);
      if (normalized) files.add(normalized);
    }
  }
  return [...files].sort((a, b) => a.localeCompare(b, "en"));
}

function normalizeExpectedFiles(expectedFiles: unknown, workspacePath: string): string[] | null {
  if (expectedFiles === undefined) return null;
  if (!Array.isArray(expectedFiles)) throw new Error("expectedFiles must be an array of strings");
  const normalized = new Set<string>();
  for (const file of expectedFiles) {
    if (typeof file !== "string" || file.length === 0) throw new Error("expectedFiles must be an array of strings");
    const relative = normalizePatchPath(file);
    resolveWorkspacePath(workspacePath, relative);
    normalized.add(relative);
  }
  return [...normalized].sort((a, b) => a.localeCompare(b, "en"));
}

function sameFiles(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseNumstat(stdout: string): Array<{ path: string; added: number | null; removed: number | null }> {
  const stats: Array<{ path: string; added: number | null; removed: number | null }> = [];
  for (const line of stdout.trim().split(/\r?\n/)) {
    if (!line) continue;
    const [addedRaw, removedRaw, ...pathParts] = line.split(/\t/);
    stats.push({
      path: pathParts.join("\t"),
      added: addedRaw === "-" ? null : Number(addedRaw),
      removed: removedRaw === "-" ? null : Number(removedRaw)
    });
  }
  return stats;
}

export async function executeApplyPatchTool(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  const parsed = (args && typeof args === "object" ? args : {}) as ApplyPatchArgs;
  if (typeof parsed.patch !== "string" || parsed.patch.trim().length === 0) {
    return { ok: false, content: "apply_patch requires a non-empty patch string" };
  }

  let changedFiles: string[];
  let expectedFiles: string[] | null;
  try {
    changedFiles = parsePatchFiles(parsed.patch);
    expectedFiles = normalizeExpectedFiles(parsed.expectedFiles, context.workspacePath);
    for (const file of changedFiles) {
      resolveWorkspacePath(context.workspacePath, file);
    }
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }

  if (changedFiles.length === 0) {
    return { ok: false, content: "Malformed patch: no target files were found" };
  }
  if (expectedFiles && !sameFiles(changedFiles, expectedFiles)) {
    return {
      ok: false,
      content: `Patch target mismatch. expectedFiles=${JSON.stringify(expectedFiles)} actual=${JSON.stringify(changedFiles)}`,
      metadata: { changedFiles, expectedFiles }
    };
  }

  const timeoutSec = Math.max(1, Math.floor(context.commandTimeoutSec));
  const check = await runGitApply(["--check", "--whitespace=nowarn"], parsed.patch, context.workspacePath, timeoutSec, context.abortSignal);
  if (check.timedOut || check.cancelled) {
    return {
      ok: false,
      content: check.cancelled ? "git apply --check cancelled" : timeoutContent("git apply --check", timeoutSec),
      metadata: timeoutMetadata(check, { changedFiles, checkOnly: parsed.checkOnly === true })
    };
  }
  if (check.exitCode !== 0) {
    return {
      ok: false,
      content: check.stderr.trim() || check.stdout.trim() || `git apply --check exited with ${check.exitCode}`,
      metadata: { changedFiles, checkOnly: parsed.checkOnly === true }
    };
  }

  const numstat = await runGitApply(["--numstat"], parsed.patch, context.workspacePath, timeoutSec, context.abortSignal);
  if (numstat.timedOut || numstat.cancelled) {
    return {
      ok: false,
      content: numstat.cancelled ? "git apply --numstat cancelled" : timeoutContent("git apply --numstat", timeoutSec),
      metadata: timeoutMetadata(numstat, { changedFiles, checkOnly: parsed.checkOnly === true })
    };
  }
  const stats = numstat.exitCode === 0 ? parseNumstat(numstat.stdout) : [];

  if (parsed.checkOnly === true) {
    return {
      ok: true,
      content: `Patch is valid for ${changedFiles.join(", ")}`,
      metadata: { changedFiles, stats, checkOnly: true }
    };
  }

  const denied = await requestToolPermission(context, {
    toolName: "apply_patch",
    arguments: { ...parsed, patch: `[${Buffer.byteLength(parsed.patch, "utf8")} bytes]` },
    risk: "write",
    reason: `Apply patch to ${changedFiles.join(", ")}`
  });
  if (denied) return denied;

  const applied = await runGitApply(["--whitespace=nowarn"], parsed.patch, context.workspacePath, timeoutSec, context.abortSignal);
  if (applied.timedOut || applied.cancelled) {
    return {
      ok: false,
      content: applied.cancelled ? "git apply cancelled" : timeoutContent("git apply", timeoutSec),
      metadata: timeoutMetadata(applied, { changedFiles, stats })
    };
  }
  if (applied.exitCode !== 0) {
    return {
      ok: false,
      content: applied.stderr.trim() || applied.stdout.trim() || `git apply exited with ${applied.exitCode}`,
      metadata: { changedFiles, stats }
    };
  }

  for (const file of changedFiles) {
    context.runState.changedFiles.add(file);
    invalidateReadFileState(context, file);
  }
  return {
    ok: true,
    content: `Applied patch to ${changedFiles.join(", ")}`,
    metadata: { changedFiles, stats, checkOnly: false }
  };
}
