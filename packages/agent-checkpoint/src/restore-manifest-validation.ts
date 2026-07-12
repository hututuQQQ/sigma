import path from "node:path";
import { CheckpointConflictError, type CheckpointEntry, type CheckpointManifest } from "./types.js";

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function entryEqual(left: CheckpointEntry | undefined, right: CheckpointEntry | undefined): boolean {
  if (!left || !right) return left === right;
  const fields = ["path", "kind", "mode", "size", "digest", "linkTarget", "linkType"] as const;
  return fields.every((field) => left[field] === right[field]);
}

export function manifestEqual(left: CheckpointManifest, right: CheckpointManifest): boolean {
  if (left.fileCount !== right.fileCount || left.totalBytes !== right.totalBytes
    || left.entries.length !== right.entries.length) return false;
  const rightByPath = new Map(right.entries.map((entry) => [entry.path, entry]));
  return left.entries.every((entry) => entryEqual(entry, rightByPath.get(entry.path)));
}

function validateEntry(entry: CheckpointEntry): void {
  const normalized = path.posix.normalize(entry.path);
  if (!entry.path || path.posix.isAbsolute(entry.path) || normalized !== entry.path
    || entry.path === ".." || entry.path.startsWith("../") || entry.path.includes("\\")) {
    throw new CheckpointConflictError(`Checkpoint manifest contains an unsafe path: ${entry.path}`);
  }
  if (!Number.isSafeInteger(entry.mode) || !Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new CheckpointConflictError(`Checkpoint manifest metadata is invalid: ${entry.path}`);
  }
  if (entry.kind === "file" && !/^[a-f0-9]{64}$/u.test(entry.digest ?? "")) {
    throw new CheckpointConflictError(`Checkpoint file digest is invalid: ${entry.path}`);
  }
  if (entry.kind === "symlink" && typeof entry.linkTarget !== "string") {
    throw new CheckpointConflictError(`Checkpoint symlink target is invalid: ${entry.path}`);
  }
  validateLinkType(entry);
}

function validateLinkType(entry: CheckpointEntry): void {
  if (entry.linkType !== undefined && !["file", "directory"].includes(entry.linkType)) {
    throw new CheckpointConflictError(`Checkpoint symlink type is invalid: ${entry.path}`);
  }
}

export function validateManifest(manifest: CheckpointManifest): void {
  const byPath = new Map<string, CheckpointEntry>();
  let totalBytes = 0;
  for (const entry of manifest.entries) {
    validateEntry(entry);
    if (byPath.has(entry.path)) throw new CheckpointConflictError(`Duplicate checkpoint path: ${entry.path}`);
    byPath.set(entry.path, entry);
    if (entry.kind === "file") totalBytes += entry.size;
  }
  for (const entry of manifest.entries) {
    for (let parent = path.posix.dirname(entry.path); parent !== "."; parent = path.posix.dirname(parent)) {
      const ancestor = byPath.get(parent);
      if (ancestor && ancestor.kind !== "directory") {
        throw new CheckpointConflictError(`Checkpoint path has a non-directory ancestor: ${entry.path}`);
      }
    }
  }
  if (manifest.fileCount !== manifest.entries.length || manifest.totalBytes !== totalBytes) {
    throw new CheckpointConflictError("Checkpoint manifest totals are inconsistent.");
  }
}
