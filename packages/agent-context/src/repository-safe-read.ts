import path from "node:path";
import {
  isInside,
  pinWorkspaceTransactionPaths,
  resolveWorkspacePath,
  type WorkspaceTransactionDirectoryLease
} from "agent-platform";
import {
  captureStableBoundedTextState,
  readStableBoundedText,
  type StableTextRead
} from "./repository-path-metadata.js";
import { safeAutomaticFilePath } from "./repository-path-safety.js";

export interface StableWorkspaceReadOptions {
  afterTargetResolved?: (target: string) => Promise<void>;
  beforeStableRead?: () => Promise<void>;
  afterStableRead?: () => Promise<void>;
}

function pathIdentity(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function parentDirectoryChain(root: string, target: string): string[] {
  const parent = path.dirname(target);
  if (!isInside(root, parent)) throw new Error("Repository file parent escapes the workspace.");
  const directories: string[] = [];
  let current = parent;
  while (true) {
    directories.unshift(current);
    if (pathIdentity(current) === pathIdentity(root)) return directories;
    const next = path.dirname(current);
    if (next === current || !isInside(root, next)) {
      throw new Error("Repository file parent chain does not reach the workspace root.");
    }
    current = next;
  }
}

async function verifyBoundPath(
  root: string,
  relative: string,
  expectedTarget: string,
  lease: WorkspaceTransactionDirectoryLease,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted();
  await lease.verify();
  const verified = await resolveWorkspacePath(root, relative);
  if (pathIdentity(verified) !== pathIdentity(expectedTarget)) {
    throw new Error(`Repository file parent chain changed: ${relative}`);
  }
  await lease.verify();
  signal.throwIfAborted();
}

const rejectedRead = (): StableTextRead => ({ content: null, rejected: true });

async function requiredExpectedState(target: string, relative: string, maxBytes: number) {
  const state = await captureStableBoundedTextState(target, maxBytes);
  if (!state) throw new Error(`Repository file is unsafe or unavailable: ${relative}`);
  return state;
}

async function resolveUnlinkedRepositoryTarget(root: string, relative: string): Promise<string> {
  const lexicalTarget = path.resolve(root, relative);
  if (!isInside(root, lexicalTarget)) {
    throw new Error(`Repository file escapes workspace: ${relative}`);
  }
  const target = await resolveWorkspacePath(root, relative);
  if (!isInside(root, target)) throw new Error(`Repository file escapes workspace: ${relative}`);
  if (pathIdentity(lexicalTarget) !== pathIdentity(target)) {
    throw new Error(`Repository file traverses a linked path: ${relative}`);
  }
  return target;
}

/**
 * Reads one automatically selected repository file while pinning its complete
 * canonical parent chain. The path and directory identities are checked both
 * before and after the stable file-handle read.
 */
export async function readStableWorkspaceText(
  workspace: string,
  relative: string,
  maxBytes: number,
  signal: AbortSignal,
  options: StableWorkspaceReadOptions = {}
): Promise<StableTextRead> {
  signal.throwIfAborted();
  if (!safeAutomaticFilePath(relative)) return rejectedRead();
  let lease: WorkspaceTransactionDirectoryLease | undefined;
  let loaded: StableTextRead | undefined;
  let operationFailure: unknown;
  try {
    const root = await resolveWorkspacePath(workspace, ".");
    const target = await resolveUnlinkedRepositoryTarget(root, relative);
    const expectedState = await requiredExpectedState(target, relative, maxBytes);
    await options.afterTargetResolved?.(target);
    lease = await pinWorkspaceTransactionPaths([
      ...parentDirectoryChain(root, target).map((directory) => ({
        path: directory,
        kind: "directory" as const
      })),
      { path: target, kind: "file" }
    ]);
    await verifyBoundPath(root, relative, target, lease, signal);
    await options.beforeStableRead?.();
    loaded = await readStableBoundedText(target, maxBytes, signal, expectedState);
    await options.afterStableRead?.();
    await verifyBoundPath(root, relative, target, lease, signal);
  } catch (error) {
    operationFailure = error;
  }

  let cleanupFailure: unknown;
  try {
    await lease?.close();
  } catch (error) {
    cleanupFailure = error;
  }
  if (operationFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [operationFailure, cleanupFailure],
      `Repository read and directory-lock cleanup failed: ${relative}`
    );
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (operationFailure !== undefined) {
    signal.throwIfAborted();
    return rejectedRead();
  }
  return loaded ?? rejectedRead();
}
