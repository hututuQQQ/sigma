import {
  close as closeDescriptor,
  constants,
  fstat,
  read as readDescriptor,
  type BigIntStats
} from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { darwinOpenFileAt } from "./darwin-openat.js";
import { WorkspaceTransactionRootError } from "./workspace-transaction-errors.js";

export interface WorkspaceLeasedFileRead {
  bytes: Buffer | null;
  rejected: boolean;
}

interface LeasedFileHandle {
  stat(): Promise<BigIntStats>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<number>;
  close(): Promise<void>;
}

function directChildName(name: string): void {
  if (!name || name === "." || name === ".." || name.includes("\0")
    || name.includes("/") || name.includes("\\")) {
    throw new WorkspaceTransactionRootError(
      `Workspace transaction child name is unsafe: ${JSON.stringify(name)}`
    );
  }
}

function readLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("Workspace leased file maxBytes must be a positive safe integer.");
  }
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function acceptable(state: BigIntStats, maxBytes: number): boolean {
  return state.isFile() && !state.isSymbolicLink()
    && state.nlink === 1n && state.size <= BigInt(maxBytes);
}

function sameStableState(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function descriptorHandle(descriptor: number): LeasedFileHandle {
  return {
    stat: async () => await new Promise<BigIntStats>((resolve, reject) => {
      fstat(descriptor, { bigint: true }, (error, state) => {
        if (error) reject(error);
        else resolve(state);
      });
    }),
    read: async (buffer, offset, length, position) => await new Promise<number>(
      (resolve, reject) => {
        readDescriptor(descriptor, buffer, offset, length, position, (error, bytesRead) => {
          if (error) reject(error);
          else resolve(bytesRead);
        });
      }
    ),
    close: async () => await new Promise<void>((resolve, reject) => {
      closeDescriptor(descriptor, (error) => error ? reject(error) : resolve());
    })
  };
}

async function pathHandle(target: string): Promise<LeasedFileHandle> {
  const noFollow = Reflect.get(constants, "O_NOFOLLOW");
  const handle = await open(
    target,
    constants.O_RDONLY | (typeof noFollow === "number" ? noFollow : 0)
  );
  return {
    stat: async () => await handle.stat({ bigint: true }),
    read: async (buffer, offset, length, position) =>
      (await handle.read(buffer, offset, length, position)).bytesRead,
    close: async () => await handle.close()
  };
}

async function openedChild(
  pinnedDirectory: string,
  directoryDescriptor: number | undefined,
  name: string
): Promise<LeasedFileHandle> {
  if (process.platform === "darwin") {
    if (directoryDescriptor === undefined) {
      throw new WorkspaceTransactionRootError("Pinned Darwin directory handle is unavailable.");
    }
    return descriptorHandle(darwinOpenFileAt(directoryDescriptor, name));
  }
  return await pathHandle(path.join(pinnedDirectory, name));
}

async function pathState(target: string): Promise<BigIntStats | null> {
  return await lstat(target, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (missing(error)) return null;
    throw error;
  });
}

async function expectedBytes(
  handle: LeasedFileHandle,
  expectedSize: number,
  maxBytes: number,
  signal: AbortSignal
): Promise<Buffer | null> {
  const buffer = Buffer.alloc(Math.min(maxBytes + 1, Math.max(1, expectedSize + 1)));
  let offset = 0;
  while (offset < buffer.length) {
    signal.throwIfAborted();
    const bytesRead = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === expectedSize ? buffer.subarray(0, offset) : null;
}

async function currentChildState(
  pinnedDirectory: string,
  directoryDescriptor: number | undefined,
  name: string
): Promise<BigIntStats | null> {
  if (process.platform !== "darwin") {
    return await pathState(path.join(pinnedDirectory, name));
  }
  let current: LeasedFileHandle;
  try {
    current = await openedChild(pinnedDirectory, directoryDescriptor, name);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  try {
    return await current.stat();
  } finally {
    await current.close();
  }
}

/** Reads one direct child without leaving an already-pinned directory handle. */
export async function readLeasedDirectoryFile(
  pinnedDirectory: string,
  directoryDescriptor: number | undefined,
  name: string,
  maxBytes: number,
  signal: AbortSignal
): Promise<WorkspaceLeasedFileRead> {
  directChildName(name);
  readLimit(maxBytes);
  signal.throwIfAborted();
  const target = path.join(pinnedDirectory, name);
  let pathBefore: BigIntStats | null = null;
  if (process.platform !== "darwin") {
    try {
      pathBefore = await pathState(target);
    } catch {
      return { bytes: null, rejected: true };
    }
    if (!pathBefore) return { bytes: null, rejected: false };
    if (!acceptable(pathBefore, maxBytes)) return { bytes: null, rejected: true };
  }

  let handle: LeasedFileHandle;
  try {
    handle = await openedChild(pinnedDirectory, directoryDescriptor, name);
  } catch (error) {
    signal.throwIfAborted();
    return { bytes: null, rejected: !missing(error) };
  }
  try {
    const before = await handle.stat();
    if (!acceptable(before, maxBytes)
      || (pathBefore && !sameStableState(pathBefore, before))) {
      return { bytes: null, rejected: true };
    }
    const bytes = await expectedBytes(handle, Number(before.size), maxBytes, signal);
    signal.throwIfAborted();
    const after = await handle.stat();
    const current = await currentChildState(pinnedDirectory, directoryDescriptor, name);
    if (!bytes || !current || !acceptable(current, maxBytes)
      || !sameStableState(before, after) || !sameStableState(after, current)) {
      return { bytes: null, rejected: true };
    }
    return { bytes, rejected: false };
  } catch {
    signal.throwIfAborted();
    return { bytes: null, rejected: true };
  } finally {
    await handle.close();
  }
}
