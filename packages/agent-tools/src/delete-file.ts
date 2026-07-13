import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { isInside, lockWindowsDirectories } from "agent-platform";

function codedError(message: string, code: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

async function deletableTarget(
  workspacePath: string,
  requestedPath: string
): Promise<{ target: string; relativePath: string }> {
  const workspace = await realpath(path.resolve(workspacePath));
  const target = path.resolve(workspace, requestedPath);
  if (!isInside(workspace, target) || samePath(target, workspace)) {
    throw codedError(`Delete target escapes the workspace: ${requestedPath}`, "path_escape");
  }
  const relative = path.relative(workspace, target);
  const segments = relative.split(path.sep).filter(Boolean);
  if (segments.some((segment) => segment.toLowerCase() === ".git" || segment.toLowerCase() === ".agent")) {
    throw codedError(`Protected workspace metadata is read-only: ${requestedPath}`, "protected_path");
  }

  let current = workspace;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw codedError(`Delete target does not exist: ${requestedPath}`, "delete_target_missing", error);
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw codedError(`Delete targets cannot traverse a symbolic link or junction: ${requestedPath}`, "linked_path");
    }
    if (index < segments.length - 1 && !metadata.isDirectory()) {
      throw codedError(`Delete target has a non-directory path component: ${requestedPath}`, "delete_target_invalid");
    }
    if (index === segments.length - 1 && !metadata.isFile()) {
      throw codedError(`delete_file only removes regular files: ${requestedPath}`, "delete_target_not_file");
    }
  }

  const canonical = await realpath(target).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw codedError(`Delete target does not exist: ${requestedPath}`, "delete_target_missing", error);
    }
    throw error;
  });
  if (!isInside(workspace, canonical) || !samePath(canonical, target)) {
    throw codedError(`Delete target resolves through a symbolic link or junction: ${requestedPath}`, "linked_path");
  }
  return { target, relativePath: relative.split(path.sep).join("/") };
}

async function linuxAnchoredUnlink(
  workspacePath: string,
  relativePath: string,
  requestedPath: string
): Promise<void> {
  const parts = relativePath.split("/").filter(Boolean);
  const name = parts.pop();
  if (!name) throw codedError(`Delete target escapes the workspace: ${requestedPath}`, "path_escape");
  const handles: Array<Awaited<ReturnType<typeof open>>> = [];
  try {
    let current = await open(workspacePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(current);
    for (const segment of parts) {
      current = await open(
        `/proc/self/fd/${current.fd}/${segment}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      handles.push(current);
    }
    const anchoredTarget = `/proc/self/fd/${current.fd}/${name}`;
    const info = await lstat(anchoredTarget).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw codedError(`Delete target does not exist: ${requestedPath}`, "delete_target_missing", error);
      }
      throw error;
    });
    if (info.isSymbolicLink()) {
      throw codedError(`Delete target changed to a link: ${requestedPath}`, "linked_path");
    }
    if (!info.isFile()) {
      throw codedError(`delete_file only removes regular files: ${requestedPath}`, "delete_target_not_file");
    }
    await unlink(anchoredTarget);
  } finally {
    await Promise.all(handles.reverse().map(async (handle) => await handle.close().catch(() => undefined)));
  }
}

async function stableUnlink(
  workspacePath: string,
  target: string,
  relativePath: string,
  requestedPath: string
): Promise<void> {
  const workspace = await realpath(path.resolve(workspacePath));
  if (process.platform === "linux") {
    await linuxAnchoredUnlink(workspace, relativePath, requestedPath);
    return;
  }
  const parts = relativePath.split("/").filter(Boolean);
  const parentPaths = [workspace, ...parts.slice(0, -1).map((_part, index) =>
    path.join(workspace, ...parts.slice(0, index + 1)))];
  const lock = await lockWindowsDirectories(parentPaths);
  try {
    const refreshed = await deletableTarget(workspace, relativePath);
    if (!samePath(refreshed.target, target)) {
      throw codedError(`Delete target changed after approval: ${requestedPath}`, "delete_target_changed");
    }
    await unlink(refreshed.target);
  } finally {
    await lock.close();
  }
}

export async function deleteWorkspaceFile(
  workspacePath: string,
  requestedPath: string,
  signal: AbortSignal
): Promise<string> {
  const { target, relativePath } = await deletableTarget(workspacePath, requestedPath);
  signal.throwIfAborted();
  await stableUnlink(workspacePath, target, relativePath, requestedPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw codedError(`Delete target does not exist: ${requestedPath}`, "delete_target_missing", error);
    }
    throw error;
  });
  return relativePath;
}
