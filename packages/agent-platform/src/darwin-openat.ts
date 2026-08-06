import { createRequire } from "node:module";

// XNU fcntl.h values for the supported Darwin target. O_NONBLOCK avoids
// blocking on a hostile FIFO before fstat can reject it.
const DARWIN_O_NONBLOCK = 0x0000_0004;
const DARWIN_O_NOFOLLOW = 0x0000_0100;
const DARWIN_O_CLOEXEC = 0x0100_0000;

interface DarwinOpenAtFunctions {
  openat(directory: number, name: string, flags: number, mode: number): number;
  __error(): bigint;
}

interface DynamicLibrary {
  functions: DarwinOpenAtFunctions;
  lib: { close(): void };
}

interface NodeFfi {
  dlopen(
    path: string | null,
    symbols: Record<string, { arguments: string[]; return: string }>
  ): DynamicLibrary;
  getInt32(pointer: bigint, offset?: number): number;
  setInt32(pointer: bigint, offset: number, value: number): void;
}

function errnoCode(errno: number): string | undefined {
  if (errno === 2) return "ENOENT";
  if (errno === 20) return "ENOTDIR";
  if (errno === 40 || errno === 62) return "ELOOP";
  return undefined;
}

/** Opens one direct child relative to an already-pinned Darwin directory. */
export function darwinOpenFileAt(directory: number, name: string): number {
  if (process.platform !== "darwin") {
    throw new Error("Darwin descriptor-relative file opening is available only on macOS.");
  }
  if (!Number.isSafeInteger(directory) || directory < 0) {
    throw new Error("Darwin directory descriptor is invalid.");
  }
  const ffi = createRequire(import.meta.url)("node:ffi") as NodeFfi;
  const library = ffi.dlopen(null, {
    openat: {
      arguments: ["int32", "string", "int32", "uint32"],
      return: "int32"
    },
    __error: { arguments: [], return: "pointer" }
  });
  try {
    const errnoPointer = library.functions.__error();
    if (errnoPointer === 0n) throw new Error("Darwin libc did not expose thread-local errno.");
    ffi.setInt32(errnoPointer, 0, 0);
    const descriptor = library.functions.openat(
      directory,
      name,
      DARWIN_O_NONBLOCK | DARWIN_O_NOFOLLOW | DARWIN_O_CLOEXEC,
      0
    );
    if (descriptor >= 0) return descriptor;
    const errno = ffi.getInt32(errnoPointer);
    throw Object.assign(
      new Error(`openat failed (errno=${errno}).`),
      { errno, code: errnoCode(errno) }
    );
  } finally {
    library.lib.close();
  }
}
