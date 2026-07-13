import { chmod, lstat, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  cleanupWorkspaceTransactionRoot,
  durableReplaceFile,
  pinWorkspaceTransactionDirectories,
  syncDirectory,
  type WorkspaceTransactionDirectoryLease
} from "agent-platform";
import { pinCheckpointParent } from "./path-safety.js";
import {
  readRecoveryJournal,
  type RecoveryJournal,
  type RecoveryOperation
} from "./restore-recovery-schema.js";
import {
  acquireCheckpointMutationLease,
  ensureCheckpointTransactionRoot,
  assertRestoreImage,
  inspectRestoreImage,
  restoreImagesEqual,
  type RestoreFinalization,
  type RestoreImageIdentity
} from "./restore-transaction.js";
import { CheckpointRecoveryError } from "./types.js";

export interface CheckpointTransactionRecoveryOptions {
  workspacePath: string;
  transactionRootDir: string;
  finalize(finalization: RestoreFinalization): Promise<void>;
}

async function recoveryDirectories(transactionPath: string): Promise<string[]> {
  const candidates = [
    transactionPath, path.join(transactionPath, "stage"), path.join(transactionPath, "backup")
  ];
  const directories: string[] = [];
  for (const candidate of candidates) {
    const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new CheckpointRecoveryError("Checkpoint transaction directory is unsafe.", transactionPath);
    }
    directories.push(candidate);
  }
  return directories;
}

async function writeRecoveryJournal(transactionPath: string, value: unknown): Promise<void> {
  await durableReplaceFile(
    path.join(transactionPath, "journal.json"), JSON.stringify(value, null, 2), { mode: 0o600 }
  );
}

type RecoveryFlag = "installed" | "installIntent" | "backupMoved" | "backupIntent";

async function clearRecoveryFlag(
  transactionPath: string,
  parsed: RecoveryJournal,
  operation: RecoveryOperation,
  flag: RecoveryFlag
): Promise<void> {
  if (operation[flag] === false) return;
  operation[flag] = false;
  await writeRecoveryJournal(transactionPath, parsed);
}

function validateRecoveryImages(
  transactionPath: string,
  operation: RecoveryOperation,
  stageImage: RestoreImageIdentity | undefined,
  backupImage: RestoreImageIdentity | undefined
): void {
  if (stageImage && !restoreImagesEqual(stageImage, operation.installedImage)) {
    throw new CheckpointRecoveryError("Checkpoint recovery stage image is invalid.", transactionPath);
  }
  if (backupImage && !restoreImagesEqual(backupImage, operation.currentImage)) {
    throw new CheckpointRecoveryError("Checkpoint recovery backup image is invalid.", transactionPath);
  }
}

