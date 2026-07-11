import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { AtomicPatchError } from "./atomic-patch-parser.js";

interface DirectoryIdentity { dev: number; ino: number; mode: number; birthtimeMs: number }

export interface PinnedPatchParent {
  targetPath: string;
  verify(): Promise<void>;
  close(): Promise<void>;
}

function identity(info: Awaited<ReturnType<typeof lstat>>): DirectoryIdentity {
  return { dev: Number(info.dev), ino: Number(info.ino), mode: Number(info.mode), birthtimeMs: Number(info.birthtimeMs) };
}

function same(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.birthtimeMs === right.birthtimeMs;
}

async function stableDirectory(target: string): Promise<DirectoryIdentity> {
  const info = await lstat(target).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new AtomicPatchError(`Patch parent is not a stable contained directory: ${target}`);
  }
  return identity(info);
}

export async function pinPatchParent(workspace: string, relative: string): Promise<PinnedPatchParent> {
  const parts = relative.split("/").filter(Boolean);
  const name = parts.pop();
  if (!name) throw new AtomicPatchError("Patch cannot replace the workspace root.");
  const paths = [workspace, ...parts.map((_part, index) => path.join(workspace, ...parts.slice(0, index + 1)))];
  const identities: DirectoryIdentity[] = [];
  const handles: FileHandle[] = [];
  let anchored = workspace;
  try {
    for (const [index, original] of paths.entries()) {
      const expected = await stableDirectory(original);
      identities.push(expected);
      if (process.platform !== "linux") continue;
      const candidate = index === 0 ? workspace : path.join(anchored, parts[index - 1]!);
      const handle = await open(candidate, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (!same(expected, identity(await handle.stat()))) {
        await handle.close();
        throw new AtomicPatchError(`Patch parent changed while being pinned: ${original}`);
      }
      handles.push(handle);
      anchored = `/proc/self/fd/${handle.fd}`;
    }
    return {
      targetPath: path.join(process.platform === "linux" ? anchored : paths.at(-1)!, name),
      verify: async () => {
        for (const [index, original] of paths.entries()) {
          if (!same(identities[index]!, await stableDirectory(original))) {
            throw new AtomicPatchError(`Patch parent changed during commit: ${original}`);
          }
        }
      },
      close: async () => { for (const handle of handles.reverse()) await handle.close().catch(() => undefined); }
    };
  } catch (error) {
    for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
    throw error;
  }
}
