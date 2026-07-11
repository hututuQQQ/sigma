import { lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { durableReplaceFile } from "agent-platform";
import { pinCheckpointParent } from "./path-safety.js";
import type { RestoreFinalization } from "./restore-transaction.js";
import { CheckpointRecoveryError } from "./types.js";

interface RecoveryOperation {
  path: string;
  index: number;
  backupMoved: boolean;
  installed: boolean;
  backupIntent?: boolean;
  installIntent?: boolean;
}

interface RecoveryJournal {
  schemaVersion: 1 | 2;
  phase: string;
  operations: RecoveryOperation[];
  finalization?: RestoreFinalization;
}

export interface CheckpointTransactionRecoveryOptions {
  workspacePath: string;
  finalize(finalization: RestoreFinalization): Promise<void>;
}

function safePath(value: string): boolean {
  const normalized = path.posix.normalize(value);
  return Boolean(value) && !path.posix.isAbsolute(value) && normalized === value
    && value !== "." && value !== ".." && !value.startsWith("../") && !value.includes("\\");
}

function recoveryOperation(value: unknown): value is RecoveryOperation {
  if (!value || typeof value !== "object") return false;
  const operation = value as Partial<RecoveryOperation>;
  return [
    Number.isSafeInteger(operation.index),
    typeof operation.path === "string" && safePath(operation.path),
    typeof operation.backupMoved === "boolean",
    typeof operation.installed === "boolean",
    operation.backupIntent === undefined || typeof operation.backupIntent === "boolean",
    operation.installIntent === undefined || typeof operation.installIntent === "boolean"
  ].every(Boolean);
}

function recoveryFinalization(value: unknown): value is RestoreFinalization {
  if (!value || typeof value !== "object") return false;
  const finalization = value as Partial<RestoreFinalization>;
  return typeof finalization.desiredManifestDigest === "string"
    && /^[a-f0-9]{64}$/u.test(finalization.desiredManifestDigest)
    && Boolean(finalization.record && typeof finalization.record === "object");
}

function journal(value: unknown, transactionPath: string): RecoveryJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CheckpointRecoveryError("Checkpoint recovery journal is invalid.", transactionPath);
  }
  const candidate = value as Partial<RecoveryJournal>;
  if (![1, 2].includes(Number(candidate.schemaVersion))
    || typeof candidate.phase !== "string" || !Array.isArray(candidate.operations)) {
    throw new CheckpointRecoveryError("Checkpoint recovery journal has an unsupported schema.", transactionPath);
  }
  if (!candidate.operations.every(recoveryOperation)) {
    throw new CheckpointRecoveryError("Checkpoint recovery journal contains an invalid operation.", transactionPath);
  }
  if (candidate.schemaVersion === 2 && !recoveryFinalization(candidate.finalization)) {
    throw new CheckpointRecoveryError("Checkpoint recovery journal finalization is invalid.", transactionPath);
  }
  return candidate as RecoveryJournal;
}

async function exists(target: string): Promise<boolean> {
  return await lstat(target).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

async function recoverTransaction(
  options: CheckpointTransactionRecoveryOptions,
  transactionPath: string
): Promise<void> {
  const parsed = journal(JSON.parse(await readFile(path.join(transactionPath, "journal.json"), "utf8")), transactionPath);
  if (parsed.phase === "finalized") {
    await rm(transactionPath, { recursive: true, force: true });
    return;
  }
  if (parsed.phase === "verified") {
    if (parsed.schemaVersion !== 2 || !parsed.finalization) {
      throw new CheckpointRecoveryError(
        "Checkpoint restore is verified but its legacy journal cannot finalize the checkpoint record automatically.",
        transactionPath
      );
    }
    await options.finalize(parsed.finalization);
    await durableReplaceFile(
      path.join(transactionPath, "journal.json"),
      JSON.stringify({ ...parsed, phase: "finalized" }, null, 2),
      { mode: 0o600 }
    );
    await rm(transactionPath, { recursive: true, force: true });
    return;
  }
  for (const operation of [...parsed.operations].reverse()) {
    const pinned = await pinCheckpointParent(options.workspacePath, operation.path);
    try {
      await pinned.verify();
      const stagePath = path.join(transactionPath, "stage", String(operation.index));
      const backupPath = path.join(transactionPath, "backup", String(operation.index));
      const backupExists = await exists(backupPath);
      const installOccurred = operation.installed
        || (operation.installIntent === true && !await exists(stagePath) && await exists(pinned.targetPath));
      const backupOccurred = operation.backupMoved || (operation.backupIntent === true && backupExists);
      if (installOccurred) await rm(pinned.targetPath, { recursive: true, force: true });
      if (backupOccurred) {
        if (!backupExists) throw new CheckpointRecoveryError("Checkpoint backup is missing during crash recovery.", transactionPath);
        if (await exists(pinned.targetPath)) {
          throw new CheckpointRecoveryError("Checkpoint target is occupied during crash recovery.", transactionPath);
        }
        await rename(backupPath, pinned.targetPath);
      }
      await pinned.verify();
    } finally {
      await pinned.close();
    }
  }
  await rm(transactionPath, { recursive: true, force: true });
}

/** Replays durable restore journals before a new checkpoint operation touches the workspace. */
export async function recoverCheckpointTransactions(
  options: CheckpointTransactionRecoveryOptions
): Promise<void> {
  const root = path.join(options.workspacePath, ".agent", "checkpoint-transactions");
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith("restore-")) continue;
    const transactionPath = path.join(root, entry.name);
    try {
      await recoverTransaction(options, transactionPath);
    } catch (error) {
      if (error instanceof CheckpointRecoveryError) throw error;
      throw new CheckpointRecoveryError("Checkpoint crash recovery failed.", transactionPath, error);
    }
  }
}
