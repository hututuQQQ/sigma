import { createRequire } from "node:module";

interface DynamicLibrary {
  functions: { GetFileAttributesW(path: Buffer): number };
  lib: { close(): void };
}

interface NodeFfi {
  dlopen(path: string, symbols: Record<string, { arguments: string[]; return: string }>): DynamicLibrary;
}

const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const INVALID_FILE_ATTRIBUTES = 0xffff_ffff;

/** Reads the reparse point's own directory attribute, which remains available for dangling links. */
export function windowsLinkType(target: string): "file" | "directory" {
  const ffi = createRequire(import.meta.url)("node:ffi") as NodeFfi;
  const library = ffi.dlopen("kernel32.dll", {
    GetFileAttributesW: { arguments: ["pointer"], return: "uint32" }
  });
  try {
    const attributes = library.functions.GetFileAttributesW(Buffer.from(`${target}\0`, "utf16le"));
    if (attributes === INVALID_FILE_ATTRIBUTES) {
      throw new Error(`Could not read Windows link attributes: ${target}`);
    }
    return (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0 ? "directory" : "file";
  } finally {
    library.lib.close();
  }
}
