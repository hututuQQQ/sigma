import path from "node:path";
import {
  readStableBoundedText,
  safeAutomaticFilePath,
  type StableTextRead
} from "./repository-path-metadata.js";

const rejectedRead = (): StableTextRead => ({ content: null, rejected: true });

export interface RepositorySnapshotAccess {
  readText(relative: string, maxBytes: number, signal: AbortSignal): Promise<StableTextRead>;
}

/** Reads direct children through directory descriptors held by one host snapshot. */
export class HostRepositorySnapshotAccess implements RepositorySnapshotAccess {
  private readonly directories = new Map<string, string>();
  private files = new Set<string>();
  private closed = false;

  bindDirectory(relative: string, pinnedPath: string): void {
    if (this.closed) throw new Error("Repository snapshot access is closed.");
    this.directories.set(relative, pinnedPath);
  }

  restrictFiles(files: readonly string[]): void {
    if (this.closed) throw new Error("Repository snapshot access is closed.");
    this.files = new Set(files);
  }

  async readText(relative: string, maxBytes: number, signal: AbortSignal): Promise<StableTextRead> {
    signal.throwIfAborted();
    if (this.closed) throw new Error("Repository snapshot access is closed.");
    if (!safeAutomaticFilePath(relative) || !this.files.has(relative)) return rejectedRead();
    const normalized = relative.replaceAll("\\", "/");
    if (normalized !== relative) return rejectedRead();
    const parent = path.posix.dirname(normalized);
    const pinnedParent = this.directories.get(parent === "." ? "" : parent);
    if (!pinnedParent) return rejectedRead();
    return await readStableBoundedText(
      path.join(pinnedParent, path.posix.basename(normalized)), maxBytes, signal
    );
  }

  close(): void {
    this.closed = true;
    this.files.clear();
    this.directories.clear();
  }
}