async function recoverOperation(
  options: CheckpointTransactionRecoveryOptions,
  transactionPath: string,
  parsed: RecoveryJournal,
  operation: RecoveryOperation,
  lease: WorkspaceTransactionDirectoryLease
): Promise<void> {
  const pinned = await pinCheckpointParent(options.workspacePath, operation.path);
  try {
    await pinned.verify();
    await lease.verify();
    const stagePath = path.join(transactionPath, "stage", String(operation.index));
    const backupPath = path.join(transactionPath, "backup", String(operation.index));
    const [targetImage, stageImage, backupImage] = await Promise.all([
      inspectRestoreImage(pinned.targetPath),
      inspectRestoreImage(stagePath),
      inspectRestoreImage(backupPath)
    ]);
    validateRecoveryImages(transactionPath, operation, stageImage, backupImage);
    if (targetImage && restoreImagesEqual(targetImage, operation.installedImage)) {
      await lease.verify();
      await pinned.verify();
      await rm(pinned.targetPath, { recursive: true, force: true });
      await syncDirectory(pinned.parentPath);
    } else if (targetImage && !restoreImagesEqual(targetImage, operation.currentImage)) {
      throw new CheckpointRecoveryError("Checkpoint recovery target image is invalid.", transactionPath);
    }
    await clearRecoveryFlag(transactionPath, parsed, operation, "installed");
    await clearRecoveryFlag(transactionPath, parsed, operation, "installIntent");

    const currentTarget = await inspectRestoreImage(pinned.targetPath);
    const currentBackup = await inspectRestoreImage(backupPath);
    if (operation.currentImage) {
      if (!restoreImagesEqual(currentTarget, operation.currentImage)) {
        if (currentTarget || !restoreImagesEqual(currentBackup, operation.currentImage)) {
          throw new CheckpointRecoveryError("Checkpoint backup is missing during crash recovery.", transactionPath);
        }
        await lease.verify();
        await pinned.verify();
        await rename(backupPath, pinned.targetPath);
        await syncDirectory(pinned.parentPath);
        await syncDirectory(path.dirname(backupPath));
        await assertRestoreImage(
          pinned.targetPath,
          operation.currentImage,
          `Checkpoint current image was not restored during crash recovery: ${operation.path}`
        );
      } else if (currentBackup) {
        throw new CheckpointRecoveryError("Checkpoint recovery found duplicate current images.", transactionPath);
      }
    } else if (currentTarget || currentBackup) {
      throw new CheckpointRecoveryError("Checkpoint recovery found an unexpected current image.", transactionPath);
    }
    await clearRecoveryFlag(transactionPath, parsed, operation, "backupMoved");
    await clearRecoveryFlag(transactionPath, parsed, operation, "backupIntent");
    await pinned.verify();
  } finally {
    await pinned.close();
  }
}

async function recoverUnfinishedTransaction(
  options: CheckpointTransactionRecoveryOptions,
  transactionPath: string,
  parsed: RecoveryJournal,
  lease: WorkspaceTransactionDirectoryLease
): Promise<void> {
  if (parsed.schemaVersion !== 3) {
    throw new CheckpointRecoveryError(
      "Checkpoint recovery journal predates postimage identity checks and cannot be replayed safely.",
      transactionPath
    );
  }
  parsed.phase = "rolling_back";
  await writeRecoveryJournal(transactionPath, parsed);
  for (const operation of [...parsed.operations].reverse()) {
    await recoverOperation(options, transactionPath, parsed, operation, lease);
  }
  for (const directory of [...(parsed.directoryModes ?? [])]
    .sort((left, right) => right.path.split("/").length - left.path.split("/").length)) {
    if (directory.currentMode === undefined) continue;
    const pinned = await pinCheckpointParent(options.workspacePath, directory.path);
    try {
      await lease.verify();
      await pinned.verify();
      const info = await lstat(pinned.targetPath);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new CheckpointRecoveryError("Checkpoint recovery directory mode target is invalid.", transactionPath);
      }
      await chmod(pinned.targetPath, directory.currentMode);
      await syncDirectory(pinned.parentPath);
      await pinned.verify();
    } finally {
      await pinned.close();
    }
  }
}

async function finalizeVerifiedTransaction(
  options: CheckpointTransactionRecoveryOptions,
  transactionPath: string,
  parsed: RecoveryJournal,
  lease: WorkspaceTransactionDirectoryLease
): Promise<void> {
  if (parsed.schemaVersion === 1 || !parsed.finalization) {
    throw new CheckpointRecoveryError(
      "Checkpoint restore is verified but its legacy journal cannot finalize the checkpoint record automatically.",
      transactionPath
    );
  }
  await lease.verify();
  await options.finalize(parsed.finalization);
  await writeRecoveryJournal(transactionPath, { ...parsed, phase: "finalized" });
  await lease.verify();
}

async function replayRecoveryJournal(
  options: CheckpointTransactionRecoveryOptions,
  transactionPath: string,
  parsed: RecoveryJournal,
  lease: WorkspaceTransactionDirectoryLease
): Promise<void> {
  if (parsed.phase === "finalized") {
    await lease.verify();
    return;
  }
  if (parsed.phase === "verified") {
    await finalizeVerifiedTransaction(options, transactionPath, parsed, lease);
    return;
  }
  await recoverUnfinishedTransaction(options, transactionPath, parsed, lease);
}

