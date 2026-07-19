import { chmod, lstat, open, readFile, readlink, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { durableReplaceFile, syncDirectory } from "agent-platform";
import { AtomicPatchError } from "./atomic-patch-parser.js";

export type AtomicPatchRename = (source: string, destination: string) => Promise<void>;

function isCrossDevice(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EXDEV";
}

async function syncFile(target: string): Promise<void> {
  const handle = await open(target, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Move one prepared patch file or symlink, preserving rename semantics when the
 * endpoints share a mount. Linux bind mounts can report the same st_dev while
 * still rejecting rename(2) with EXDEV, so the fallback publishes a durable
 * copy at the destination before removing the source. The transaction journal
 * makes the brief duplicate state recoverable after process loss.
 */
export async function moveAtomicPatchPath(
  source: string,
  destination: string,
  renamePath: AtomicPatchRename = rename
): Promise<void> {
  try {
    await renamePath(source, destination);
    return;
  } catch (error) {
    if (!isCrossDevice(error)) throw error;
  }

  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), destination);
    await syncDirectory(path.dirname(destination));
  } else if (info.isFile()) {
    const mode = info.mode & 0o7777;
    await durableReplaceFile(destination, await readFile(source), { mode });
    await chmod(destination, mode);
    await syncFile(destination);
  } else {
    throw new AtomicPatchError("Atomic patch cross-mount moves support only regular files and symlinks.");
  }

  await rm(source, { force: false, recursive: false });
  await syncDirectory(path.dirname(source));
  await syncDirectory(path.dirname(destination));
}
