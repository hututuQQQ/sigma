import { lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pinCheckpointParent } from "./path-safety.js";
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
  schemaVersion: 1;
  phase: string;
  operations: RecoveryOperation[];
}

function safePath(value: string): boolean {
  const normalized = path.posix.normalize(value);
  return Boolean(value) && !path.posix.isAbsolute(value) && normalized === value
    && value !== "." && value !== ".." && !value.startsWith("../") && !value.includes("\\");
}

function journal(value: unknown, transactionPath: string): RecoveryJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CheckpointRecoveryError("Checkpoint recovery journal is invalid.", transactionPath);
  }
  const candidate = value as Partial<RecoveryJournal>;
  if (candidate.schemaVersion !== 1 || typeof candidate.phase !== "string" || !Array.isArray(candidate.operations)) {
    throw new CheckpointRecoveryError("Checkpoint recovery journal has an unsupported schema.", transactionPath);
  }
  for (const operation of candidate.operations) {
    if (!operation || typeof operation !== "object" || !Number.isSafeInteger(operation.index)
      || typeof operation.path !== "string" || !safePath(operation.path)) {
      throw new CheckpointRecoveryError("Checkpoint recovery journal contains an invalid operation.", transactionPath);
    }
  }
  return candidate as RecoveryJournal;
}

async function exists(target: string): Promise<boolean> {
  return await lstat(target).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

async function recoverTransaction(workspacePath: string, transactionPath: string): Promise<void> {
  const parsed = journal(JSON.parse(await readFile(path.join(transactionPath, "journal.json"), "utf8")), transactionPath);
  if (parsed.phase === "verified" || parsed.phase === "finalized") {
    await rm(transactionPath, { recursive: true, force: true });
    return;
  }
  for (const operation of [...parsed.operations].reverse()) {
    const pinned = await pinCheckpointParent(workspacePath, operation.path);
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
export async function recoverCheckpointTransactions(workspacePath: string): Promise<void> {
  const root = path.join(workspacePath, ".agent", "checkpoint-transactions");
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith("restore-")) continue;
    const transactionPath = path.join(root, entry.name);
    try {
      await recoverTransaction(workspacePath, transactionPath);
    } catch (error) {
      if (error instanceof CheckpointRecoveryError) throw error;
      throw new CheckpointRecoveryError("Checkpoint crash recovery failed.", transactionPath, error);
    }
  }
}
