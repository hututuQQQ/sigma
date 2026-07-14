import type { Dirent } from "node:fs";
import path from "node:path";
import {
  pinWorkspaceTransactionDirectories,
  resolveWorkspacePath,
  type WorkspaceTransactionDirectoryLease
} from "agent-platform";
import createIgnore from "ignore";
import { boundedDirectoryEntries } from "./repository-directory-entries.js";
import {
  readStableBoundedText,
  type RepositorySnapshot
} from "./repository-path-metadata.js";
import {
  safeAutomaticDirectoryName,
  safeAutomaticFileName
} from "./repository-path-safety.js";
import {
  HostRepositorySnapshotAccess,
  type RepositorySnapshotAccess
} from "./repository-snapshot-access.js";

export const HOST_CONTEXT_BUDGET_MS = 2_000;
const MAX_INDEXED_FILES = 100_000;
const MAX_SCANNED_ENTRIES = 200_000;
const MAX_LOCKED_DIRECTORIES = 4_096;
const MAX_DIRECTORY_DEPTH = 64;
const MAX_IGNORE_BYTES = 256_000;
const WINDOWS_POST_SCAN_RESERVE_MS = 200;
const POSIX_POST_SCAN_RESERVE_MS = 25;
type IgnoreMatcher = ReturnType<typeof createIgnore>;

export interface HostSnapshotOptions {
  deadline?: number;
  afterDirectoryResolved?: (relative: string, directory: string) => Promise<void>;
  beforeDirectoryScanned?: (relative: string, directory: string) => Promise<void>;
  afterDirectoryScanned?: (relative: string, directory: string) => Promise<void>;
}

export type HostSnapshotConsumer<T> = (
  snapshot: RepositorySnapshot,
  access: RepositorySnapshotAccess
) => Promise<T>;

interface IgnoreScope {
  base: string;
  matcher: IgnoreMatcher;
  parent?: IgnoreScope;
}

interface HostQueueEntry {
  relative: string;
  depth: number;
  ignoreScope?: IgnoreScope;
}

interface LockedHostQueueEntry extends HostQueueEntry {
  directory: string;
  pinnedDirectory: string;
}

interface HostScanState {
  files: string[];
  nextQueue: HostQueueEntry[];
  scannedEntries: number;
  lockedDirectories: number;
  truncated: boolean;
  deadlineReached: boolean;
  deadline: number;
  leases: WorkspaceTransactionDirectoryLease[];
  access: HostRepositorySnapshotAccess;
  afterDirectoryResolved?: HostSnapshotOptions["afterDirectoryResolved"];
  beforeDirectoryScanned?: HostSnapshotOptions["beforeDirectoryScanned"];
  afterDirectoryScanned?: HostSnapshotOptions["afterDirectoryScanned"];
}

function repositoryPath(relative: string, name: string): string {
  return (relative ? `${relative}/${name}` : name).replaceAll("\\", "/");
}

function lexicalOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function scanLimitReached(state: HostScanState, signal: AbortSignal): boolean {
  signal.throwIfAborted();
  const deadlineReached = performance.now() >= state.deadline;
  if (!deadlineReached
    && state.files.length < MAX_INDEXED_FILES
    && state.scannedEntries < MAX_SCANNED_ENTRIES) return false;
  state.deadlineReached ||= deadlineReached;
  state.truncated = true;
  return true;
}

