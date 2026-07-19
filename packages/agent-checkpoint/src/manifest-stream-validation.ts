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
 * Only the active ancestor chain remains live, so memory is bounded by path
 * depth rather than manifest cardinality.
 */
export class OrderedCheckpointManifestValidator {
  private readonly ancestors: CheckpointEntry[] = [];
  private previousPath: string | undefined;
  private itemCount = 0;
  private byteCount = 0;

  add(entry: CheckpointEntry): void {
    validateCheckpointEntry(entry);
    if (this.previousPath !== undefined && this.previousPath >= entry.path) {
      throw new CheckpointConflictError(`Checkpoint manifest is not strictly ordered: ${entry.path}`);
    }
    while (this.ancestors.length > 0
      && !entry.path.startsWith(`${this.ancestors.at(-1)!.path}/`)) {
      this.ancestors.pop();
    }
    const ancestor = this.ancestors.at(-1);
    if (ancestor && ancestor.kind !== "directory") {
      throw new CheckpointConflictError(`Checkpoint path has a non-directory ancestor: ${entry.path}`);
    }
    if (entry.path !== ".") this.ancestors.push(entry);
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
}
