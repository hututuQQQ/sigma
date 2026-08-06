import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import path from "node:path";
import {
  darwinDirectoryEntries,
  type WorkspaceDirectoryEntry
} from "./darwin-directory-entries.js";
import { WorkspaceTransactionRootError } from "./workspace-transaction-errors.js";
import {
  lockWindowsPaths,
  type WindowsDirectoryLock,
  type WindowsPathLockRequest
} from "./windows-directory-lock.js";

export interface WorkspaceTransactionDirectoryLease {
  /**
   * Returns an OS-pinned traversal path for an exact leased target. The path is
   * valid only until the lease is closed. On Windows the directory lock makes
   * the original path stable; POSIX uses the open descriptor instead.
   */
  pinnedPath(target: string): string;
  /** Enumerates a leased directory through the pinned OS handle. */
  directoryEntries(target: string): AsyncIterable<WorkspaceDirectoryEntry>;
  verify(): Promise<void>;
  close(): Promise<void>;
}

interface PathIdentity { dev: bigint; ino: bigint; kind: "directory" | "file" }
type OpenPathHandle = Awaited<ReturnType<typeof open>>;

function identity(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function pathIdentity(target: WindowsPathLockRequest): Promise<PathIdentity> {
  const info = await lstat(target.path, { bigint: true });
  const matchesKind = target.kind === "directory" ? info.isDirectory() : info.isFile();
  if (!matchesKind || info.isSymbolicLink()) {
    throw new WorkspaceTransactionRootError(`Workspace transaction path is unsafe: ${target.path}`);
  }
  if (target.kind === "file" && info.nlink !== 1n) {
    throw new WorkspaceTransactionRootError(`Workspace transaction file has multiple hard links: ${target.path}`);
  }
  return { dev: info.dev, ino: info.ino, kind: target.kind };
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.kind === right.kind;
}

function descriptorRoot(platform: NodeJS.Platform): string | undefined {
  if (platform === "linux" || platform === "android") return "/proc/self/fd";
  if (["darwin", "freebsd", "netbsd", "openbsd"].includes(platform)) return "/dev/fd";
  return undefined;
}

function pinnedDescriptorPath(
  requestedTarget: string,
  paths: readonly WindowsPathLockRequest[],
  handles: readonly OpenPathHandle[],
  indexes: ReadonlyMap<string, number>
): string {
  const index = indexes.get(identity(requestedTarget));
  if (index === undefined) {
    throw new WorkspaceTransactionRootError(
      `Workspace transaction path is not covered by this lease: ${requestedTarget}`
    );
  }
  if (process.platform === "win32") return paths[index]!.path;
  const root = descriptorRoot(process.platform);
  const handle = handles[index];
  if (!root || !handle) {
    throw new WorkspaceTransactionRootError(
      `Pinned path traversal is unavailable on ${process.platform}.`
    );
  }
  return path.join(root, String(handle.fd));
}

async function* pathDirectoryEntries(
  directory: string
): AsyncGenerator<WorkspaceDirectoryEntry> {
  const opened = await opendir(directory);
  try {
    while (true) {
      const entry = await opened.read();
      if (!entry) break;
      yield entry;
    }
  } finally {
    await opened.close().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ERR_DIR_CLOSED") throw error;
    });
  }
}

function leasedDirectoryEntries(
  requestedTarget: string,
  paths: readonly WindowsPathLockRequest[],
  handles: readonly OpenPathHandle[],
  indexes: ReadonlyMap<string, number>,
  closed: boolean
): AsyncIterable<WorkspaceDirectoryEntry> {
  if (closed) throw new WorkspaceTransactionRootError("Workspace transaction path lease is closed.");
  const index = indexes.get(identity(requestedTarget));
  const target = index === undefined ? undefined : paths[index];
  if (index === undefined || !target) {
    throw new WorkspaceTransactionRootError(
      `Workspace transaction path is not covered by this lease: ${requestedTarget}`
    );
  }
  if (target.kind !== "directory") {
    throw new WorkspaceTransactionRootError(
      `Workspace transaction path is not a directory: ${requestedTarget}`
    );
  }
  if (process.platform === "darwin") {
    const handle = handles[index];
    if (!handle) {
      throw new WorkspaceTransactionRootError("Pinned Darwin directory handle is unavailable.");
    }
    return darwinDirectoryEntries(handle.fd);
  }
  return pathDirectoryEntries(pinnedDescriptorPath(requestedTarget, paths, handles, indexes));
}