async function recoverTransaction(
  options: CheckpointTransactionRecoveryOptions,
  transactionPath: string
): Promise<void> {
  const parsed = await readRecoveryJournal(transactionPath);
  const directories = await recoveryDirectories(transactionPath);
  const lease = await pinWorkspaceTransactionDirectories(directories);
  let primary: unknown;
  try {
    await replayRecoveryJournal(options, transactionPath, parsed, lease);
  } catch (error) {
    primary = error;
  } finally {
    if (primary === undefined) {
      await lease.verify().catch((error: unknown) => { primary = error; });
    }
    const closeError = await lease.close().then(() => undefined, (error: unknown) => error);
    if (closeError) {
      primary = new CheckpointRecoveryError(
        "Checkpoint crash recovery resource cleanup failed.",
        transactionPath,
        new AggregateError(primary === undefined ? [closeError] : [primary, closeError])
      );
    }
  }
  if (primary !== undefined) throw primary;
  await rm(transactionPath, { recursive: true, force: true });
}

/** Replays durable restore journals before a new checkpoint operation touches the workspace. */
export async function recoverCheckpointTransactions(
  options: CheckpointTransactionRecoveryOptions
): Promise<void> {
  let mutationLease: Awaited<ReturnType<typeof acquireCheckpointMutationLease>> | undefined;
  let primary: unknown;
  try {
    mutationLease = await acquireCheckpointMutationLease(options.transactionRootDir);
    await ensureCheckpointTransactionRoot(options.transactionRootDir);
    await recoverTransactionRoot(options, options.transactionRootDir);
  } catch (error) {
    primary = error;
  }
  const cleanupErrors: unknown[] = [];
  if (mutationLease) {
    await cleanupWorkspaceTransactionRoot(options.transactionRootDir).then(
      (warnings) => { cleanupErrors.push(...warnings); },
      (error: unknown) => { cleanupErrors.push(error); }
    );
    await mutationLease.release().catch((error: unknown) => { cleanupErrors.push(error); });
  }
  if (cleanupErrors.length > 0) {
    const recoveryPath = primary instanceof CheckpointRecoveryError
      ? primary.transactionPath
      : options.transactionRootDir;
    throw new CheckpointRecoveryError(
      "Checkpoint crash recovery cleanup failed; recovery data was preserved.",
      recoveryPath,
      new AggregateError(primary === undefined ? cleanupErrors : [primary, ...cleanupErrors])
    );
  }
  if (primary !== undefined) throw primary;
}

async function recoverTransactionRoot(
  options: CheckpointTransactionRecoveryOptions,
  root: string
): Promise<void> {
  const rootLease = await pinWorkspaceTransactionDirectories([root]);
  let primary: unknown;
  try {
    const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.name.startsWith("restore-")) continue;
      const transactionPath = path.join(root, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new CheckpointRecoveryError("Checkpoint transaction entry is unsafe.", transactionPath);
      }
      try {
        await rootLease.verify();
        await recoverTransaction(options, transactionPath);
        await rootLease.verify();
      } catch (error) {
        if (error instanceof CheckpointRecoveryError) throw error;
        throw new CheckpointRecoveryError("Checkpoint crash recovery failed.", transactionPath, error);
      }
    }
  } catch (error) {
    primary = error;
  } finally {
    const closeError = await rootLease.close().then(() => undefined, (error: unknown) => error);
    if (closeError) {
      const recoveryPath = primary instanceof CheckpointRecoveryError ? primary.transactionPath : root;
      primary = new CheckpointRecoveryError(
        "Checkpoint recovery root lease cleanup failed.",
        recoveryPath,
        new AggregateError(primary === undefined ? [closeError] : [primary, closeError])
      );
    }
  }
  if (primary !== undefined) throw primary;
}