function ignoredByScope(scope: IgnoreScope | undefined, candidate: string, directory: boolean): boolean {
  const hierarchy: IgnoreScope[] = [];
  for (let current = scope; current; current = current.parent) hierarchy.push(current);
  let ignored = false;
  for (const current of hierarchy.reverse()) {
    const local = current.base ? candidate.slice(current.base.length + 1) : candidate;
    if (!local) continue;
    const result = current.matcher.test(directory ? `${local}/` : local);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

async function extendIgnoreScope(
  directory: string,
  relative: string,
  parent: IgnoreScope | undefined,
  state: HostScanState,
  signal: AbortSignal
): Promise<{ accepted: boolean; scope?: IgnoreScope }> {
  if (scanLimitReached(state, signal)) return { accepted: false };
  let loaded;
  try {
    loaded = await readStableBoundedText(path.join(directory, ".gitignore"), MAX_IGNORE_BYTES, signal);
  } catch {
    signal.throwIfAborted();
    state.truncated = true;
    return { accepted: false };
  }
  if (loaded.rejected) {
    state.truncated = true;
    return { accepted: false };
  }
  if (loaded.content === null) return { accepted: true, scope: parent };
  try {
    return {
      accepted: true,
      scope: {
        base: relative,
        matcher: createIgnore().add(loaded.content.replace(/^\uFEFF/u, "")),
        parent
      }
    };
  } catch {
    state.truncated = true;
    return { accepted: false };
  }
}

function indexEntry(
  state: HostScanState,
  queueEntry: LockedHostQueueEntry,
  scope: IgnoreScope | undefined,
  entry: Dirent,
  signal: AbortSignal
): boolean {
  if (scanLimitReached(state, signal)) return false;
  state.scannedEntries += 1;
  const child = repositoryPath(queueEntry.relative, entry.name);
  if (entry.isSymbolicLink()) return true;
  if (entry.isDirectory()) {
    if (!safeAutomaticDirectoryName(entry.name) || ignoredByScope(scope, child, true)) return true;
    if (queueEntry.depth >= MAX_DIRECTORY_DEPTH) state.truncated = true;
    else state.nextQueue.push({ relative: child, depth: queueEntry.depth + 1, ignoreScope: scope });
  } else if (entry.isFile()
    && safeAutomaticFileName(entry.name)
    && !ignoredByScope(scope, child, false)) {
    state.files.push(child);
  }
  if (state.files.length < MAX_INDEXED_FILES) return true;
  state.truncated = true;
  return false;
}

async function scanDirectory(
  queueEntry: LockedHostQueueEntry,
  state: HostScanState,
  signal: AbortSignal
): Promise<void> {
  await state.beforeDirectoryScanned?.(queueEntry.relative, queueEntry.directory);
  try {
    const extended = await extendIgnoreScope(
      queueEntry.pinnedDirectory, queueEntry.relative, queueEntry.ignoreScope, state, signal
    );
    if (!extended.accepted || scanLimitReached(state, signal)) return;
    const filesStart = state.files.length;
    const queueStart = state.nextQueue.length;
    try {
      const collected = await boundedDirectoryEntries(
        queueEntry.pinnedDirectory,
        MAX_SCANNED_ENTRIES - state.scannedEntries,
        state.deadline,
        signal
      );
      if (collected.limitReached) {
        state.truncated = true;
        state.deadlineReached ||= collected.limitReached === "deadline";
        if (collected.limitReached === "entries") state.scannedEntries = MAX_SCANNED_ENTRIES;
        return;
      }
      for (const entry of collected.entries) {
        if (!indexEntry(state, queueEntry, extended.scope, entry, signal)) break;
      }
    } catch {
      signal.throwIfAborted();
      state.files.splice(filesStart);
      state.nextQueue.splice(queueStart);
      state.truncated = true;
    }
  } finally {
    await state.afterDirectoryScanned?.(queueEntry.relative, queueEntry.directory);
  }
}

function pathIdentity(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function pinResolvedBatch(
  workspace: string,
  entries: LockedHostQueueEntry[],
  state: HostScanState,
  signal: AbortSignal
): Promise<LockedHostQueueEntry[]> {
  if (entries.length === 0 || scanLimitReached(state, signal)) return [];
  let lease: WorkspaceTransactionDirectoryLease | undefined;
  let closingForLimit = false;
  try {
    const activeLease = await pinWorkspaceTransactionDirectories(
      entries.map((entry) => entry.directory)
    );
    lease = activeLease;
    if (scanLimitReached(state, signal)) {
      closingForLimit = true;
      await activeLease.close();
      return [];
    }
    await activeLease.verify();
    for (const entry of entries) {
      signal.throwIfAborted();
      const verified = await resolveWorkspacePath(workspace, entry.relative || ".");
      if (pathIdentity(verified) !== pathIdentity(entry.directory)) {
        throw new Error(`Locked repository directory changed: ${entry.relative}`);
      }
    }
    await activeLease.verify();
    const pinnedEntries = entries.map((entry) => ({
      ...entry,
      pinnedDirectory: activeLease.pinnedPath(entry.directory)
    }));
    for (const entry of pinnedEntries) {
      state.access.bindDirectory(entry.relative, entry.pinnedDirectory);
    }
    state.leases.push(activeLease);
    state.lockedDirectories += entries.length;
    return pinnedEntries;
  } catch (error) {
    if (closingForLimit) throw error;
    let closeFailure: unknown;
    try {
      await lease?.close();
    } catch (cleanupError) {
      closeFailure = cleanupError;
    }
    if (closeFailure !== undefined) {
      throw new AggregateError(
        [error, closeFailure],
        "Repository directory locking and cleanup failed.",
        { cause: error }
      );
    }
    signal.throwIfAborted();
    if (scanLimitReached(state, signal)) return [];
    if (entries.length === 1) {
      state.truncated = true;
      return [];
    }
    const middle = Math.floor(entries.length / 2);
    const left = await pinResolvedBatch(workspace, entries.slice(0, middle), state, signal);
    const right = await pinResolvedBatch(workspace, entries.slice(middle), state, signal);
    return [...left, ...right];
  }
}

async function pinDirectoryEntries(
  workspace: string,
  entries: HostQueueEntry[],
  state: HostScanState,
  signal: AbortSignal
): Promise<LockedHostQueueEntry[]> {
  entries.sort((left, right) => lexicalOrder(left.relative, right.relative));
  const remaining = Math.max(0, MAX_LOCKED_DIRECTORIES - state.lockedDirectories);
  if (entries.length > remaining) state.truncated = true;
  const resolved: LockedHostQueueEntry[] = [];
  for (const entry of entries.slice(0, remaining)) {
    if (scanLimitReached(state, signal)) break;
    try {
      const directory = path.resolve(workspace, entry.relative || ".");
      await state.afterDirectoryResolved?.(entry.relative, directory);
      resolved.push({ ...entry, directory, pinnedDirectory: directory });
    } catch {
      signal.throwIfAborted();
      state.truncated = true;
    }
  }
  return await pinResolvedBatch(workspace, resolved, state, signal);
}

async function closeSnapshotLeases(state: HostScanState): Promise<unknown[]> {
  state.access.close();
  const failures: unknown[] = [];
  for (const lease of state.leases.reverse()) {
    try {
      await lease.close();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function verifySnapshotLeases(
  state: HostScanState,
  signal: AbortSignal
): Promise<void> {
  for (const lease of state.leases) {
    signal.throwIfAborted();
    await lease.verify();
  }
  signal.throwIfAborted();
}

export async function withHostRepositorySnapshot<T>(
  workspace: string,
  signal: AbortSignal,
  options: HostSnapshotOptions,
  consume: HostSnapshotConsumer<T>
): Promise<T> {
  const requestedDeadline = options.deadline ?? performance.now() + HOST_CONTEXT_BUDGET_MS;
  signal.throwIfAborted();
  const repositoryRoot = await resolveWorkspacePath(workspace, ".");
  signal.throwIfAborted();
  const reserve = process.platform === "win32"
    ? WINDOWS_POST_SCAN_RESERVE_MS : POSIX_POST_SCAN_RESERVE_MS;
  const state: HostScanState = {
    files: [], nextQueue: [], scannedEntries: 0, lockedDirectories: 0, truncated: false, deadlineReached: false,
    deadline: Math.max(performance.now(), requestedDeadline - reserve),
    leases: [],
    access: new HostRepositorySnapshotAccess(),
    afterDirectoryResolved: options.afterDirectoryResolved,
    beforeDirectoryScanned: options.beforeDirectoryScanned,
    afterDirectoryScanned: options.afterDirectoryScanned
  };
  let operationFailed = false;
  let operationFailure: unknown;
  let result: T | undefined;
  try {
    let current = await pinDirectoryEntries(
      repositoryRoot, [{ relative: "", depth: 0 }], state, signal
    );
    while (current.length > 0 && !scanLimitReached(state, signal)) {
      state.nextQueue = [];
      for (const entry of current) {
        if (scanLimitReached(state, signal)) break;
        await scanDirectory(entry, state, signal);
      }
      current = await pinDirectoryEntries(repositoryRoot, state.nextQueue, state, signal);
    }
    scanLimitReached(state, signal);
    await verifySnapshotLeases(state, signal);
    state.files.sort(lexicalOrder);
    state.access.restrictFiles(state.files);
    result = await consume({
      files: state.files,
      diff: "", truncated: state.truncated, deadlineReached: state.deadlineReached,
      source: "host"
    }, state.access);
    await verifySnapshotLeases(state, signal);
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  }
  const releaseFailures = await closeSnapshotLeases(state);
  if (operationFailed && releaseFailures.length > 0) {
    throw new AggregateError(
      [operationFailure, ...releaseFailures],
      "Repository snapshot operation and directory-lock cleanup failed."
    );
  }
  if (operationFailed) throw operationFailure;
  if (releaseFailures.length > 0) {
    throw new AggregateError(releaseFailures, "Repository directory-lock cleanup failed.");
  }
  return result as T;
}

export async function hostRepositorySnapshot(
  workspace: string,
  signal: AbortSignal,
  options: HostSnapshotOptions = {}
): Promise<RepositorySnapshot> {
  return await withHostRepositorySnapshot(workspace, signal, options, async (snapshot) => snapshot);
}
