import { chmod, lstat, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { durableReplaceFile, pinWorkspaceTransactionDirectories, syncDirectory } from "agent-platform";
import { assertRestoreImage, restoreImageFromManifest } from "./restore-image-identity.js";
import { compareText, entryEqual, manifestEqual } from "./restore-manifest-validation.js";
import { pinCheckpointParent } from "./path-safety.js";
import { stageRestoreEntry } from "./restore-cas.js";
import type {
  RestoreDirectoryMode,
  RestoreOperation,
  RestoreTransactionOptions
} from "./restore-transaction-types.js";
import {
  CheckpointConflictError,
  type CheckpointEntry,
  type CheckpointManifest
} from "./types.js";
import type { CheckpointRestoreFaultEvent } from "./fault-injection.js";

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

export async function createOperations(
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
    installIntent: false,
    ...(currentByPath.has(name) ? { currentImage: restoreImageFromManifest(options.current, name) } : {}),
    ...(desiredByPath.has(name) ? { installedImage: restoreImageFromManifest(options.desired, name) } : {})
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

function journalValue(
  phase: string,
  operations: RestoreOperation[],
  options: RestoreTransactionOptions
): string {
  const current = new Map(options.current.entries
    .filter((entry) => entry.kind === "directory" && entry.path !== ".")
    .map((entry) => [entry.path, entry.mode]));
  const desired = new Map(options.desired.entries
    .filter((entry) => entry.kind === "directory" && entry.path !== ".")
    .map((entry) => [entry.path, entry.mode]));
  const directoryModes: RestoreDirectoryMode[] = [...new Set([...current.keys(), ...desired.keys()])]
    .sort(compareText)
    .map((entryPath) => ({
      path: entryPath,
      ...(current.has(entryPath) ? { currentMode: current.get(entryPath) } : {}),
      ...(desired.has(entryPath) ? { desiredMode: desired.get(entryPath) } : {})
    }));
  return JSON.stringify({
    schemaVersion: 3,
    phase,
    finalization: options.finalization,
    directoryModes,
    operations: operations.map((operation) => ({
      path: operation.path,
      index: operation.index,
      hadCurrent: Boolean(operation.current),
      hasDesired: Boolean(operation.desired),
      backupMoved: operation.backupMoved,
      installed: operation.installed,
      backupIntent: operation.backupIntent,
      installIntent: operation.installIntent,
      ...(operation.currentImage ? { currentImage: operation.currentImage } : {}),
      ...(operation.installedImage ? { installedImage: operation.installedImage } : {})
    }))
  }, null, 2);
}

export async function writeJournal(
  transactionPath: string,
  phase: string,
  operations: RestoreOperation[],
  options: RestoreTransactionOptions
): Promise<void> {
  const target = path.join(transactionPath, "journal.json");
  await durableReplaceFile(target, journalValue(phase, operations, options), { mode: 0o600 });
}

export async function commitOperation(
  options: RestoreTransactionOptions,
  operation: RestoreOperation,
  transactionPath: string,
  operations: RestoreOperation[],
  verifyTransaction: () => Promise<void>
): Promise<void> {
  const pinned = await pinCheckpointParent(options.workspacePath, operation.path);
  try {
    await pinned.verify();
    await assertRestoreImage(
      pinned.targetPath,
      operation.currentImage,
      `Checkpoint target changed before commit: ${operation.path}`
    );
    if (operation.current) {
      operation.backupIntent = true;
      await writeJournal(transactionPath, "applying", operations, options);
      await fault(options, { point: "before_backup_move", path: operation.path, operationIndex: operation.index });
      await verifyTransaction();
      await pinned.verify();
      await assertRestoreImage(
        pinned.targetPath,
        operation.currentImage,
        `Checkpoint target changed immediately before commit: ${operation.path}`
      );
      await rename(pinned.targetPath, operation.backupPath);
      operation.backupMoved = true;
      await syncDirectory(pinned.parentPath);
      await syncDirectory(path.dirname(operation.backupPath));
      await writeJournal(transactionPath, "applying", operations, options);
      await fault(options, { point: "after_backup", path: operation.path, operationIndex: operation.index });
    }
    if (operation.stagePath) {
      await assertRestoreImage(
        operation.stagePath,
        operation.installedImage,
        `Checkpoint staged postimage changed before commit: ${operation.path}`
      );
      operation.installIntent = true;
      await writeJournal(transactionPath, "applying", operations, options);
      await fault(options, { point: "before_install_move", path: operation.path, operationIndex: operation.index });
      await verifyTransaction();
      await pinned.verify();
      await assertRestoreImage(
        pinned.targetPath,
        undefined,
        `Checkpoint install target was occupied immediately before commit: ${operation.path}`
      );
      await assertRestoreImage(
        operation.stagePath,
        operation.installedImage,
        `Checkpoint staged postimage changed immediately before commit: ${operation.path}`
      );
      await rename(operation.stagePath, pinned.targetPath);
      await assertRestoreImage(
        pinned.targetPath,
        operation.installedImage,
        `Checkpoint installed postimage changed during commit: ${operation.path}`
      );
      operation.installed = true;
      await syncDirectory(pinned.parentPath);
      await syncDirectory(path.dirname(operation.stagePath));
      await writeJournal(transactionPath, "applying", operations, options);
      await fault(options, { point: "after_install", path: operation.path, operationIndex: operation.index });
    }
    await pinned.verify();
  } finally {
    await pinned.close();
  }
}

export async function applyDirectoryModes(
  options: RestoreTransactionOptions,
  manifest: CheckpointManifest
): Promise<void> {
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

export async function rollback(
  options: RestoreTransactionOptions,
  operations: RestoreOperation[],
  transactionPath: string
): Promise<void> {
  const lease = await pinWorkspaceTransactionDirectories([
    transactionPath, path.join(transactionPath, "stage"), path.join(transactionPath, "backup")
  ]);
  try {
    await fault(options, { point: "before_rollback" });
    await lease.verify();
    await writeJournal(transactionPath, "rolling_back", operations, options);
    for (const operation of [...operations].reverse()) {
      if (!operation.backupMoved && !operation.installed) continue;
      const pinned = await pinCheckpointParent(options.workspacePath, operation.path);
      try {
        await pinned.verify();
        await lease.verify();
        if (operation.installed && await pathExists(pinned.targetPath)) {
          await assertRestoreImage(
            pinned.targetPath,
            operation.installedImage,
            `Checkpoint installed postimage changed before rollback: ${operation.path}`
          );
          await pinned.verify();
          await rm(pinned.targetPath, { recursive: true, force: true });
          await syncDirectory(pinned.parentPath);
        }
        if (operation.backupMoved) {
          await fault(options, { point: "before_rollback_restore", path: operation.path, operationIndex: operation.index });
          await lease.verify();
          await assertRestoreImage(
            pinned.targetPath,
            undefined,
            `Checkpoint rollback destination is occupied: ${operation.path}`
          );
          await assertRestoreImage(
            operation.backupPath,
            operation.currentImage,
            `Checkpoint rollback backup changed: ${operation.path}`
          );
          await pinned.verify();
          await rename(operation.backupPath, pinned.targetPath);
          await syncDirectory(pinned.parentPath);
          await syncDirectory(path.dirname(operation.backupPath));
        }
        operation.installed = false;
        operation.backupMoved = false;
        operation.installIntent = false;
        operation.backupIntent = false;
        await writeJournal(transactionPath, "rolling_back", operations, options);
        await lease.verify();
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
  } finally {
    await lease.close();
  }
}
