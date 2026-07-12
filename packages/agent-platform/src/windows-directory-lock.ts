import { createRequire } from "node:module";
import path from "node:path";
import { acquireWindowsDirectoryLockHelper } from "agent-execution";

type Handle = bigint;

interface DynamicLibrary {
  functions: {
    CreateFileW(
      path: Buffer,
      desiredAccess: number,
      shareMode: number,
      securityAttributes: null,
      creationDisposition: number,
      flagsAndAttributes: number,
      templateFile: null
    ): Handle;
    GetFileInformationByHandleEx(handle: Handle, infoClass: number, output: Buffer, size: number): number;
    CloseHandle(handle: Handle): number;
    GetLastError(): number;
  };
  lib: { close(): void };
}

interface NodeFfi {
  dlopen(path: string, symbols: Record<string, { arguments: string[]; return: string }>): DynamicLibrary;
}

const INVALID_HANDLE = (1n << 64n) - 1n;
const FILE_LIST_DIRECTORY = 0x0001;
const FILE_SHARE_READ = 0x0001;
const FILE_SHARE_WRITE = 0x0002;
const OPEN_EXISTING = 3;
const FILE_FLAG_BACKUP_SEMANTICS = 0x0200_0000;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x0020_0000;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x0400;
const FILE_ATTRIBUTE_TAG_INFO_CLASS = 9;

export interface WindowsDirectoryLock {
  close(): Promise<void>;
}

function openLibrary(): DynamicLibrary {
  const ffi = createRequire(import.meta.url)("node:ffi") as NodeFfi;
  return ffi.dlopen("kernel32.dll", {
    CreateFileW: {
      arguments: ["pointer", "uint32", "uint32", "pointer", "uint32", "uint32", "pointer"],
      return: "pointer"
    },
    GetFileInformationByHandleEx: {
      arguments: ["pointer", "uint32", "pointer", "uint32"], return: "int32"
    },
    CloseHandle: { arguments: ["pointer"], return: "int32" },
    GetLastError: { arguments: [], return: "uint32" }
  });
}

function directLock(paths: readonly string[]): WindowsDirectoryLock {
  const library = openLibrary();
  const handles: Handle[] = [];
  try {
    for (const target of paths) {
      const handle = library.functions.CreateFileW(
        Buffer.from(`${path.toNamespacedPath(target)}\0`, "utf16le"),
        FILE_LIST_DIRECTORY,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        null,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        null
      );
      if (handle === INVALID_HANDLE) {
        throw new Error(`Could not lock Windows directory '${target}' (win32=${library.functions.GetLastError()}).`);
      }
      const tag = Buffer.alloc(8);
      if (!library.functions.GetFileInformationByHandleEx(
        handle, FILE_ATTRIBUTE_TAG_INFO_CLASS, tag, tag.byteLength
      )) {
        library.functions.CloseHandle(handle);
        throw new Error(`Could not inspect Windows directory '${target}' (win32=${library.functions.GetLastError()}).`);
      }
      if ((tag.readUInt32LE(0) & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
        library.functions.CloseHandle(handle);
        throw new Error(`Windows directory is a reparse point: ${target}`);
      }
      handles.push(handle);
    }
  } catch (error) {
    for (const handle of handles.reverse()) library.functions.CloseHandle(handle);
    library.lib.close();
    throw error;
  }
  let closed = false;
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      for (const handle of handles.reverse()) library.functions.CloseHandle(handle);
      library.lib.close();
    }
  };
}

/**
 * Holds every directory without FILE_SHARE_DELETE. Windows then rejects a
 * concurrent rename/delete/junction swap until the mutation transaction ends.
 */
export async function lockWindowsDirectories(paths: readonly string[]): Promise<WindowsDirectoryLock> {
  if (process.platform !== "win32") return { close: async () => undefined };
  try {
    return directLock(paths);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_UNKNOWN_BUILTIN_MODULE") throw error;
    return await acquireWindowsDirectoryLockHelper(paths);
  }
}
