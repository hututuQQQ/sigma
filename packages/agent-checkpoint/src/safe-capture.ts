import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readlink, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { portable } from "./manifest.js";
import { windowsLinkType } from "./windows-link-type.js";
import { pinCheckpointParent, type PinnedCheckpointParent } from "./path-safety.js";
import {
  CheckpointConflictError,
  CheckpointLimitError,
  type CheckpointCasIdentity,
  type CheckpointEntry,
  type CheckpointManifest
} from "./types.js";

export interface CachedCheckpointFile {
  entry: CheckpointEntry;
  sourceIdentity: CheckpointCasIdentity;
}

export interface CheckpointCaptureCache {
  files: Map<string, CachedCheckpointFile>;
}

interface CaptureOptions {
  workspacePath: string;
  scopePaths: readonly string[];
  maxFiles: number;
  maxBytes: number;
  excludedNames: ReadonlySet<string>;
  ignoredRootName?: string;
  cache?: CheckpointCaptureCache;
  assertReusableCas?(entry: CheckpointEntry): Promise<void>;
  putCas(content: AsyncIterable<Uint8Array>): Promise<{
    digest: string;
    size: number;
    identity: CheckpointCasIdentity;
  }>;
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

function identity(info: BigIntStats): CheckpointCasIdentity {
  return {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    mode: info.mode.toString(),
    size: info.size.toString(),
    mtimeNs: info.mtimeNs.toString(),
    ctimeNs: info.ctimeNs.toString()
  };
}

function sameIdentity(left: CheckpointCasIdentity, right: CheckpointCasIdentity): boolean {
  const fields = ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"] as const;
  return fields.every((field) => left[field] === right[field]);
}

function excluded(options: CaptureOptions, portablePath: string): boolean {
  if (options.ignoredRootName
    && (portablePath === options.ignoredRootName || portablePath.startsWith(`${options.ignoredRootName}/`))) return true;
  return portablePath !== "." && portablePath.split("/").some((part) => options.excludedNames.has(part));
}

async function existingInfo(target: string): Promise<BigIntStats | null> {
  return await lstat(target, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function captureStableFile(
  pinned: PinnedCheckpointParent,
  expected: BigIntStats,
  portablePath: string,
  putCas: CaptureOptions["putCas"]
): Promise<{
  digest: string;
  size: number;
  identity: CheckpointCasIdentity;
  sourceIdentity: CheckpointCasIdentity;
}> {
  const handle = await open(pinned.targetPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error) => {
    throw new CheckpointConflictError(`Checkpoint file could not be opened without following links: ${portablePath}`, {
      cause: error
    });
  });
  try {
    const before = identity(await handle.stat({ bigint: true }));
    if (!sameIdentity(before, identity(expected))) {
      throw new CheckpointConflictError(`Checkpoint file changed before capture: ${portablePath}`);
    }
    const beforeSize = Number(expected.size);
    const content = (async function* (): AsyncGenerator<Buffer> {
      let position = 0;
      const readLimit = beforeSize + 1;
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
    const after = identity(await handle.stat({ bigint: true }));
    if (!sameIdentity(before, after) || stored.size.toString() !== after.size) {
      throw new CheckpointConflictError(`Checkpoint file changed during capture: ${portablePath}`);
    }
    await pinned.verify();
    return { ...stored, sourceIdentity: after };
  } finally {
    await handle.close();
  }
}

async function pinDirectory(options: CaptureOptions, portablePath: string): Promise<PinnedCheckpointParent> {
  const probe = portablePath === "." ? ".sigma-checkpoint-directory-probe" : `${portablePath}/.sigma-checkpoint-directory-probe`;
  return await pinCheckpointParent(options.workspacePath, probe);
}

class CheckpointCapture {
  private readonly entries = new Map<string, CheckpointEntry>();
  private readonly previousFiles: ReadonlyMap<string, CachedCheckpointFile>;
  private readonly nextFiles = new Map<string, CachedCheckpointFile>();
  private totalBytes = 0;

  constructor(private readonly options: CaptureOptions) {
    this.previousFiles = new Map(options.cache?.files ?? []);
  }

  async run(): Promise<CheckpointManifest> {
    for (const scope of this.options.scopePaths) await this.visit(scope);
    const ordered = [...this.entries.values()].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    if (this.options.cache) this.options.cache.files = this.nextFiles;
    return { entries: ordered, fileCount: ordered.length, totalBytes: this.totalBytes };
  }

  private reserve(portablePath: string): void {
    if (!this.entries.has(portablePath) && this.entries.size >= this.options.maxFiles) {
      throw new CheckpointLimitError(`Checkpoint exceeds ${this.options.maxFiles} entries.`);
    }
  }

  private async visitDirectory(
    relative: string,
    portablePath: string,
    expected: BigIntStats
  ): Promise<void> {
    const pinned = await pinDirectory(this.options, portablePath);
    try {
      await pinned.verify();
      const before = identity(await stat(pinned.parentPath, { bigint: true }));
      if (!sameIdentity(before, identity(expected))) {
        throw new CheckpointConflictError(`Checkpoint directory changed before capture: ${portablePath}`);
      }
      this.reserve(portablePath);
      this.entries.set(portablePath, { path: portablePath, kind: "directory", mode: Number(expected.mode), size: 0 });
      const children = await readdir(pinned.parentPath);
      children.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      for (const child of children) await this.visit(portable(path.join(relative, child)));
      const after = identity(await stat(pinned.parentPath, { bigint: true }));
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
    info: BigIntStats,
    portablePath: string
  ): Promise<void> {
    const linkTarget = await readlink(pinned.targetPath);
    const linkType = process.platform === "win32" ? windowsLinkType(pinned.targetPath) : undefined;
    const after = await lstat(pinned.targetPath, { bigint: true });
    if (!sameIdentity(identity(info), identity(after))) {
      throw new CheckpointConflictError(`Checkpoint symlink changed during capture: ${portablePath}`);
    }
    this.entries.set(portablePath, {
      path: portablePath, kind: "symlink", mode: Number(info.mode), size: Number(info.size), linkTarget,
      ...(linkType ? { linkType } : {})
    });
  }

  private async captureFile(
    pinned: PinnedCheckpointParent,
    info: BigIntStats,
    portablePath: string
  ): Promise<void> {
    const expectedSize = Number(info.size);
    preflightCheckpointByteReservation({
      maxBytes: this.options.maxBytes,
      totalBytes: this.totalBytes,
      expectedSize
    });
    const sourceIdentity = identity(info);
    const cached = this.previousFiles.get(portablePath);
    if (cached?.entry.kind === "file"
      && cached.entry.casIdentity
      && this.options.assertReusableCas
      && sameIdentity(cached.sourceIdentity, sourceIdentity)) {
      await this.options.assertReusableCas(cached.entry);
      const after = await lstat(pinned.targetPath, { bigint: true });
      if (!sameIdentity(sourceIdentity, identity(after))) {
        throw new CheckpointConflictError(`Checkpoint file changed while reusing capture: ${portablePath}`);
      }
      await pinned.verify();
      const entry = { ...cached.entry };
      this.totalBytes += entry.size;
      this.entries.set(portablePath, entry);
      this.nextFiles.set(portablePath, { entry, sourceIdentity });
      return;
    }
    const stored = await captureStableFile(pinned, info, portablePath, this.options.putCas);
    this.totalBytes += stored.size;
    const entry: CheckpointEntry = {
      path: portablePath, kind: "file", mode: Number(info.mode), size: stored.size,
      digest: stored.digest, casIdentity: stored.identity
    };
    this.entries.set(portablePath, entry);
    this.nextFiles.set(portablePath, { entry, sourceIdentity: stored.sourceIdentity });
  }

  private async visit(relative: string): Promise<void> {
    const portablePath = portable(relative);
    if (excluded(this.options, portablePath)) return;
    if (portablePath === ".") {
      const info = await lstat(this.options.workspacePath, { bigint: true });
      await this.visitDirectory(relative, portablePath, info);
      return;
    }
    const pinned = await pinCheckpointParent(this.options.workspacePath, portablePath);
    try {
      await pinned.verify();
      const info = await existingInfo(pinned.targetPath);
      if (!info) return;
      this.reserve(portablePath);
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
    const directoryInfo = await lstat(
      path.join(this.options.workspacePath, ...portablePath.split("/")),
      { bigint: true }
    );
    await this.visitDirectory(relative, portablePath, directoryInfo);
  }
}

/** Capture without following a final link; Linux directory traversal is fd-anchored. */
export async function captureCheckpointManifest(options: CaptureOptions): Promise<CheckpointManifest> {
  return await new CheckpointCapture(options).run();
}
