import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { lockWindowsDirectories, type WindowsDirectoryLock } from "agent-platform";
import { AtomicPatchError } from "./atomic-patch-parser.js";

export interface DirectoryIdentity { dev: number; ino: number; type: number }

export interface PinnedPatchParent {
  targetPath: string;
  verify(): Promise<void>;
  close(): Promise<void>;
}

export function directoryIdentity(info: Pick<Awaited<ReturnType<typeof lstat>>, "dev" | "ino" | "mode">): DirectoryIdentity {
  // birthtimeMs is not a stable identity on overlayfs and some container
  // filesystems. Device + inode + file type still detect replacement while
  // avoiding false positives caused by metadata projection differences.
  return { dev: Number(info.dev), ino: Number(info.ino), type: Number(info.mode) & 0o170000 };
}

export function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.type === right.type;
}

async function stableDirectory(target: string): Promise<DirectoryIdentity> {
  const info = await lstat(target).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new AtomicPatchError(`Patch parent is not a stable contained directory: ${target}`);
  }
  return directoryIdentity(info);
}

export async function pinPatchParent(workspace: string, relative: string): Promise<PinnedPatchParent> {
  const parts = relative.split("/").filter(Boolean);
  const name = parts.pop();
  if (!name) throw new AtomicPatchError("Patch cannot replace the workspace root.");
  const paths = [workspace, ...parts.map((_part, index) => path.join(workspace, ...parts.slice(0, index + 1)))];
  const identities: DirectoryIdentity[] = [];
  const handles: FileHandle[] = [];
  let windowsLock: WindowsDirectoryLock | undefined;
  let anchored = workspace;
  try {
    for (const [index, original] of paths.entries()) {
      const expected = await stableDirectory(original);
      identities.push(expected);
      if (process.platform !== "linux") continue;
      const candidate = index === 0 ? workspace : path.join(anchored, parts[index - 1]!);
      const handle = await open(candidate, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (!sameDirectoryIdentity(expected, directoryIdentity(await handle.stat()))) {
        await handle.close();
        throw new AtomicPatchError(`Patch parent changed while being pinned: ${original}`);
      }
      handles.push(handle);
      anchored = `/proc/self/fd/${handle.fd}`;
    }
    if (process.platform === "win32") windowsLock = await lockWindowsDirectories(paths);
    return {
      targetPath: path.join(process.platform === "linux" ? anchored : paths.at(-1)!, name),
      verify: async () => {
        for (const [index, original] of paths.entries()) {
          if (!sameDirectoryIdentity(identities[index]!, await stableDirectory(original))) {
            throw new AtomicPatchError(`Patch parent changed during commit: ${original}`);
          }
        }
      },
      close: async () => {
        await windowsLock?.close();
        for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
      }
    };
  } catch (error) {
    await windowsLock?.close();
    for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
    throw error;
  }
}
