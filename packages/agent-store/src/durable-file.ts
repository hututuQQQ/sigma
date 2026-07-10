import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export type AtomicReplace = (source: string, target: string) => Promise<void>;

const TRANSIENT_REPLACE_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
const REPLACE_RETRY_DEADLINE_MS = 2_000;
const UNSUPPORTED_DIRECTORY_SYNC = new Set(["EPERM", "EINVAL", "ENOTSUP", "EISDIR"]);

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function replaceWithRetry(source: string, target: string, replaceFile: AtomicReplace): Promise<void> {
  const deadline = Date.now() + REPLACE_RETRY_DEADLINE_MS;
  let delay = 5;
  while (true) {
    try {
      await replaceFile(source, target);
      return;
    } catch (error) {
      const transient = TRANSIENT_REPLACE_ERRORS.has(String((error as { code?: unknown }).code));
      if (!transient || Date.now() >= deadline) throw error;
      await wait(Math.min(delay, Math.max(1, deadline - Date.now())));
      delay = Math.min(100, delay * 2);
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r").catch(() => null);
  try {
    await handle?.sync().catch((error: unknown) => {
      if (!UNSUPPORTED_DIRECTORY_SYNC.has(String((error as { code?: unknown }).code))) throw error;
    });
  } finally {
    await handle?.close();
  }
}

export async function atomicJson(
  filePath: string,
  value: unknown,
  replaceFile: AtomicReplace = rename
): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await replaceWithRetry(temporary, filePath, replaceFile);
    await syncDirectory(directory);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
