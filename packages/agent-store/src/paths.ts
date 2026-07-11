import path from "node:path";
import { STORE_LAYOUT_VERSION } from "agent-protocol";

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

/** V2 is read-only and intentionally remains outside the V3 store tree. */
export function legacySessionDirectoryV2(rootDir: string, sessionId: string): string {
  return path.join(path.resolve(rootDir), "sessions", safeId(sessionId));
}

export function legacySessionsDirectoryV2(rootDir: string): string {
  return path.join(path.resolve(rootDir), "sessions");
}

export function segmentName(index: number): string {
  return `${String(index).padStart(6, "0")}.jsonl`;
}

export function snapshotName(seq: number): string {
  return `${String(seq).padStart(12, "0")}.json`;
}