/** Pins transaction directories during a mutation and revalidates their path identities. */
export async function pinWorkspaceTransactionDirectories(
  requestedPaths: readonly string[]
): Promise<WorkspaceTransactionDirectoryLease> {
  return await pinWorkspaceTransactionPaths(
    requestedPaths.map((target) => ({ path: target, kind: "directory" }))
  );
}

/** Pins exact path identities; Windows file leases also deny concurrent writes. */
export async function pinWorkspaceTransactionPaths(
  requestedPaths: readonly WindowsPathLockRequest[]
): Promise<WorkspaceTransactionDirectoryLease> {
  const paths = [...new Map(requestedPaths.map((value) => {
    const resolved = path.resolve(value.path);
    return [`${value.kind}:${resolved}`, { path: resolved, kind: value.kind }] as const;
  })).values()];
  const identities = await Promise.all(paths.map(pathIdentity));
  const handles: OpenPathHandle[] = [];
  let windowsLock: WindowsDirectoryLock | undefined;
  try {
    if (process.platform !== "win32") {
      for (const [index, target] of paths.entries()) {
        const handle = await open(
          target.path,
          constants.O_RDONLY | constants.O_NOFOLLOW
            | (target.kind === "directory" ? constants.O_DIRECTORY : 0)
        );
        const current = await handle.stat({ bigint: true });
        const currentIdentity: PathIdentity = {
          dev: current.dev,
          ino: current.ino,
          kind: current.isDirectory() ? "directory" : "file"
        };
        if (!sameIdentity(identities[index]!, currentIdentity)) {
          await handle.close();
          throw new WorkspaceTransactionRootError(`Workspace transaction path changed: ${target.path}`);
        }
        handles.push(handle);
      }
    }
    windowsLock = await lockWindowsPaths(paths);
    const indexes = new Map(paths.map((target, index) => [identity(target.path), index] as const));
    let closed = false;
    return {
      pinnedPath: (requestedTarget) => {
        if (closed) throw new WorkspaceTransactionRootError("Workspace transaction path lease is closed.");
        return pinnedDescriptorPath(requestedTarget, paths, handles, indexes);
      },
      directoryEntries: (requestedTarget) => leasedDirectoryEntries(
        requestedTarget, paths, handles, indexes, closed
      ),
      verify: async () => {
        if (closed) throw new WorkspaceTransactionRootError("Workspace transaction path lease is closed.");
        for (const [index, target] of paths.entries()) {
          if (!sameIdentity(identities[index]!, await pathIdentity(target))) {
            throw new WorkspaceTransactionRootError(`Workspace transaction path changed: ${target.path}`);
          }
        }
      },
      close: async () => {
        if (closed) return;
        closed = true;
        const failures: unknown[] = [];
        try { await windowsLock?.close(); } catch (error) { failures.push(error); }
        for (const handle of handles.reverse()) {
          try { await handle.close(); } catch (error) { failures.push(error); }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Workspace path lease cleanup failed.");
      }
    };
  } catch (error) {
    const failures: unknown[] = [error];
    try { await windowsLock?.close(); } catch (closeError) { failures.push(closeError); }
    for (const handle of handles.reverse()) {
      try { await handle.close(); } catch (closeError) { failures.push(closeError); }
    }
    if (failures.length === 1) throw error;
    throw new AggregateError(failures, "Workspace path pinning and cleanup failed.", { cause: error });
  }
}
