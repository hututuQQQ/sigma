import { lstat } from "node:fs/promises";
import path from "node:path";
import { isInside, resolveWorkspacePath } from "agent-platform";
import {
  safeAutomaticDirectoryPath,
  safeAutomaticFilePath
} from "./repository-path-safety.js";

function pathIdentity(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function normalizedSafeRepositoryPath(
  workspace: string,
  requested: string,
  operation: "list" | "search",
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted();
  const root = await resolveWorkspacePath(workspace, ".");
  const lexicalTarget = path.resolve(root, requested || ".");
  if (!isInside(root, lexicalTarget)) {
    throw new Error(`Repository ${operation} path escapes workspace: ${requested}`);
  }
  const target = await resolveWorkspacePath(root, requested || ".");
  if (!isInside(root, target)) {
    throw new Error(`Repository ${operation} path escapes workspace: ${requested}`);
  }
  if (pathIdentity(lexicalTarget) !== pathIdentity(target)) {
    throw new Error(`Repository ${operation} path is not an allowed file or directory: ${requested}`);
  }
  const state = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      throw new Error(`Repository ${operation} path does not exist: ${requested}`, { cause: error });
    }
    throw error;
  });
  const relative = path.relative(root, target).split(path.sep).join("/") || ".";
  const allowed = state.isDirectory()
    ? safeAutomaticDirectoryPath(relative)
    : state.isFile() && safeAutomaticFilePath(relative);
  if (!allowed || state.isSymbolicLink()) {
    throw new Error(`Repository ${operation} path is not an allowed file or directory: ${requested}`);
  }
  signal.throwIfAborted();
  return relative;
}
