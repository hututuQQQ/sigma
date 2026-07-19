import path from "node:path";
import { CheckpointConflictError, type CheckpointEntry, type CheckpointManifest } from "./types.js";

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function entryEqual(left: CheckpointEntry | undefined, right: CheckpointEntry | undefined): boolean {
  if (!left || !right) return left === right;
  const fields = ["path", "kind", "mode", "size", "digest", "linkTarget", "linkType"] as const;
  return fields.every((field) => left[field] === right[field])
    && JSON.stringify(left.rootIdentity ?? null) === JSON.stringify(right.rootIdentity ?? null);
}

function entriesStrictlyOrdered(entries: readonly CheckpointEntry[]): boolean {
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.path >= entries[index]!.path) return false;
  }
  return true;
}

export function manifestEqual(left: CheckpointManifest, right: CheckpointManifest): boolean {
  if (left.fileCount !== right.fileCount || left.totalBytes !== right.totalBytes
    || left.entries.length !== right.entries.length) return false;
  if (entriesStrictlyOrdered(left.entries) && entriesStrictlyOrdered(right.entries)) {
    return left.entries.every((entry, index) => entryEqual(entry, right.entries[index]));
  }
  const rightByPath = new Map(right.entries.map((entry) => [entry.path, entry]));
  return left.entries.every((entry) => entryEqual(entry, rightByPath.get(entry.path)));
}

function validateEntryPath(entry: CheckpointEntry): void {
  const normalized = path.posix.normalize(entry.path);
  if (!entry.path || path.posix.isAbsolute(entry.path) || normalized !== entry.path
    || entry.path === ".." || entry.path.startsWith("../") || entry.path.includes("\\")) {
    throw new CheckpointConflictError(`Checkpoint manifest contains an unsafe path: ${entry.path}`);
  }
}

function validateEntryMetadata(entry: CheckpointEntry): void {
  if (!Number.isSafeInteger(entry.mode) || !Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new CheckpointConflictError(`Checkpoint manifest metadata is invalid: ${entry.path}`);
  }
  if (!["file", "directory", "symlink", "reproducible_root"].includes(entry.kind)) {
    throw new CheckpointConflictError(`Checkpoint manifest entry kind is invalid: ${entry.path}`);
  }
}

function validateReproducibleRoot(entry: CheckpointEntry): void {
  const rootIdentity = entry.rootIdentity;
  const validRootIdentity = rootIdentity && [rootIdentity.dev, rootIdentity.ino, rootIdentity.birthtimeMs]
    .every((value) => /^-?\d+(?:\.\d+)?$/u.test(value));
  if (entry.kind === "reproducible_root" && (entry.path === "." || entry.size !== 0
    || entry.digest !== undefined || entry.linkTarget !== undefined || entry.linkType !== undefined
    || !validRootIdentity)) {
    throw new CheckpointConflictError(`Checkpoint reproducible-root metadata is invalid: ${entry.path}`);
  }
  if (entry.kind !== "reproducible_root" && entry.rootIdentity !== undefined) {
    throw new CheckpointConflictError(`Checkpoint root identity is attached to an exact entry: ${entry.path}`);
  }
}

function validateEntryContent(entry: CheckpointEntry): void {
  if (entry.kind === "file" && !/^[a-f0-9]{64}$/u.test(entry.digest ?? "")) {
    throw new CheckpointConflictError(`Checkpoint file digest is invalid: ${entry.path}`);
  }
  if (entry.kind === "symlink" && typeof entry.linkTarget !== "string") {
    throw new CheckpointConflictError(`Checkpoint symlink target is invalid: ${entry.path}`);
  }
  validateReproducibleRoot(entry);
  validateLinkType(entry);
}

export function validateCheckpointEntry(entry: CheckpointEntry): void {
  validateEntryPath(entry);
  validateEntryMetadata(entry);
  validateEntryContent(entry);
}

function validateLinkType(entry: CheckpointEntry): void {
  if (entry.linkType !== undefined && !["file", "directory"].includes(entry.linkType)) {
    throw new CheckpointConflictError(`Checkpoint symlink type is invalid: ${entry.path}`);
  }
}

export function validateManifest(manifest: CheckpointManifest): void {
  if (entriesStrictlyOrdered(manifest.entries)) {
    validateOrderedManifest(manifest);
    return;
  }
  const byPath = new Map<string, CheckpointEntry>();
  let totalBytes = 0;
  for (const entry of manifest.entries) {
    validateCheckpointEntry(entry);
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

function validateOrderedManifest(manifest: CheckpointManifest): void {
  const ancestors: CheckpointEntry[] = [];
  let totalBytes = 0;
  for (const entry of manifest.entries) {
    validateCheckpointEntry(entry);
    while (ancestors.length > 0 && !entry.path.startsWith(`${ancestors.at(-1)!.path}/`)) {
      ancestors.pop();
    }
    const ancestor = ancestors.at(-1);
    if (ancestor && ancestor.kind !== "directory") {
      throw new CheckpointConflictError(`Checkpoint path has a non-directory ancestor: ${entry.path}`);
    }
    if (entry.path !== ".") ancestors.push(entry);
    if (entry.kind === "file") totalBytes += entry.size;
  }
  if (manifest.fileCount !== manifest.entries.length || manifest.totalBytes !== totalBytes) {
    throw new CheckpointConflictError("Checkpoint manifest totals are inconsistent.");
  }
}
