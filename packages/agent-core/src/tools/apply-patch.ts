import { spawn } from "node:child_process";
import path from "node:path";
import type { ToolExecutionContext, ToolResult } from "../types.js";
import { requestToolPermission, resolveWorkspacePath } from "../policy.js";

interface ApplyPatchArgs {
  patch?: unknown;
  expectedFiles?: unknown;
  checkOnly?: unknown;
}

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runGitApply(args: string[], patch: string, cwd: string): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn("git", ["apply", ...args], { cwd, windowsHide: true });
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
    child.stdin.end(patch);
  });
}

function stripPatchPrefix(rawPath: string): string | null {
  const trimmed = rawPath.trim().replace(/^"|"$/g, "");
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
      const parts = line.split(/\s+/);
      for (const candidate of parts.slice(2, 4)) {
        const normalized = normalizePatchPath(candidate);
        if (normalized) files.add(normalized);
      }
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const rawPath = line.slice(4).split(/\t/)[0];
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

  const check = await runGitApply(["--check", "--whitespace=nowarn"], parsed.patch, context.workspacePath);
  if (check.exitCode !== 0) {
    return {
      ok: false,
      content: check.stderr.trim() || check.stdout.trim() || `git apply --check exited with ${check.exitCode}`,
      metadata: { changedFiles, checkOnly: parsed.checkOnly === true }
    };
  }

  const numstat = await runGitApply(["--numstat"], parsed.patch, context.workspacePath);
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

  const applied = await runGitApply(["--whitespace=nowarn"], parsed.patch, context.workspacePath);
  if (applied.exitCode !== 0) {
    return {
      ok: false,
      content: applied.stderr.trim() || applied.stdout.trim() || `git apply exited with ${applied.exitCode}`,
      metadata: { changedFiles, stats }
    };
  }

  for (const file of changedFiles) {
    context.runState.changedFiles.add(file);
  }
  return {
    ok: true,
    content: `Applied patch to ${changedFiles.join(", ")}`,
    metadata: { changedFiles, stats, checkOnly: false }
  };
}

