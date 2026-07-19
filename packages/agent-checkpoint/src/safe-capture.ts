import { constants } from "node:fs";
import { lstat, open, opendir, readlink, stat } from "node:fs/promises";
import path from "node:path";
import { portable } from "./manifest.js";
import { windowsLinkType } from "./windows-link-type.js";
import { pinCheckpointParent, type PinnedCheckpointParent } from "./path-safety.js";
import {
  CheckpointConflictError,
  CheckpointLimitError,
  type CheckpointCasIdentity,
  type CheckpointEntry,
  type CheckpointManifest,
  type CheckpointRootIdentity
} from "./types.js";

export interface CaptureOptions {
  workspacePath: string;
  scopePaths: readonly string[];
  maxFiles: number;
  maxBytes: number;
  excludedNames: ReadonlySet<string>;
  /** Trusted roots absent at checkpoint creation. Capture only their stable
   * directory entry; their contents are disposable and reproducible. */
  reproducibleRootPaths?: ReadonlySet<string>;
  ignoredRootName?: string;
  putCas(content: AsyncIterable<Uint8Array>): Promise<{
    digest: string;
    size: number;
    identity: CheckpointCasIdentity;
  }>;
}

export interface CheckpointCaptureSummary {
  fileCount: number;
  totalBytes: number;
}

export type CheckpointEntrySink = (entry: CheckpointEntry) => void | Promise<void>;

interface FileIdentity {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

/**
 * Validate a prospective file-size reservation without reading or allocating
 * the file. Kept as a pure numeric seam so very large boundaries can be tested
 * on filesystems that do not support sparse files.
 */
export function preflightCheckpointByteReservation(input: {
  maxBytes: number;
  totalBytes: number;
  expectedSize: number;
}): void {
  const { maxBytes, totalBytes, expectedSize } = input;
  const validMaximum = maxBytes === Number.POSITIVE_INFINITY
    || (Number.isSafeInteger(maxBytes) && maxBytes >= 0);
  if (!validMaximum
    || !Number.isSafeInteger(totalBytes) || totalBytes < 0
    || !Number.isSafeInteger(expectedSize) || expectedSize < 0
    || (maxBytes !== Number.POSITIVE_INFINITY
      && (totalBytes > maxBytes || expectedSize > maxBytes - totalBytes))) {
    throw new CheckpointLimitError(`Checkpoint exceeds ${maxBytes} preimage bytes.`);
  }
}

function identity(info: Awaited<ReturnType<typeof lstat>>): FileIdentity {
  return {
    dev: Number(info.dev), ino: Number(info.ino), mode: Number(info.mode),
    size: Number(info.size), mtimeMs: Number(info.mtimeMs), ctimeMs: Number(info.ctimeMs)
  };
}

function rootIdentity(info: Awaited<ReturnType<typeof lstat>>): CheckpointRootIdentity {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    birthtimeMs: String(info.birthtimeMs)
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function excluded(options: CaptureOptions, portablePath: string): boolean {
  if (options.ignoredRootName
    && (portablePath === options.ignoredRootName || portablePath.startsWith(`${options.ignoredRootName}/`))) return true;
  return portablePath !== "." && portablePath.split("/").some((part) => options.excludedNames.has(part));
}

async function existingInfo(target: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  return await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function captureStableFile(
  pinned: PinnedCheckpointParent,
  expected: Awaited<ReturnType<typeof lstat>>,
  portablePath: string,
  putCas: CaptureOptions["putCas"]
): Promise<{ digest: string; size: number; identity: CheckpointCasIdentity }> {
  const handle = await open(pinned.targetPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error) => {
    throw new CheckpointConflictError(`Checkpoint file could not be opened without following links: ${portablePath}`, {
      cause: error
    });
  });
  try {
    const before = identity(await handle.stat());
    if (!sameIdentity(before, identity(expected))) {
      throw new CheckpointConflictError(`Checkpoint file changed before capture: ${portablePath}`);
    }
    const content = (async function* (): AsyncGenerator<Buffer> {
      let position = 0;
      const readLimit = before.size + 1;
      while (position < readLimit) {
        const length = Math.min(64 * 1024, readLimit - position);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (bytesRead <= 0) return;
        position += bytesRead;
        yield bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead);
      }
    })();
    const stored = await putCas(content);
    const after = identity(await handle.stat());
    if (!sameIdentity(before, after) || stored.size !== after.size) {
      throw new CheckpointConflictError(`Checkpoint file changed during capture: ${portablePath}`);
    }
    await pinned.verify();
    return stored;
  } finally {
    await handle.close();
  }
}

async function pinDirectory(options: CaptureOptions, portablePath: string): Promise<PinnedCheckpointParent> {
  const probe = portablePath === "." ? ".sigma-checkpoint-directory-probe" : `${portablePath}/.sigma-checkpoint-directory-probe`;
  return await pinCheckpointParent(options.workspacePath, probe);
}

class CheckpointCapture {
  private fileCount = 0;
  private totalBytes = 0;

  constructor(
    private readonly options: CaptureOptions,
    private readonly sink: CheckpointEntrySink
  ) {}

  async run(): Promise<CheckpointCaptureSummary> {
    for (const scope of captureScopes(this.options.scopePaths)) await this.visit(scope);
    return { fileCount: this.fileCount, totalBytes: this.totalBytes };
  }

  private async emit(entry: CheckpointEntry): Promise<void> {
    if (this.fileCount >= this.options.maxFiles) {
      throw new CheckpointLimitError(`Checkpoint exceeds ${this.options.maxFiles} entries.`);
    }
    this.fileCount += 1;
    await this.sink(entry);
  }

