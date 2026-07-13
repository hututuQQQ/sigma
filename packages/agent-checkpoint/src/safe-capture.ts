import { constants } from "node:fs";
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

interface CaptureOptions {
  workspacePath: string;
  scopePaths: readonly string[];
  maxFiles: number;
  maxBytes: number;
  excludedNames: ReadonlySet<string>;
  ignoredRootName?: string;
  putCas(content: AsyncIterable<Uint8Array>): Promise<{
    digest: string;
    size: number;
    identity: CheckpointCasIdentity;
  }>;
}

interface FileIdentity {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function identity(info: Awaited<ReturnType<typeof lstat>>): FileIdentity {
  return {
    dev: Number(info.dev), ino: Number(info.ino), mode: Number(info.mode),
    size: Number(info.size), mtimeMs: Number(info.mtimeMs), ctimeMs: Number(info.ctimeMs)
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
  private readonly entries = new Map<string, CheckpointEntry>();
  private totalBytes = 0;

  constructor(private readonly options: CaptureOptions) {}

  async run(): Promise<CheckpointManifest> {
    for (const scope of this.options.scopePaths) await this.visit(scope);
    const ordered = [...this.entries.values()].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
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
    expected: Awaited<ReturnType<typeof lstat>>
  ): Promise<void> {
    const pinned = await pinDirectory(this.options, portablePath);
    try {
      await pinned.verify();
      const before = identity(await stat(pinned.parentPath));
      if (!sameIdentity(before, identity(expected))) {
        throw new CheckpointConflictError(`Checkpoint directory changed before capture: ${portablePath}`);
      }
      this.reserve(portablePath);
      this.entries.set(portablePath, { path: portablePath, kind: "directory", mode: Number(expected.mode), size: 0 });
      const children = await readdir(pinned.parentPath);
      children.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      for (const child of children) await this.visit(portable(path.join(relative, child)));
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
    this.entries.set(portablePath, {
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
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0
      || expectedSize > this.options.maxBytes - this.totalBytes) {
      throw new CheckpointLimitError(`Checkpoint exceeds ${this.options.maxBytes} preimage bytes.`);
    }
    const stored = await captureStableFile(pinned, info, portablePath, this.options.putCas);
    this.totalBytes += stored.size;
    this.entries.set(portablePath, {
      path: portablePath, kind: "file", mode: Number(info.mode), size: stored.size,
      digest: stored.digest, casIdentity: stored.identity
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
    const directoryInfo = await lstat(path.join(this.options.workspacePath, ...portablePath.split("/")));
    await this.visitDirectory(relative, portablePath, directoryInfo);
  }
}

/** Capture without following a final link; Linux directory traversal is fd-anchored. */
export async function captureCheckpointManifest(options: CaptureOptions): Promise<CheckpointManifest> {
  return await new CheckpointCapture(options).run();
}
