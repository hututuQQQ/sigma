import path from "node:path";
import type { WorkspaceTransactionDirectoryLease } from "agent-platform";
import {
  decodeStableBoundedText,
  type StableTextRead
} from "./repository-path-metadata.js";
import { safeAutomaticFilePath } from "./repository-path-safety.js";

const rejectedRead = (): StableTextRead => ({ content: null, rejected: true });

export interface RepositorySnapshotAccess {
  readText(relative: string, maxBytes: number, signal: AbortSignal): Promise<StableTextRead>;
}

/** Reads direct children through directory descriptors held by one host snapshot. */
export class HostRepositorySnapshotAccess implements RepositorySnapshotAccess {
  private readonly directories = new Map<string, {
    directory: string;
    lease: WorkspaceTransactionDirectoryLease;
  }>();
  private files = new Set<string>();
  private closed = false;

  bindDirectory(
    relative: string,
    lease: WorkspaceTransactionDirectoryLease,
    directory: string
  ): void {
    if (this.closed) throw new Error("Repository snapshot access is closed.");
    this.directories.set(relative, { directory, lease });
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
    const boundParent = this.directories.get(parent === "." ? "" : parent);
    if (!boundParent) return rejectedRead();
    return decodeStableBoundedText(await boundParent.lease.readDirectoryFile(
      boundParent.directory,
      path.posix.basename(normalized),
      maxBytes,
      signal
    ));
  }

  close(): void {
    this.closed = true;
    this.files.clear();
    this.directories.clear();
  }
}