  private async visitDirectory(
    relative: string,
    portablePath: string,
    expected: Awaited<ReturnType<typeof lstat>>
  ): Promise<void> {
    const pinned = await pinDirectory(this.options, portablePath);
    try {
      await pinned.verify();
      const before = identity(await stat(pinned.parentPath));
      if (!sameIdentity(before, identity(expected))) {
        throw new CheckpointConflictError(`Checkpoint directory changed before capture: ${portablePath}`);
      }
      await this.emit({ path: portablePath, kind: "directory", mode: Number(expected.mode), size: 0 });
      const children = await opendir(pinned.parentPath);
      try {
        for await (const child of children) await this.visit(portable(path.join(relative, child.name)));
      } finally {
        await children.close().catch(() => undefined);
      }
      const after = identity(await stat(pinned.parentPath));
      if (!sameIdentity(before, after)) {
        throw new CheckpointConflictError(`Checkpoint directory changed during capture: ${portablePath}`);
      }
      await pinned.verify();
    } finally {
      await pinned.close();
    }
  }

  private async captureSymlink(
    pinned: PinnedCheckpointParent,
    info: Awaited<ReturnType<typeof lstat>>,
    portablePath: string
  ): Promise<void> {
    const linkTarget = await readlink(pinned.targetPath);
    const linkType = process.platform === "win32" ? windowsLinkType(pinned.targetPath) : undefined;
    const after = await lstat(pinned.targetPath);
    if (!sameIdentity(identity(info), identity(after))) {
      throw new CheckpointConflictError(`Checkpoint symlink changed during capture: ${portablePath}`);
    }
    await this.emit({
      path: portablePath, kind: "symlink", mode: Number(info.mode), size: Number(info.size), linkTarget,
      ...(linkType ? { linkType } : {})
    });
  }

  private async captureFile(
    pinned: PinnedCheckpointParent,
    info: Awaited<ReturnType<typeof lstat>>,
    portablePath: string
  ): Promise<void> {
    const expectedSize = Number(info.size);
    preflightCheckpointByteReservation({
      maxBytes: this.options.maxBytes,
      totalBytes: this.totalBytes,
      expectedSize
    });
    const stored = await captureStableFile(pinned, info, portablePath, this.options.putCas);
    this.totalBytes += stored.size;
    await this.emit({
      path: portablePath, kind: "file", mode: Number(info.mode), size: stored.size,
      digest: stored.digest, casIdentity: stored.identity
    });
  }

  private async captureReproducibleRoot(
    pinned: PinnedCheckpointParent,
    info: Awaited<ReturnType<typeof lstat>>,
    portablePath: string
  ): Promise<void> {
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new CheckpointConflictError(
        `Checkpoint reproducible root is not a real directory: ${portablePath}`
      );
    }
    const before = identity(info);
    const after = await lstat(pinned.targetPath);
    if (!after.isDirectory() || after.isSymbolicLink()
      || !sameIdentity(before, identity(after))) {
      throw new CheckpointConflictError(
        `Checkpoint reproducible root changed during shallow capture: ${portablePath}`
      );
    }
    await pinned.verify();
    await this.emit({
      path: portablePath,
      kind: "reproducible_root",
      mode: Number(after.mode),
      size: 0,
      rootIdentity: rootIdentity(after)
    });
  }

  private async visit(relative: string): Promise<void> {
    const portablePath = portable(relative);
    if (excluded(this.options, portablePath)) return;
    if (portablePath === ".") {
      const info = await lstat(this.options.workspacePath);
      await this.visitDirectory(relative, portablePath, info);
      return;
    }
    const pinned = await pinCheckpointParent(this.options.workspacePath, portablePath);
    try {
      await pinned.verify();
      const info = await existingInfo(pinned.targetPath);
      if (!info) return;
      if (this.options.reproducibleRootPaths?.has(portablePath)) {
        await this.captureReproducibleRoot(pinned, info, portablePath);
        return;
      }
      if (info.isSymbolicLink()) {
        await this.captureSymlink(pinned, info, portablePath);
        return;
      }
      if (info.isFile()) {
        await this.captureFile(pinned, info, portablePath);
        return;
      }
      if (!info.isDirectory()) throw new Error(`Unsupported checkpoint entry type: ${portablePath}`);
    } finally {
      await pinned.close();
    }
    const directoryInfo = await lstat(path.join(this.options.workspacePath, ...portablePath.split("/")));
    await this.visitDirectory(relative, portablePath, directoryInfo);
  }
}

function captureScopes(values: readonly string[]): string[] {
  const ordered = [...new Set(values.map(portable))].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0);
  const disjoint: string[] = [];
  for (const value of ordered) {
    const parent = disjoint.at(-1);
    if (parent === "." || (parent && value.startsWith(`${parent}/`))) continue;
    disjoint.push(value);
  }
  return disjoint;
}

/** Capture entries one at a time. Traversal order is intentionally not part
 * of the contract; a persistent sink must canonicalize with bounded runs. */
export async function captureCheckpointEntries(
  options: CaptureOptions,
  sink: CheckpointEntrySink
): Promise<CheckpointCaptureSummary> {
  return await new CheckpointCapture(options, sink).run();
}

/** Capture without following a final link; Linux directory traversal is fd-anchored. */
export async function captureCheckpointManifest(options: CaptureOptions): Promise<CheckpointManifest> {
  const entries: CheckpointEntry[] = [];
  const summary = await captureCheckpointEntries(options, (entry) => { entries.push(entry); });
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { entries, ...summary };
}
