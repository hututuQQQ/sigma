import { createRequire } from "node:module";

const DIRENT_HEADER_BYTES = 21;
const DARWIN_MAX_PATH_BYTES = 1_024;
const DARWIN_MAX_DIRENT_BYTES = DIRENT_HEADER_BYTES + DARWIN_MAX_PATH_BYTES + 3;
const DT_UNKNOWN = 0;
const DT_DIRECTORY = 4;
const DT_FILE = 8;
const DT_SYMBOLIC_LINK = 10;
const supportedEntryTypes = new Set([
  1, // FIFO
  2, // character device
  DT_DIRECTORY,
  6, // block device
  DT_FILE,
  DT_SYMBOLIC_LINK,
  12, // socket
  14 // whiteout
]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface WorkspaceDirectoryEntry {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

class DarwinDirectoryEntry implements WorkspaceDirectoryEntry {
  constructor(readonly name: string, private readonly type: number) {}

  isFile(): boolean { return this.type === DT_FILE; }
  isDirectory(): boolean { return this.type === DT_DIRECTORY; }
  isSymbolicLink(): boolean { return this.type === DT_SYMBOLIC_LINK; }
}

interface DarwinFunctions {
  dup(fd: number): number;
  fdopendir(fd: number): bigint;
  rewinddir(directory: bigint): void;
  readdir(directory: bigint): bigint;
  closedir(directory: bigint): number;
  close(fd: number): number;
  __error(): bigint;
}

interface DynamicLibrary {
  functions: DarwinFunctions;
  lib: { close(): void };
}

interface NodeFfi {
  dlopen(
    path: string | null,
    symbols: Record<string, { arguments: string[]; return: string }>
  ): DynamicLibrary;
  getInt32(pointer: bigint, offset?: number): number;
  getUint16(pointer: bigint, offset?: number): number;
  setInt32(pointer: bigint, offset: number, value: number): void;
  toBuffer(pointer: bigint, length: number, copy?: boolean): Buffer;
}

interface OpenDarwinDirectory {
  ffi: NodeFfi;
  library: DynamicLibrary;
  errnoPointer: bigint;
  directory: bigint;
}

function openDarwinLibc(): { ffi: NodeFfi; library: DynamicLibrary } {
  if (process.platform !== "darwin") {
    throw new Error("Darwin directory enumeration is available only on macOS.");
  }
  const ffi = createRequire(import.meta.url)("node:ffi") as NodeFfi;
  return {
    ffi,
    library: ffi.dlopen(null, {
      dup: { arguments: ["int32"], return: "int32" },
      fdopendir: { arguments: ["int32"], return: "pointer" },
      rewinddir: { arguments: ["pointer"], return: "void" },
      readdir: { arguments: ["pointer"], return: "pointer" },
      closedir: { arguments: ["pointer"], return: "int32" },
      close: { arguments: ["int32"], return: "int32" },
      __error: { arguments: [], return: "pointer" }
    })
  };
}

function errnoError(operation: string, errno: number): Error {
  return Object.assign(new Error(`${operation} failed (errno=${errno}).`), { errno });
}

function errorValue(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Parse the 64-bit Darwin dirent layout published by XNU. */
export function parseDarwinDirectoryEntry(record: Buffer): WorkspaceDirectoryEntry {
  if (record.byteLength < DIRENT_HEADER_BYTES + 1) {
    throw new Error("Darwin directory entry is shorter than its fixed header.");
  }
  const recordLength = record.readUInt16LE(16);
  const nameLength = record.readUInt16LE(18);
  const type = record.readUInt8(20);
  if (recordLength < DIRENT_HEADER_BYTES + 1
    || recordLength > DARWIN_MAX_DIRENT_BYTES
    || recordLength !== record.byteLength) {
    throw new Error("Darwin directory entry has an invalid record length.");
  }
  if (nameLength === 0
    || nameLength >= DARWIN_MAX_PATH_BYTES
    || DIRENT_HEADER_BYTES + nameLength >= recordLength) {
    throw new Error("Darwin directory entry has an invalid name length.");
  }
  if (record[DIRENT_HEADER_BYTES + nameLength] !== 0) {
    throw new Error("Darwin directory entry name is not NUL terminated.");
  }
  if (type === DT_UNKNOWN || !supportedEntryTypes.has(type)) {
    throw new Error(`Darwin directory entry has an unsupported type: ${type}.`);
  }
  const name = utf8Decoder.decode(record.subarray(
    DIRENT_HEADER_BYTES,
    DIRENT_HEADER_BYTES + nameLength
  ));
  if (name.includes("\0") || name.includes("/")) {
    throw new Error("Darwin directory entry has an unsafe name.");
  }
  return new DarwinDirectoryEntry(name, type);
}

function openDarwinDirectory(descriptor: number): OpenDarwinDirectory {
  const { ffi, library } = openDarwinLibc();
  let duplicate = -1;
  let directory = 0n;
  try {
    const errnoPointer = library.functions.__error();
    if (errnoPointer === 0n) throw new Error("Darwin libc did not expose thread-local errno.");
    ffi.setInt32(errnoPointer, 0, 0);
    duplicate = library.functions.dup(descriptor);
    if (duplicate < 0) throw errnoError("dup", ffi.getInt32(errnoPointer));
    ffi.setInt32(errnoPointer, 0, 0);
    directory = library.functions.fdopendir(duplicate);
    if (directory === 0n) throw errnoError("fdopendir", ffi.getInt32(errnoPointer));
    duplicate = -1;
    library.functions.rewinddir(directory);
    return { ffi, library, errnoPointer, directory };
  } catch (error) {
    if (directory !== 0n) library.functions.closedir(directory);
    else if (duplicate >= 0) library.functions.close(duplicate);
    library.lib.close();
    throw error;
  }
}

function readDarwinDirectoryEntry(state: OpenDarwinDirectory): WorkspaceDirectoryEntry | null {
  const { ffi, library, errnoPointer, directory } = state;
  ffi.setInt32(errnoPointer, 0, 0);
  const pointer = library.functions.readdir(directory);
  if (pointer === 0n) {
    const readErrno = ffi.getInt32(errnoPointer);
    if (readErrno !== 0) throw errnoError("readdir", readErrno);
    return null;
  }
  const recordLength = ffi.getUint16(pointer, 16);
  if (recordLength < DIRENT_HEADER_BYTES + 1 || recordLength > DARWIN_MAX_DIRENT_BYTES) {
    throw new Error("Darwin libc returned an invalid directory entry length.");
  }
  return parseDarwinDirectoryEntry(ffi.toBuffer(pointer, recordLength, true));
}

function closeDarwinDirectory(state: OpenDarwinDirectory): Error | undefined {
  const failures: Error[] = [];
  try {
    state.ffi.setInt32(state.errnoPointer, 0, 0);
    if (state.library.functions.closedir(state.directory) !== 0) {
      failures.push(errnoError("closedir", state.ffi.getInt32(state.errnoPointer)));
    }
  } catch (error) {
    failures.push(errorValue(error));
  }
  try { state.library.lib.close(); } catch (error) { failures.push(errorValue(error)); }
  if (failures.length === 0) return undefined;
  return failures.length === 1
    ? failures[0]
    : new AggregateError(failures, "Darwin directory cleanup failed.");
}

/** Enumerate an already-pinned Darwin directory descriptor without reopening its path. */
export async function* darwinDirectoryEntries(
  descriptor: number
): AsyncGenerator<WorkspaceDirectoryEntry> {
  if (!Number.isSafeInteger(descriptor) || descriptor < 0) {
    throw new Error("Darwin directory descriptor is invalid.");
  }
  const state = openDarwinDirectory(descriptor);
  let operationFailed = false;
  let operationFailure: unknown;
  let cleanupFailure: Error | undefined;
  try {
    while (true) {
      const entry = readDarwinDirectoryEntry(state);
      if (!entry) break;
      if (entry.name !== "." && entry.name !== "..") yield entry;
    }
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  } finally {
    cleanupFailure = closeDarwinDirectory(state);
  }
  if (operationFailed && cleanupFailure) {
    throw new AggregateError(
      [operationFailure, cleanupFailure],
      "Darwin directory enumeration and cleanup failed."
    );
  }
  if (operationFailed) throw operationFailure;
  if (cleanupFailure) throw cleanupFailure;
}
