import { constants, type Stats } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { AtomicPatchError } from "./atomic-patch-parser.js";
import type { PatchOriginalFile } from "./atomic-patch-types.js";

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function emptyPatchFile(): PatchOriginalFile {
  return {
    exists: false, kind: "file", content: "", bytes: Buffer.alloc(0),
    mode: 0o100644, eol: "\n", finalNewline: false
  };
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameVersion(left: Stats, right: Stats): boolean {
  return sameIdentity(left, right) && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function decodeText(bytes: Buffer, relative: string): string {
  if (bytes.includes(0)) throw new AtomicPatchError(`Binary patching is not supported: ${relative}`);
  try {
    return UTF8.decode(bytes);
  } catch (error) {
    throw new AtomicPatchError(`Patch source is not valid UTF-8: ${relative}`, {
      cause: error instanceof Error ? error : undefined
    });
  }
}

async function readRegularFile(
  absolute: string,
  relative: string,
  initial: Stats
): Promise<PatchOriginalFile> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(absolute, flags).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ELOOP") {
      throw new AtomicPatchError(`Patch source changed into a symbolic link: ${relative}`, { cause: error });
    }
    throw error;
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameIdentity(initial, before)) {
      throw new AtomicPatchError(`Patch source changed while it was being opened: ${relative}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameVersion(before, after)) {
      throw new AtomicPatchError(`Patch source changed while it was being read: ${relative}`);
    }
    const content = decodeText(bytes, relative);
    return {
      exists: true, kind: "file", content, bytes, mode: before.mode,
      eol: content.includes("\r\n") ? "\r\n" : "\n", finalNewline: /\r?\n$/u.test(content)
    };
  } finally {
    await handle.close();
  }
}

async function readSymlink(
  absolute: string,
  relative: string,
  initial: Stats
): Promise<PatchOriginalFile> {
  const content = await readlink(absolute);
  const after = await lstat(absolute);
  if (!after.isSymbolicLink() || !sameIdentity(initial, after)) {
    throw new AtomicPatchError(`Patch symlink changed while it was being read: ${relative}`);
  }
  return {
    exists: true, kind: "symlink", content, bytes: Buffer.from(content, "utf8"),
    mode: 0o120000, eol: "\n", finalNewline: false
  };
}

export async function readPatchPath(absolute: string, relative: string): Promise<PatchOriginalFile> {
  const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return emptyPatchFile();
  if (info.isSymbolicLink()) return await readSymlink(absolute, relative, info);
  if (!info.isFile()) throw new AtomicPatchError(`Patch source is not a regular file: ${relative}`);
  return await readRegularFile(absolute, relative, info);
}

export async function readPatchFile(
  workspace: string,
  relative: string | undefined
): Promise<PatchOriginalFile> {
  if (!relative) return emptyPatchFile();
  return await readPatchPath(path.join(workspace, ...relative.split("/")), relative);
}

export function samePatchFile(current: PatchOriginalFile, original: PatchOriginalFile): boolean {
  return current.exists && current.kind === original.kind
    && (current.mode & 0o7777) === (original.mode & 0o7777)
    && current.bytes.equals(original.bytes);
}
