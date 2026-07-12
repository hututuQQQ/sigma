import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { lockWindowsDirectories } from "agent-platform";
import { CheckpointConflictError } from "./types.js";

export interface NormalizedCheckpointScopes {
  workspacePath: string;
  scopePaths: string[];
}

interface PathIdentity {
  dev: number;
  ino: number;
  mode: number;
  birthtimeMs: number;
}

export interface PinnedCheckpointParent {
  parentPath: string;
  targetPath: string;
  verify(): Promise<void>;
  close(): Promise<void>;
}

export function safeCheckpointId(value: string, label: string): string {
  if (!value || value === "." || value === ".." || value.length > 128 || !/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  return value;
}

function portable(value: string): string {
  const normalized = value.split(path.sep).join("/");
  return normalized === "" ? "." : normalized;
}

export async function assertSafeCheckpointParents(workspacePath: string, relative: string): Promise<void> {
  const parts = relative === "." ? [] : relative.split("/");
  let current = workspacePath;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return;
    const final = index === parts.length - 1;
    if (info.isSymbolicLink() && !final) {
      throw new CheckpointConflictError(`Checkpoint scope has a linked parent outside its stable path: ${relative}`);
    }
    if (!final && !info.isDirectory()) {
      throw new CheckpointConflictError(`Checkpoint scope parent is not a directory: ${relative}`);
    }
  }
}

function identity(info: Awaited<ReturnType<typeof lstat>>): PathIdentity {
  return {
    dev: Number(info.dev),
    ino: Number(info.ino),
    mode: Number(info.mode),
    birthtimeMs: Number(info.birthtimeMs)
  };
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.birthtimeMs === right.birthtimeMs;
}

async function stableDirectory(target: string): Promise<PathIdentity> {
  const info = await lstat(target).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) {
    throw new CheckpointConflictError(`Checkpoint parent is not a stable directory: ${target}`);
  }
  return identity(info);
}

async function verifyIdentities(paths: string[], identities: PathIdentity[]): Promise<void> {
  for (const [index, target] of paths.entries()) {
    const actual = await stableDirectory(target);
    if (!sameIdentity(actual, identities[index]!)) {
      throw new CheckpointConflictError(`Checkpoint parent changed during restore: ${target}`);
    }
  }
}

async function pinLinuxParents(workspacePath: string, parts: string[]): Promise<PinnedCheckpointParent> {
  const handles: FileHandle[] = [];
  const paths: string[] = [];
  const identities: PathIdentity[] = [];
  const parentParts = parts.slice(0, -1);
  let anchored = workspacePath;
  try {
    for (let index = 0; index <= parentParts.length; index += 1) {
      const original = index === 0 ? workspacePath : path.join(workspacePath, ...parentParts.slice(0, index));
      const candidate = index === 0 ? workspacePath : path.join(anchored, parentParts[index - 1]!);
      const expected = await stableDirectory(original);
      const handle = await open(candidate, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const held = identity(await handle.stat());
      if (!sameIdentity(expected, held)) {
        await handle.close();
        throw new CheckpointConflictError(`Checkpoint parent changed while being pinned: ${original}`);
      }
      handles.push(handle);
      paths.push(original);
      identities.push(expected);
      anchored = `/proc/self/fd/${handle.fd}`;
    }
    const name = parts.at(-1);
    if (!name) throw new CheckpointConflictError("Checkpoint restore cannot replace the workspace root.");
    return {
      parentPath: anchored,
      targetPath: path.join(anchored, name),
      verify: async () => await verifyIdentities(paths, identities),
      close: async () => { for (const handle of handles.reverse()) await handle.close().catch(() => undefined); }
    };
  } catch (error) {
    for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Pins every parent with O_NOFOLLOW and /proc/self/fd on Linux. Node exposes no
 * renameat on Windows, so other platforms use immediate identity revalidation
 * before and after each rename and fail closed on any reparse/identity change.
 */
export async function pinCheckpointParent(workspacePath: string, relative: string): Promise<PinnedCheckpointParent> {
  const parts = relative.split("/").filter(Boolean);
  if (process.platform === "linux") return await pinLinuxParents(workspacePath, parts);
  const parentParts = parts.slice(0, -1);
  const paths = [workspacePath, ...parentParts.map((_part, index) =>
    path.join(workspacePath, ...parentParts.slice(0, index + 1)))];
  const identities = await Promise.all(paths.map(stableDirectory));
  const windowsLock = process.platform === "win32" ? await lockWindowsDirectories(paths) : undefined;
  const name = parts.at(-1);
  if (!name) throw new CheckpointConflictError("Checkpoint restore cannot replace the workspace root.");
  return {
    parentPath: paths.at(-1)!,
    targetPath: path.join(paths.at(-1)!, name),
    verify: async () => await verifyIdentities(paths, identities),
    close: async () => { await windowsLock?.close(); }
  };
}

export async function normalizeCheckpointScopes(
  rawWorkspacePath: string,
  values: readonly string[]
): Promise<NormalizedCheckpointScopes> {
  const workspacePath = await realpath(path.resolve(rawWorkspacePath));
  const candidates = values.length > 0 ? values : ["."];
  const normalized = candidates.map((value) => {
    const target = path.resolve(workspacePath, value);
    const relative = path.relative(workspacePath, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Checkpoint scope escapes workspace: ${value}`);
    }
    return portable(relative);
  }).sort((left, right) => left.length - right.length || left.localeCompare(right));
  const scopePaths = normalized.filter((value, index) => !normalized.slice(0, index).some((parent) =>
    parent === "." || value === parent || value.startsWith(`${parent}/`)));
  for (const scope of scopePaths) await assertSafeCheckpointParents(workspacePath, scope);
  return { workspacePath, scopePaths };
}
