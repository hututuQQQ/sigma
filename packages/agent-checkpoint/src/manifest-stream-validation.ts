import path from "node:path";
import { validateCheckpointEntry } from "./restore-manifest-validation.js";
import { CheckpointConflictError, type CheckpointEntry } from "./types.js";

export interface CheckpointManifestTotals {
  fileCount: number;
  totalBytes: number;
}

function validTotal(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validates a canonical path-ordered manifest without retaining a path map.
 * Non-directory candidates remain live only until their complete lexical
 * descendant range has passed, including punctuation-named sibling gaps.
 */
export class OrderedCheckpointManifestValidator {
  private readonly pendingNonDirectories = new Map<string, string>();
  private readonly expirations: Array<{ path: string; expiresAt: string }> = [];
  private previousPath: string | undefined;
  private itemCount = 0;
  private byteCount = 0;

  add(entry: CheckpointEntry): void {
    validateCheckpointEntry(entry);
    if (this.previousPath !== undefined && this.previousPath >= entry.path) {
      throw new CheckpointConflictError(`Checkpoint manifest is not strictly ordered: ${entry.path}`);
    }
    this.expireNonDirectories(entry.path);
    for (let parent = path.posix.dirname(entry.path); parent !== "."; parent = path.posix.dirname(parent)) {
      if (this.pendingNonDirectories.has(parent)) {
        throw new CheckpointConflictError(`Checkpoint path has a non-directory ancestor: ${entry.path}`);
      }
    }
    if (entry.path !== "." && entry.kind !== "directory") this.trackNonDirectory(entry.path);
    this.previousPath = entry.path;
    this.itemCount += 1;
    if (entry.kind === "file") this.byteCount += entry.size;
    if (!validTotal(this.itemCount) || !validTotal(this.byteCount)) {
      throw new CheckpointConflictError("Checkpoint manifest totals exceed safe integer bounds.");
    }
  }

  totals(): CheckpointManifestTotals {
    return { fileCount: this.itemCount, totalBytes: this.byteCount };
  }

  finish(expected: CheckpointManifestTotals): void {
    if (!validTotal(expected.fileCount) || !validTotal(expected.totalBytes)
      || expected.fileCount !== this.itemCount || expected.totalBytes !== this.byteCount) {
      throw new CheckpointConflictError("Checkpoint manifest totals are inconsistent.");
    }
  }

  private trackNonDirectory(entryPath: string): void {
    // Every descendant starts with `${entryPath}/`, which sorts before
    // `${entryPath}0`. Retain the entry across intervening punctuation-named
    // siblings, then discard it as soon as descendants are no longer possible.
    const expiresAt = `${entryPath}0`;
    this.pendingNonDirectories.set(entryPath, expiresAt);
    this.pushExpiration({ path: entryPath, expiresAt });
  }

  private expireNonDirectories(currentPath: string): void {
    while (this.expirations[0] && this.expirations[0].expiresAt <= currentPath) {
      const expired = this.popExpiration()!;
      if (this.pendingNonDirectories.get(expired.path) === expired.expiresAt) {
        this.pendingNonDirectories.delete(expired.path);
      }
    }
  }

  private pushExpiration(value: { path: string; expiresAt: string }): void {
    this.expirations.push(value);
    let index = this.expirations.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.expirations[parent]!.expiresAt <= value.expiresAt) break;
      this.expirations[index] = this.expirations[parent]!;
      index = parent;
    }
    this.expirations[index] = value;
  }

  private popExpiration(): { path: string; expiresAt: string } | undefined {
    const first = this.expirations[0];
    const last = this.expirations.pop();
    if (!first || !last || this.expirations.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.expirations.length) break;
      const right = left + 1;
      const child = right < this.expirations.length
        && this.expirations[right]!.expiresAt < this.expirations[left]!.expiresAt ? right : left;
      if (this.expirations[child]!.expiresAt >= last.expiresAt) break;
      this.expirations[index] = this.expirations[child]!;
      index = child;
    }
    this.expirations[index] = last;
    return first;
  }
}
