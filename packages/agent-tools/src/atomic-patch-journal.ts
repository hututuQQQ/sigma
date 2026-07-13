import { lstat, readFile, readdir, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import {
  cleanupWorkspaceTransactionRoot,
  pinWorkspaceTransactionDirectories,
  syncDirectory,
  workspaceTransactionRoot
} from "agent-platform";
import { readPatchPath } from "./atomic-patch-file-state.js";
import {
  AtomicPatchRecoveryError,
  parsePatchJournal,
  patchJournalDigest,
  writePatchJournal,
  type AtomicPatchJournal,
  type AtomicPatchJournalOperation
} from "./atomic-patch-journal-schema.js";
import { pinPatchParent } from "./atomic-patch-path-safety.js";
import type { AtomicPatchMutation } from "./atomic-patch-types.js";

export { AtomicPatchRecoveryError, createPatchJournal, writePatchJournal } from "./atomic-patch-journal-schema.js";
export type {
  AtomicPatchJournal,
  AtomicPatchJournalOperation,
  AtomicPatchJournalParent,
  AtomicPatchJournalPhase
} from "./atomic-patch-journal-schema.js";

type RecoveryHook = (operation: AtomicPatchMutation) => Promise<void>;

async function exists(target: string): Promise<boolean> {
  return await lstat(target).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

async function assertExpected(
  absolutePath: string,
  relativePath: string,
  expected: { kind: "file" | "symlink"; mode: number; digest: string },
  transactionPath: string
): Promise<void> {
  const current = await readPatchPath(absolutePath, relativePath);
  if (!current.exists || current.kind !== expected.kind || patchJournalDigest(current.bytes) !== expected.digest
    || (process.platform !== "win32" && expected.kind === "file" && (current.mode & 0o7777) !== expected.mode)) {
    throw new AtomicPatchRecoveryError(`Atomic patch recovery found an unexpected path: ${relativePath}`, transactionPath);
  }
}

async function removeInstalled(
  workspace: string,
  transactionPath: string,
  journal: AtomicPatchJournal,
  operation: AtomicPatchJournalOperation,
  beforeMutation?: RecoveryHook,
  verifyTransaction: () => Promise<void> = async () => undefined
): Promise<void> {
  if (!operation.target || !operation.targetKind || operation.targetMode === undefined || !operation.targetDigest) return;
  const stagePath = path.join(transactionPath, "staged", String(operation.changeIndex));
  const pinned = await pinPatchParent(workspace, operation.target);
  try {
    await pinned.verify();
    const stageExists = await exists(stagePath);
    const targetExists = await exists(pinned.targetPath);
    if (stageExists && targetExists && operation.installIntent) {
      throw new AtomicPatchRecoveryError(`Atomic patch install state is ambiguous: ${operation.target}`, transactionPath);
    }
    const occurred = operation.installed || (operation.installIntent && !stageExists && targetExists);
    if (occurred && targetExists) {
      await beforeMutation?.({
        direction: "rollback", phase: "remove_installed",
        changeIndex: operation.changeIndex, relativePath: operation.target
      });
      await verifyTransaction();
      await assertExpected(pinned.targetPath, operation.target, {
        kind: operation.targetKind, mode: operation.targetMode, digest: operation.targetDigest
      }, transactionPath);
      await rm(pinned.targetPath, { force: true, recursive: false });
      await syncDirectory(path.dirname(pinned.targetPath));
    }
    operation.installed = false;
    operation.installIntent = false;
    journal.phase = "rolling_back";
    await writePatchJournal(transactionPath, journal);
    await pinned.verify();
  } finally {
    await pinned.close();
  }
}

function assertRestoreDestinationUnoccupied(
  sourceExists: boolean,
  source: string,
  transactionPath: string
): void {
  if (sourceExists) {
    throw new AtomicPatchRecoveryError(`Atomic patch restore destination is occupied: ${source}`, transactionPath);
  }
}

async function restoreBackup(
  workspace: string,
  transactionPath: string,
  journal: AtomicPatchJournal,
  operation: AtomicPatchJournalOperation,
  beforeMutation?: RecoveryHook,
  verifyTransaction: () => Promise<void> = async () => undefined
): Promise<void> {
  if (!operation.source || !operation.sourceKind || operation.sourceMode === undefined || !operation.sourceDigest) return;
  const backupPath = path.join(transactionPath, "backup", String(operation.changeIndex));
  const pinned = await pinPatchParent(workspace, operation.source);
  try {
    await pinned.verify();
    const backupExists = await exists(backupPath);
    const sourceExists = await exists(pinned.targetPath);
    const occurred = operation.backupMoved || (operation.backupIntent && backupExists);
    if (occurred && backupExists) {
      assertRestoreDestinationUnoccupied(sourceExists, operation.source, transactionPath);
      await assertExpected(backupPath, operation.source, {
        kind: operation.sourceKind, mode: operation.sourceMode, digest: operation.sourceDigest
      }, transactionPath);
      await beforeMutation?.({
        direction: "rollback", phase: "restore_source",
        changeIndex: operation.changeIndex, relativePath: operation.source
      });
      await verifyTransaction();
      await rename(backupPath, pinned.targetPath);
      await syncDirectory(path.dirname(backupPath));
      await syncDirectory(path.dirname(pinned.targetPath));
    } else if (occurred && !backupExists) {
      if (!sourceExists || journal.phase !== "rolling_back") {
        throw new AtomicPatchRecoveryError(`Atomic patch backup is missing: ${operation.source}`, transactionPath);
      }
      await assertExpected(pinned.targetPath, operation.source, {
        kind: operation.sourceKind, mode: operation.sourceMode, digest: operation.sourceDigest
      }, transactionPath);
    }
    operation.backupMoved = false;
    operation.backupIntent = false;
    journal.phase = "rolling_back";
    await writePatchJournal(transactionPath, journal);
    await pinned.verify();
  } finally {
    await pinned.close();
  }
}

async function removeCreatedParents(
  workspace: string,
  transactionPath: string,
  journal: AtomicPatchJournal,
  beforeMutation?: RecoveryHook,
  verifyTransaction: () => Promise<void> = async () => undefined
): Promise<void> {
  for (const parent of [...journal.parents].reverse()) {
    if (!parent.createIntent && !parent.created) continue;
    const pinned = await pinPatchParent(workspace, parent.relativePath);
    try {
      await pinned.verify();
      const info = await lstat(pinned.targetPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (info) {
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new AtomicPatchRecoveryError(`Atomic patch created parent changed type: ${parent.relativePath}`, transactionPath);
        }
        try {
        await beforeMutation?.({
            direction: "rollback", phase: "remove_created_parent",
            changeIndex: parent.changeIndex, relativePath: parent.relativePath
        });
        await verifyTransaction();
          await rmdir(pinned.targetPath);
          await syncDirectory(path.dirname(pinned.targetPath));
        } catch (error) {
          throw new AtomicPatchRecoveryError(
            `Atomic patch created parent is not safely removable: ${parent.relativePath}`,
            transactionPath,
            { cause: error instanceof Error ? error : undefined }
          );
        }
      }
      parent.created = false;
      parent.createIntent = false;
      journal.phase = "rolling_back";
      await writePatchJournal(transactionPath, journal);
      await pinned.verify();
    } finally {
      await pinned.close();
    }
  }
}

export async function recoverAtomicPatchTransaction(
  workspace: string,
  transactionPath: string,
  beforeMutation?: RecoveryHook
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path.join(transactionPath, "journal.json"), "utf8");
  } catch (error) {
    throw new AtomicPatchRecoveryError(
      "Atomic patch transaction has no readable recovery journal.",
      transactionPath,
      { cause: error instanceof Error ? error : undefined }
    );
  }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (error) {
    throw new AtomicPatchRecoveryError(
      "Atomic patch recovery journal is not valid JSON.",
      transactionPath,
      { cause: error instanceof Error ? error : undefined }
    );
  }
  const journal = parsePatchJournal(value, transactionPath);
  const candidates = [
    path.dirname(transactionPath), transactionPath,
    path.join(transactionPath, "staged"), path.join(transactionPath, "backup")
  ];
  const directories: string[] = [];
  for (const candidate of candidates) {
    const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new AtomicPatchRecoveryError("Atomic patch transaction directory is unsafe.", transactionPath);
    }
    directories.push(candidate);
  }
  const lease = await pinWorkspaceTransactionDirectories(directories);
  if (journal.phase === "committed") {
    await lease.verify();
    await lease.close();
    await rm(transactionPath, { recursive: true, force: true });
    return;
  }
  const verify = async (): Promise<void> => await lease.verify();
  try {
    journal.phase = "rolling_back";
    await writePatchJournal(transactionPath, journal);
    await verify();
    for (const operation of [...journal.operations].reverse()) {
      await removeInstalled(workspace, transactionPath, journal, operation, beforeMutation, verify);
    }
    for (const operation of [...journal.operations].reverse()) {
      await restoreBackup(workspace, transactionPath, journal, operation, beforeMutation, verify);
    }
    await removeCreatedParents(workspace, transactionPath, journal, beforeMutation, verify);
  } finally {
    await lease.close();
  }
  await rm(transactionPath, { recursive: true, force: true });
}

async function recoverTransactionRoot(workspace: string, root: string): Promise<void> {
  const rootLease = await pinWorkspaceTransactionDirectories([root]);
  try {
    const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.name.startsWith("patch-")) continue;
      const transactionPath = path.join(root, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new AtomicPatchRecoveryError("Atomic patch transaction entry is unsafe.", transactionPath);
      }
      await rootLease.verify();
      await recoverAtomicPatchTransaction(workspace, transactionPath);
      await rootLease.verify();
    }
  } finally {
    await rootLease.close();
  }
}

export async function recoverAtomicPatchTransactions(
  workspace: string,
  stateRootDir?: string
): Promise<void> {
  const root = await workspaceTransactionRoot({
    workspacePath: workspace,
    ...(stateRootDir ? { stateRootDir } : {}),
    namespace: "atomic-patch"
  });
  try {
    await recoverTransactionRoot(workspace, root);
  } finally {
    await cleanupWorkspaceTransactionRoot(root);
  }
}
