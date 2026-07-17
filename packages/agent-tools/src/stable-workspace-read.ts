import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import {
  isInside,
  pinWorkspaceTransactionPaths,
  resolveWorkspacePath,
  type WindowsPathLockRequest,
  type WorkspaceTransactionDirectoryLease
} from "agent-platform";

export const MAX_EXPLICIT_WORKSPACE_READ_BYTES = 1024 * 1024;

export type StableWorkspaceReadErrorCode =
  | "workspace_read_invalid_path"
  | "workspace_read_unavailable"
  | "workspace_read_unsafe"
  | "workspace_read_too_large"
  | "workspace_read_changed"
  | "workspace_read_invalid_utf8"
  | "workspace_read_cleanup_failed";

export class StableWorkspaceReadError extends Error {
  constructor(
    readonly code: StableWorkspaceReadErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "StableWorkspaceReadError";
  }
}

/** Internal lifecycle hooks used by filesystem race tests. */
export interface StableWorkspaceReadOptions {
  maxBytes?: number;
  allowExternalAbsolutePath?: boolean;
  beforePinnedRead?: () => Promise<void>;
  afterPinnedRead?: () => Promise<void>;
}

/** Exact bytes and text metadata captured under one stable workspace-path
 * lease. `byteLength` and `sha256` describe the original bytes, not a
 * re-encoded approximation of `content`. */
export interface StableWorkspaceTextRead {
  content: string;
  bytes: Buffer;
  byteLength: number;
  endsWithNewline: boolean;
  sha256: string;
}

interface CapturedPath {
  request: WindowsPathLockRequest;
  state: BigIntStats;
}

function readError(
  code: StableWorkspaceReadErrorCode,
  requested: string,
  detail: string,
  cause?: unknown
): StableWorkspaceReadError {
  return new StableWorkspaceReadError(
    code,
    `Cannot read workspace file '${requested}': ${detail}`,
    cause instanceof Error ? { cause } : undefined
  );
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathRequests(root: string, target: string, requested: string): WindowsPathLockRequest[] {
  if (pathKey(root) === pathKey(target)) {
    throw readError("workspace_read_unsafe", requested, "the requested path is not a regular file");
  }
  const directories: string[] = [];
  let current = path.dirname(target);
  while (isInside(root, current)) {
    directories.unshift(current);
    if (pathKey(current) === pathKey(root)) break;
    current = path.dirname(current);
  }
  if (directories.length === 0 || pathKey(directories[0]!) !== pathKey(root)) {
    throw readError("workspace_read_invalid_path", requested, "the parent chain escapes the workspace");
  }
  return [
    ...directories.map((directory) => ({ path: directory, kind: "directory" as const })),
    { path: target, kind: "file" as const }
  ];
}

function assertSafeState(
  request: WindowsPathLockRequest,
  state: BigIntStats,
  maxBytes: number,
  requested: string
): void {
  const correctKind = request.kind === "directory" ? state.isDirectory() : state.isFile();
  if (!correctKind || state.isSymbolicLink()) {
    throw readError("workspace_read_unsafe", requested, "a path component is a link or has an unsafe type");
  }
  if (request.kind === "file" && state.nlink !== 1n) {
    throw readError("workspace_read_unsafe", requested, "files with multiple hard links are rejected");
  }
  if (request.kind === "file" && state.size > BigInt(maxBytes)) {
    throw readError(
      "workspace_read_too_large",
      requested,
      `the file exceeds the ${maxBytes}-byte read limit`
    );
  }
}

async function capturedPaths(
  requests: readonly WindowsPathLockRequest[],
  maxBytes: number,
  requested: string,
  signal: AbortSignal
): Promise<CapturedPath[]> {
  const captured: CapturedPath[] = [];
  for (const request of requests) {
    signal.throwIfAborted();
    let state: BigIntStats;
    try {
      state = await lstat(request.path, { bigint: true });
    } catch (error) {
      throw readError("workspace_read_unavailable", requested, "the path does not exist or cannot be inspected", error);
    }
    assertSafeState(request, state, maxBytes, requested);
    captured.push({ request, state });
  }
  signal.throwIfAborted();
  return captured;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileState(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right) && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function verifyCapturedPaths(
  captured: readonly CapturedPath[],
  lease: WorkspaceTransactionDirectoryLease,
  maxBytes: number,
  requested: string,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted();
  try {
    await lease.verify();
    for (const entry of captured) {
      const current = await lstat(entry.request.path, { bigint: true });
      assertSafeState(entry.request, current, maxBytes, requested);
      const stable = entry.request.kind === "file"
        ? sameFileState(entry.state, current) : sameIdentity(entry.state, current);
      if (!stable) throw new Error(`Path identity changed: ${entry.request.path}`);
    }
    await lease.verify();
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof StableWorkspaceReadError) throw error;
    throw readError("workspace_read_changed", requested, "the path changed while it was being secured", error);
  }
  signal.throwIfAborted();
}

async function readExpectedBytes(
  handle: Awaited<ReturnType<typeof open>>,
  expectedSize: number,
  maxBytes: number,
  signal: AbortSignal
): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.min(maxBytes + 1, expectedSize + 1));
  let offset = 0;
  while (offset < buffer.length) {
    signal.throwIfAborted();
    const result = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset !== expectedSize) throw new Error("File length changed during the read.");
  return buffer.subarray(0, offset);
}

