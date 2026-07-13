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

/** Legacy V2 data is detected only so callers can fail without modifying it. */
export function legacySessionDirectoryV2(rootDir: string, sessionId: string): string {
  return path.join(path.resolve(rootDir), "sessions", safeId(sessionId));
}

export function legacySessionsDirectoryV2(rootDir: string): string {
  return path.join(path.resolve(rootDir), "sessions");
}

/** Legacy V3 data is detected only so callers can fail without modifying it. */
export function legacySessionDirectoryV3(rootDir: string, sessionId: string): string {
  return path.join(path.resolve(rootDir), "stores", "v3", "sessions", safeId(sessionId));
}

export function segmentName(index: number): string {
  return `${String(index).padStart(6, "0")}.jsonl`;
}

export function snapshotName(seq: number): string {
  return `${String(seq).padStart(12, "0")}.json`;
}
