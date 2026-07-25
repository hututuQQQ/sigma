import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { STORE_LAYOUT_VERSION } from "agent-protocol";

function unsupportedStoreLayout(layoutPath: string, actual: string): Error {
  return Object.assign(
    new Error(
      `unsupported_store_layout: store expected v${STORE_LAYOUT_VERSION}, received ${actual} at ${layoutPath}; existing data was not modified`
    ),
    { code: "unsupported_store_layout", path: layoutPath, expected: STORE_LAYOUT_VERSION, actual }
  );
}

export function safeId(value: string): string {
  if (value === "." || value === ".." || value.length > 128 || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Unsafe session identifier: ${value}`);
  }
  return value;
}

export function sessionDirectory(rootDir: string, sessionId: string): string {
  return path.join(storeVersionDirectory(rootDir), "sessions", safeId(sessionId));
}

export function storeVersionDirectory(rootDir: string): string {
  return path.join(path.resolve(rootDir), "stores", `v${STORE_LAYOUT_VERSION}`);
}

export function sessionsDirectory(rootDir: string): string {
  return path.join(storeVersionDirectory(rootDir), "sessions");
}

export async function assertCurrentStoreLayout(rootDir: string): Promise<void> {
  const resolved = path.resolve(rootDir);
  const unversionedSessions = path.join(resolved, "sessions");
  const hasUnversionedSessions = await stat(unversionedSessions)
    .then((value) => value.isDirectory(), (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  if (hasUnversionedSessions) {
    throw unsupportedStoreLayout(unversionedSessions, "unversioned");
  }

  const stores = path.join(resolved, "stores");
  const entries = await readdir(stores, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  const expected = `v${STORE_LAYOUT_VERSION}`;
  const unsupported = entries
    .filter((entry) => entry.isDirectory() && entry.name !== expected)
    .map((entry) => entry.name)
    .sort()[0];
  if (unsupported) throw unsupportedStoreLayout(path.join(stores, unsupported), unsupported);
}

export function segmentName(index: number): string {
  return `${String(index).padStart(6, "0")}.jsonl`;
}

export function snapshotName(seq: number): string {
  return `${String(seq).padStart(12, "0")}.json`;
}
