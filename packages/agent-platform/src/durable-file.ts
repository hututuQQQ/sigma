import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";

const UNSUPPORTED_DIRECTORY_SYNC = new Set(["EINVAL", "ENOTSUP", "EPERM", "EISDIR", "EBADF"]);

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r").catch((error: NodeJS.ErrnoException) => {
    if (UNSUPPORTED_DIRECTORY_SYNC.has(error.code ?? "")) return null;
    throw error;
  });
  if (!handle) return;
  try {
    await handle.sync().catch((error: NodeJS.ErrnoException) => {
      if (!UNSUPPORTED_DIRECTORY_SYNC.has(error.code ?? "")) throw error;
    });
  } finally {
    await handle.close();
  }
}

export async function durableReplaceFile(
  target: string,
  content: string | Uint8Array,
  options: { mode?: number } = {}
): Promise<void> {
  const resolved = path.resolve(target);
  const temporary = `${resolved}.${randomUUID()}.tmp`;
  let published = false;
  try {
    const handle = await open(temporary, "wx", options.mode ?? 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, resolved);
    published = true;
    await syncDirectory(path.dirname(resolved));
  } finally {
    if (!published) await rm(temporary, { force: true }).catch(() => undefined);
  }
}
