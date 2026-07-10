import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { runProcess, type ProcessResult } from "./process.js";

export function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function canonicalWorkspacePath(workspace: string, requested: string): Promise<string> {
  const root = await realpath(path.resolve(workspace));
  const candidate = path.resolve(root, requested);
  if (!isInside(root, candidate)) throw new Error(`Path escapes workspace: ${requested}`);
  let ancestor = candidate;
  while (true) {
    try {
      const resolvedAncestor = await realpath(ancestor);
      const canonical = path.resolve(resolvedAncestor, path.relative(ancestor, candidate));
      if (!isInside(root, canonical)) throw new Error(`Path resolves outside workspace through a link: ${requested}`);
      return canonical;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

export async function resolveWorkspacePath(workspace: string, requested: string): Promise<string> {
  return await canonicalWorkspacePath(workspace, requested);
}

export async function selfContainedGitRoot(workspace: string, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  const root = await realpath(path.resolve(workspace));
  const marker = await lstat(path.join(root, ".git")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!marker || marker.isSymbolicLink()) return null;
  const processSignal = signal ?? new AbortController().signal;
  const result = await runProcess({
    executable: "git", args: ["rev-parse", "--show-toplevel"], cwd: root,
    timeoutMs: 10_000, maxOutputBytes: 16_384, signal: processSignal
  }).catch(() => {
    processSignal.throwIfAborted();
    return null;
  });
  processSignal.throwIfAborted();
  if (!result || result.exitCode !== 0) return null;
  const reported = result.stdout.trim();
  if (!reported) return null;
  const canonical = await realpath(path.resolve(root, reported)).catch(() => path.resolve(root, reported));
  return path.relative(root, canonical) === "" ? root : null;
}

export async function gitPorcelain(workspace: string, signal: AbortSignal): Promise<ProcessResult> {
  const root = await selfContainedGitRoot(workspace, signal);
  if (!root) return {
    exitCode: 128,
    stdout: "",
    stderr: "Workspace is not a self-contained Git repository.",
    timedOut: false,
    cancelled: false,
    durationMs: 0,
    stdoutLimitReached: false,
    outputTruncated: false
  };
  return await runProcess({
    executable: "git",
    args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    cwd: root,
    timeoutMs: 30_000,
    signal
  });
}
