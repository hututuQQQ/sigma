import { realpath } from "node:fs/promises";
import path from "node:path";
import { runProcess, type ProcessResult } from "./process.js";

export function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveWorkspacePath(workspace: string, requested: string): Promise<string> {
  const root = await realpath(path.resolve(workspace));
  const candidate = path.resolve(root, requested);
  if (!isInside(root, candidate)) throw new Error(`Path escapes workspace: ${requested}`);
  let ancestor = candidate;
  while (true) {
    try {
      const resolvedAncestor = await realpath(ancestor);
      if (!isInside(root, resolvedAncestor)) throw new Error(`Path resolves outside workspace through a link: ${requested}`);
      break;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  return candidate;
}

export async function gitPorcelain(workspace: string, signal: AbortSignal): Promise<ProcessResult> {
  return await runProcess({
    executable: "git",
    args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    cwd: workspace,
    timeoutMs: 30_000,
    signal
  });
}
