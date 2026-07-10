import { unlink } from "node:fs/promises";

export type UnlinkFile = (filePath: string) => Promise<void>;

const TRANSIENT_UNLINK_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
const DEFAULT_DEADLINE_MS = 2_000;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function retryFilesystemOperation<T>(
  operation: () => Promise<T>,
  deadlineMs = DEFAULT_DEADLINE_MS
): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  let delay = 5;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      const code = String((error as { code?: unknown }).code);
      if (!TRANSIENT_UNLINK_ERRORS.has(code) || Date.now() >= deadline) throw error;
      await wait(Math.min(delay, Math.max(1, deadline - Date.now())));
      delay = Math.min(100, delay * 2);
    }
  }
}

export async function unlinkWithRetry(
  filePath: string,
  deadlineMs = DEFAULT_DEADLINE_MS,
  unlinkFile: UnlinkFile = unlink
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  let delay = 5;
  while (true) {
    try {
      await unlinkFile(filePath);
      return true;
    } catch (error) {
      const code = String((error as { code?: unknown }).code);
      if (code === "ENOENT") return false;
      if (!TRANSIENT_UNLINK_ERRORS.has(code) || Date.now() >= deadline) throw error;
      await wait(Math.min(delay, Math.max(1, deadline - Date.now())));
      delay = Math.min(100, delay * 2);
    }
  }
}
