import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pinCheckpointParent } from "./path-safety.js";
import {
  CheckpointConflictError,
  CheckpointRecoveryError,
  type CheckpointEntry,
  type CheckpointManifest,
  type CheckpointRestoreFaultEvent
} from "./types.js";
import { stageRestoreEntry, validateRestoreCas, type RestoreCasReader } from "./restore-cas.js";

interface RestoreOperation {
  path: string;
  index: number;
  current?: CheckpointEntry;
  desired?: CheckpointEntry;
  stagePath?: string;
  backupPath: string;
  backupMoved: boolean;
  installed: boolean;
  backupIntent: boolean;
  installIntent: boolean;
}

export interface RestoreTransactionOptions {
  workspacePath: string;
  desired: CheckpointManifest;
  current: CheckpointManifest;
  readCas: RestoreCasReader;
  capture(ignoredRootName?: string): Promise<CheckpointManifest>;
  finalize?: () => Promise<void>;
  faultInjector?: (event: CheckpointRestoreFaultEvent) => void | Promise<void>;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function entryEqual(left: CheckpointEntry | undefined, right: CheckpointEntry | undefined): boolean {
  if (!left || !right) return left === right;
  const fields = ["path", "kind", "mode", "size", "digest", "linkTarget", "linkType"] as const;
  return fields.every((field) => left[field] === right[field]);
}

function manifestEqual(left: CheckpointManifest, right: CheckpointManifest): boolean {
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

function validateManifest(manifest: CheckpointManifest): void {
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

function structuralChange(current: CheckpointEntry | undefined, desired: CheckpointEntry | undefined): boolean {
  if (!current || !desired || current.kind !== desired.kind) return true;
  return current.kind !== "directory" && !entryEqual(current, desired);
}

function operationPaths(current: CheckpointManifest, desired: CheckpointManifest): string[] {
  const currentByPath = new Map(current.entries.map((entry) => [entry.path, entry]));
  const desiredByPath = new Map(desired.entries.map((entry) => [entry.path, entry]));
  const candidates = [...new Set([...currentByPath.keys(), ...desiredByPath.keys()])]
    .filter((name) => name !== "." && structuralChange(currentByPath.get(name), desiredByPath.get(name)))
    .sort((left, right) => left.split("/").length - right.split("/").length || compareText(left, right));
  return candidates.filter((name, index) => !candidates.slice(0, index).some((parent) => name.startsWith(`${parent}/`)));
}

async function windowsSymlinkType(
  options: RestoreTransactionOptions,
  entry: CheckpointEntry
): Promise<"file" | "junction" | undefined> {
  if (process.platform !== "win32" || entry.kind !== "symlink") return undefined;
  if (entry.linkType) return entry.linkType === "directory" ? "junction" : "file";
  // Compatibility for checkpoints captured before linkType was persisted.
  const originalTarget = path.resolve(options.workspacePath, path.dirname(entry.path), entry.linkTarget!);
  const info = await stat(originalTarget).catch(() => null);
  return info?.isDirectory() ? "junction" : "file";
}

async function stageOperation(
  options: RestoreTransactionOptions,
  operation: RestoreOperation,
  desired: CheckpointManifest
): Promise<void> {
  if (!operation.desired || !operation.stagePath) return;
  const entries = desired.entries.filter((entry) => entry.path === operation.path || entry.path.startsWith(`${operation.path}/`))
    .sort((left, right) => left.path.split("/").length - right.path.split("/").length || compareText(left.path, right.path));
  for (const entry of entries) {
    const suffix = entry.path === operation.path ? "" : path.posix.relative(operation.path, entry.path);
    const target = suffix ? path.join(operation.stagePath, ...suffix.split("/")) : operation.stagePath;
    await stageRestoreEntry(options.readCas, target, entry, await windowsSymlinkType(options, entry));
  }
  for (const entry of [...entries].reverse()) {
    if (entry.kind !== "directory") continue;
    const suffix = entry.path === operation.path ? "" : path.posix.relative(operation.path, entry.path);
    const target = suffix ? path.join(operation.stagePath, ...suffix.split("/")) : operation.stagePath;
    await chmod(target, entry.mode);
  }
}

async function createOperations(
  options: RestoreTransactionOptions,
  transactionPath: string
): Promise<RestoreOperation[]> {
  const currentByPath = new Map(options.current.entries.map((entry) => [entry.path, entry]));
  const desiredByPath = new Map(options.desired.entries.map((entry) => [entry.path, entry]));
  const operations = operationPaths(options.current, options.desired).map((name, index): RestoreOperation => ({
    path: name,
    index,
    current: currentByPath.get(name),
    desired: desiredByPath.get(name),
    ...(desiredByPath.has(name) ? { stagePath: path.join(transactionPath, "stage", String(index)) } : {}),
    backupPath: path.join(transactionPath, "backup", String(index)),
    backupMoved: false,
    installed: false,
    backupIntent: false,
    installIntent: false
  }));
  await mkdir(path.join(transactionPath, "stage"), { recursive: true });
  await mkdir(path.join(transactionPath, "backup"), { recursive: true });
  for (const operation of operations) await stageOperation(options, operation, options.desired);
  return operations;
}

async function fault(options: RestoreTransactionOptions, event: CheckpointRestoreFaultEvent): Promise<void> {
  await options.faultInjector?.(event);
}

async function pathExists(target: string): Promise<boolean> {
  return await lstat(target).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

function journalValue(phase: string, operations: RestoreOperation[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    phase,
    operations: operations.map((operation) => ({
      path: operation.path,
      index: operation.index,
      hadCurrent: Boolean(operation.current),
      hasDesired: Boolean(operation.desired),
      backupMoved: operation.backupMoved,
      installed: operation.installed,
      backupIntent: operation.backupIntent,
      installIntent: operation.installIntent
    }))
  }, null, 2);
}

async function writeJournal(transactionPath: string, phase: string, operations: RestoreOperation[]): Promise<void> {
  const target = path.join(transactionPath, "journal.json");
  const temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(journalValue(phase, operations), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  await syncDirectory(transactionPath);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r").catch((error: NodeJS.ErrnoException) => {
    if (["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(error.code ?? "")) return null;
    throw error;
  });
  if (!handle) return;
  try {
    await handle.sync().catch((error: NodeJS.ErrnoException) => {
      if (!["EINVAL", "ENOTSUP", "EPERM"].includes(error.code ?? "")) throw error;
    });
  } finally { await handle.close(); }
}

async function ensureInternalDirectory(workspacePath: string, relative: string): Promise<void> {
  const pinned = await pinCheckpointParent(workspacePath, relative);
  try {
    await pinned.verify();
    const existing = await lstat(pinned.targetPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!existing) await mkdir(pinned.targetPath);
    const installed = await lstat(pinned.targetPath);
    if (!installed.isDirectory() || installed.isSymbolicLink()) {
      throw new CheckpointConflictError(`Checkpoint transaction directory is unsafe: ${relative}`);
    }
    await pinned.verify();
  } finally {
    await pinned.close();
  }
}

async function createTransactionDirectory(workspacePath: string): Promise<string> {
  await ensureInternalDirectory(workspacePath, ".agent");
  await ensureInternalDirectory(workspacePath, ".agent/checkpoint-transactions");
  const transactions = path.join(workspacePath, ".agent", "checkpoint-transactions");
  return await mkdtemp(path.join(transactions, "restore-"));
}

async function commitOperation(
  options: RestoreTransactionOptions,
  operation: RestoreOperation,
  transactionPath: string,
  operations: RestoreOperation[]
): Promise<void> {
  const pinned = await pinCheckpointParent(options.workspacePath, operation.path);
  try {
    await pinned.verify();
    const exists = await pathExists(pinned.targetPath);
    if (exists !== Boolean(operation.current)) {
      throw new CheckpointConflictError(`Checkpoint target changed before commit: ${operation.path}`);
    }
    if (operation.current) {
      operation.backupIntent = true;
      await writeJournal(transactionPath, "applying", operations);
      await rename(pinned.targetPath, operation.backupPath);
      operation.backupMoved = true;
      await syncDirectory(pinned.parentPath);
      await syncDirectory(path.dirname(operation.backupPath));
      await writeJournal(transactionPath, "applying", operations);
      await fault(options, { point: "after_backup", path: operation.path, operationIndex: operation.index });
    }
    if (operation.stagePath) {
      operation.installIntent = true;
      await writeJournal(transactionPath, "applying", operations);
      await rename(operation.stagePath, pinned.targetPath);
      operation.installed = true;
      await syncDirectory(pinned.parentPath);
      await syncDirectory(path.dirname(operation.stagePath));
      await writeJournal(transactionPath, "applying", operations);
      await fault(options, { point: "after_install", path: operation.path, operationIndex: operation.index });
    }
    await pinned.verify();
  } finally {
    await pinned.close();
  }
}

async function applyDirectoryModes(options: RestoreTransactionOptions, manifest: CheckpointManifest): Promise<void> {
  const directories = manifest.entries.filter((entry) => entry.kind === "directory" && entry.path !== ".")
    .sort((left, right) => right.path.split("/").length - left.path.split("/").length);
  for (const entry of directories) {
    const pinned = await pinCheckpointParent(options.workspacePath, entry.path);
    try {
      await pinned.verify();
      await chmod(pinned.targetPath, entry.mode);
      await pinned.verify();
    } finally {
      await pinned.close();
    }
  }
}

async function rollback(
  options: RestoreTransactionOptions,
  operations: RestoreOperation[],
  transactionPath: string
): Promise<void> {
  await fault(options, { point: "before_rollback" });
  await writeJournal(transactionPath, "rolling_back", operations);
  for (const operation of [...operations].reverse()) {
    if (!operation.backupMoved && !operation.installed) continue;
    const pinned = await pinCheckpointParent(options.workspacePath, operation.path);
    try {
      await pinned.verify();
      if (operation.installed) await rm(pinned.targetPath, { recursive: true, force: true });
      if (operation.backupMoved) {
        await fault(options, { point: "before_rollback_restore", path: operation.path, operationIndex: operation.index });
        await rename(operation.backupPath, pinned.targetPath);
      }
      operation.installed = false;
      operation.backupMoved = false;
      operation.installIntent = false;
      operation.backupIntent = false;
      await writeJournal(transactionPath, "rolling_back", operations);
      await pinned.verify();
    } finally {
      await pinned.close();
    }
  }
  await applyDirectoryModes(options, options.current);
  const restored = await options.capture();
  if (!manifestEqual(restored, options.current)) {
    throw new CheckpointConflictError("Checkpoint rollback did not restore the complete current image.");
  }
}

/** Apply a multi-path restore with staged replacements, rename backups, and verified rollback. */
export async function restoreCheckpointTransaction(options: RestoreTransactionOptions): Promise<void> {
  validateManifest(options.desired);
  validateManifest(options.current);
  await validateRestoreCas(options.desired, options.readCas);
  if (!manifestEqual(await options.capture(), options.current)) {
    throw new CheckpointConflictError("Workspace changed before checkpoint restore staging.");
  }
  const transactionPath = await createTransactionDirectory(options.workspacePath);
  let operations: RestoreOperation[] = [];
  let finalized = false;
  try {
    operations = await createOperations(options, transactionPath);
    await writeJournal(transactionPath, "staged", operations);
    await fault(options, { point: "before_commit" });
    if (!manifestEqual(await options.capture(), options.current)) {
      throw new CheckpointConflictError("Workspace changed while checkpoint restore was staged.");
    }
    for (const operation of operations) await commitOperation(options, operation, transactionPath, operations);
    await applyDirectoryModes(options, options.desired);
    if (!manifestEqual(await options.capture(), options.desired)) {
      throw new CheckpointConflictError("Workspace does not match the complete restored checkpoint image.");
    }
    await writeJournal(transactionPath, "verified", operations);
    await fault(options, { point: "before_record" });
    await options.finalize?.();
    finalized = true;
    await writeJournal(transactionPath, "finalized", operations);
    await rm(transactionPath, { recursive: true, force: true });
  } catch (error) {
    if (finalized) {
      throw new CheckpointRecoveryError(
        "Checkpoint restore committed, but its internal transaction journal could not be removed.",
        transactionPath,
        error
      );
    }
    const changed = operations.some((operation) => operation.backupMoved || operation.installed);
    if (!changed) {
      await rm(transactionPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    try {
      await rollback(options, operations, transactionPath);
      await rm(transactionPath, { recursive: true, force: true });
    } catch (rollbackError) {
      throw new CheckpointRecoveryError(
        "Checkpoint restore failed and its rollback could not be verified; manual recovery is required.",
        transactionPath,
        new AggregateError([error, rollbackError])
      );
    }
    throw error;
  }
}
