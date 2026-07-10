import path from "node:path";

export function safeId(value: string): string {
  if (value === "." || value === ".." || value.length > 128 || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Unsafe session identifier: ${value}`);
  }
  return value;
}

export function sessionDirectory(rootDir: string, sessionId: string): string {
  return path.join(path.resolve(rootDir), "sessions", safeId(sessionId));
}

export function segmentName(index: number): string {
  return `${String(index).padStart(6, "0")}.jsonl`;
}

export function snapshotName(seq: number): string {
  return `${String(seq).padStart(12, "0")}.json`;
}