async function readPinnedBytes(
  target: string,
  expected: BigIntStats,
  lease: WorkspaceTransactionDirectoryLease,
  maxBytes: number,
  requested: string,
  signal: AbortSignal
): Promise<Buffer> {
  let handle;
  try {
    handle = await open(lease.pinnedPath(target), constants.O_RDONLY);
    const before = await handle.stat({ bigint: true });
    assertSafeState({ path: target, kind: "file" }, before, maxBytes, requested);
    if (!sameFileState(expected, before)) throw new Error("Pinned file identity changed before the read.");
    const bytes = await readExpectedBytes(handle, Number(before.size), maxBytes, signal);
    const after = await handle.stat({ bigint: true });
    if (!sameFileState(before, after)) throw new Error("Pinned file changed during the read.");
    return bytes;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof StableWorkspaceReadError) throw error;
    throw readError("workspace_read_changed", requested, "the file changed while it was being read", error);
  } finally {
    await handle?.close();
  }
}

function decodeUtf8(bytes: Buffer, requested: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw readError("workspace_read_invalid_utf8", requested, "the file is not valid UTF-8 text", error);
  }
}

async function closeLease(
  lease: WorkspaceTransactionDirectoryLease | undefined,
  primary: unknown,
  requested: string
): Promise<never | void> {
  let cleanup: unknown;
  try {
    await lease?.close();
  } catch (error) {
    cleanup = error;
  }
  if (primary !== undefined && cleanup !== undefined) {
    if (primary instanceof StableWorkspaceReadError) {
      throw new StableWorkspaceReadError(primary.code, primary.message, {
        cause: new AggregateError([primary, cleanup], "Workspace read and lease cleanup failed.")
      });
    }
    throw readError("workspace_read_cleanup_failed", requested, "the read and lease cleanup both failed", cleanup);
  }
  if (primary !== undefined) throw primary;
  if (cleanup !== undefined) {
    throw readError("workspace_read_cleanup_failed", requested, "the path lease could not be released", cleanup);
  }
}

function stableReadLimit(requestedLimit: number | undefined): number {
  const maxBytes = requestedLimit ?? MAX_EXPLICIT_WORKSPACE_READ_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("Stable workspace read maxBytes must be a positive safe integer.");
  }
  return maxBytes;
}

async function stableReadLocation(
  workspace: string,
  requested: string,
  allowExternalAbsolutePath: boolean | undefined
): Promise<{ root: string; target: string }> {
  let workspaceRoot: string;
  try {
    workspaceRoot = await resolveWorkspacePath(workspace, ".");
  } catch (error) {
    throw readError("workspace_read_unavailable", requested, "the workspace cannot be resolved", error);
  }
  const target = path.isAbsolute(requested)
    ? path.resolve(requested) : path.resolve(workspaceRoot, requested);
  const external = !isInside(workspaceRoot, target);
  if (external && !allowExternalAbsolutePath) {
    throw readError("workspace_read_invalid_path", requested, "the path escapes the workspace");
  }
  return { root: external ? path.parse(target).root : workspaceRoot, target };
}

export async function readStableWorkspaceTextFile(
  workspace: string,
  requested: string,
  signal: AbortSignal,
  options: StableWorkspaceReadOptions = {}
): Promise<StableWorkspaceTextRead> {
  signal.throwIfAborted();
  const maxBytes = stableReadLimit(options.maxBytes);
  const { root, target } = await stableReadLocation(
    workspace, requested, options.allowExternalAbsolutePath
  );
  const requests = pathRequests(root, target, requested);
  const captured = await capturedPaths(requests, maxBytes, requested, signal);
  let lease: WorkspaceTransactionDirectoryLease | undefined;
  let primary: unknown;
  let result: StableWorkspaceTextRead | undefined;
  try {
    lease = await pinWorkspaceTransactionPaths(requests);
    await verifyCapturedPaths(captured, lease, maxBytes, requested, signal);
    await options.beforePinnedRead?.();
    try {
      const bytes = await readPinnedBytes(
        target, captured.at(-1)!.state, lease, maxBytes, requested, signal
      );
      const content = decodeUtf8(bytes, requested);
      result = {
        content,
        bytes,
        byteLength: bytes.byteLength,
        endsWithNewline: content.endsWith("\n") || content.endsWith("\r"),
        sha256: createHash("sha256").update(bytes).digest("hex")
      };
    } finally {
      await options.afterPinnedRead?.();
    }
    await verifyCapturedPaths(captured, lease, maxBytes, requested, signal);
  } catch (error) {
    primary = signal.aborted ? signal.reason : error instanceof StableWorkspaceReadError
      ? error : readError("workspace_read_changed", requested, "the path changed while it was being secured", error);
  }
  await closeLease(lease, primary, requested);
  return result!;
}
