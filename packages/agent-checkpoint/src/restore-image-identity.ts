import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, readdir } from "node:fs/promises";
import path from "node:path";
import {
  CheckpointConflictError,
  type CheckpointEntry,
  type CheckpointManifest,
  type CheckpointRootIdentity
} from "./types.js";
import { windowsLinkType } from "./windows-link-type.js";

export interface RestoreImageIdentity {
  kind: CheckpointEntry["kind"];
  mode: number;
  size: number;
  /** File bytes, link metadata, or the complete directory tree, depending on kind. */
  digest: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface StablePathIdentity {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function stableIdentity(info: Awaited<ReturnType<typeof lstat>>): StablePathIdentity {
  return {
    dev: Number(info.dev), ino: Number(info.ino), mode: Number(info.mode), size: Number(info.size),
    mtimeMs: Number(info.mtimeMs), ctimeMs: Number(info.ctimeMs)
  };
}

function sameStableIdentity(left: StablePathIdentity, right: StablePathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function digestLink(entry: Pick<CheckpointEntry, "mode" | "size" | "linkTarget" | "linkType">): string {
  return createHash("sha256").update(JSON.stringify([
    entry.mode, entry.size, entry.linkTarget ?? null, entry.linkType ?? null
  ])).digest("hex");
}

function digestReproducibleRoot(mode: number, identity: CheckpointRootIdentity): string {
  return createHash("sha256").update(JSON.stringify([
    "reproducible_root", mode, identity.dev, identity.ino, identity.birthtimeMs
  ])).digest("hex");
}

function directoryDigest(entries: readonly CheckpointEntry[], root: string): string {
  const relevant = entries
    .filter((entry) => root === "." || entry.path === root || entry.path.startsWith(`${root}/`))
    .sort((left, right) => compareText(left.path, right.path));
  // Keep the historical JSON-array digest byte-for-byte compatible while
  // feeding one entry at a time. Large trees never become one giant string.
  const hash = createHash("sha256");
  hash.update("[");
  for (const [index, entry] of relevant.entries()) {
    if (index > 0) hash.update(",");
    const value: unknown[] = [
      entry.path === root ? "." : path.posix.relative(root, entry.path),
      entry.kind, entry.mode, entry.size, entry.digest ?? null,
      entry.linkTarget ?? null, entry.linkType ?? null
    ];
    if (entry.kind === "reproducible_root") value.push(entry.rootIdentity ?? null);
    hash.update(JSON.stringify(value));
  }
  hash.update("]");
  return hash.digest("hex");
}

/** Derives the exact image a single rename operation is expected to replace or install. */
export function restoreImageFromManifest(
  manifest: CheckpointManifest,
  root: string
): RestoreImageIdentity | undefined {
  const entry = manifest.entries.find((candidate) => candidate.path === root);
  if (!entry) return undefined;
  const digest = entry.kind === "file" ? entry.digest!
    : entry.kind === "symlink" ? digestLink(entry)
      : entry.kind === "reproducible_root" ? digestReproducibleRoot(entry.mode, entry.rootIdentity!)
        : directoryDigest(manifest.entries, root);
  return { kind: entry.kind, mode: entry.mode, size: entry.size, digest };
}

function actualEntry(
  root: string,
  target: string,
  info: Awaited<ReturnType<typeof lstat>>,
  digest?: string,
  linkTarget?: string,
  linkType?: "file" | "directory"
): CheckpointEntry {
  const relative = path.relative(root, target).split(path.sep).join("/");
  const kind: CheckpointEntry["kind"] = info.isSymbolicLink()
    ? "symlink"
    : info.isDirectory() ? "directory" : "file";
  return {
    path: relative || ".",
    kind,
    mode: Number(info.mode),
    size: info.isDirectory() && !info.isSymbolicLink() ? 0 : Number(info.size),
    ...(digest ? { digest } : {}),
    ...(linkTarget !== undefined ? { linkTarget } : {}),
    ...(linkType ? { linkType } : {})
  };
}

function actualWindowsLinkType(target: string): "file" | "directory" | undefined {
  return process.platform === "win32" ? windowsLinkType(target) : undefined;
}

type PathInfo = Awaited<ReturnType<typeof lstat>>;

async function inspectActualLink(
  root: string,
  target: string,
  entries: CheckpointEntry[],
  initial: PathInfo,
  before: StablePathIdentity
): Promise<void> {
  const linkTarget = await readlink(target);
  const linkType = actualWindowsLinkType(target);
  const after = await lstat(target);
  if (!sameStableIdentity(before, stableIdentity(after)) || !after.isSymbolicLink()) {
    throw new CheckpointConflictError(`Checkpoint path changed while its link identity was read: ${target}`);
  }
  entries.push(actualEntry(root, target, initial, undefined, linkTarget, linkType));
}

async function inspectActualFile(
  root: string,
  target: string,
  entries: CheckpointEntry[],
  initial: PathInfo,
  before: StablePathIdentity
): Promise<void> {
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = stableIdentity(await handle.stat());
    if (!sameStableIdentity(before, opened)) {
      throw new CheckpointConflictError(`Checkpoint path changed while its file identity was opened: ${target}`);
    }
    const hash = createHash("sha256");
    let position = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = stableIdentity(await handle.stat());
    if (!sameStableIdentity(opened, after) || position !== after.size) {
      throw new CheckpointConflictError(`Checkpoint file changed while its digest was read: ${target}`);
    }
    entries.push(actualEntry(root, target, initial, hash.digest("hex")));
  } finally {
    await handle.close();
  }
}

async function inspectActualEntries(
  root: string,
  target: string,
  entries: CheckpointEntry[]
): Promise<void> {
  const initial = await lstat(target);
  const before = stableIdentity(initial);
  if (initial.isSymbolicLink()) {
    await inspectActualLink(root, target, entries, initial, before);
    return;
  }
  if (initial.isFile()) {
    await inspectActualFile(root, target, entries, initial, before);
    return;
  }
  if (!initial.isDirectory()) {
    throw new CheckpointConflictError(`Checkpoint path has an unsupported kind: ${target}`);
  }
  entries.push(actualEntry(root, target, initial));
  const names = await readdir(target);
  names.sort(compareText);
  for (const name of names) await inspectActualEntries(root, path.join(target, name), entries);
  const after = await lstat(target);
  if (!after.isDirectory() || after.isSymbolicLink()
    || !sameStableIdentity(before, stableIdentity(after))) {
    throw new CheckpointConflictError(`Checkpoint directory changed while its tree digest was read: ${target}`);
  }
}

/** Reads a no-follow, race-checked identity suitable for commit and recovery CAS. */
async function inspectExactRestoreImage(target: string): Promise<RestoreImageIdentity | undefined> {
  const exists = await lstat(target).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (!exists) return undefined;
  const entries: CheckpointEntry[] = [];
  await inspectActualEntries(target, target, entries);
  const root = entries.find((entry) => entry.path === ".")!;
  const digest = root.kind === "file" ? root.digest!
    : root.kind === "symlink" ? digestLink(root)
      : directoryDigest(entries, ".");
  return { kind: root.kind, mode: root.mode, size: root.size, digest };
}

async function inspectReproducibleRoot(target: string): Promise<RestoreImageIdentity | undefined> {
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return {
      kind: info.isSymbolicLink() ? "symlink" : info.isFile() ? "file" : "directory",
      mode: Number(info.mode),
      size: Number(info.size),
      digest: "invalid-reproducible-root"
    };
  }
  const mode = Number(info.mode);
  const identity = {
    dev: String(info.dev),
    ino: String(info.ino),
    birthtimeMs: String(info.birthtimeMs)
  };
  return { kind: "reproducible_root", mode, size: 0, digest: digestReproducibleRoot(mode, identity) };
}

/** Uses a shallow, type-and-mode identity only for an already-attested
 * reproducible root. All other images retain exact recursive inspection. */
export async function inspectRestoreImage(
  target: string,
  expected?: RestoreImageIdentity
): Promise<RestoreImageIdentity | undefined> {
  return expected?.kind === "reproducible_root"
    ? await inspectReproducibleRoot(target)
    : await inspectExactRestoreImage(target);
}

export function restoreImagesEqual(
  left: RestoreImageIdentity | undefined,
  right: RestoreImageIdentity | undefined
): boolean {
  if (!left || !right) return left === right;
  return left.kind === right.kind && left.mode === right.mode
    && left.size === right.size && left.digest === right.digest;
}

export async function assertRestoreImage(
  target: string,
  expected: RestoreImageIdentity | undefined,
  message: string
): Promise<void> {
  const actual = await inspectRestoreImage(target, expected);
  if (!restoreImagesEqual(actual, expected)) {
    throw new CheckpointConflictError(message);
  }
}
