import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  acquireProcessOwnerLease,
  cleanupWorkspaceTransactionRoot,
  ensurePrivateStateDirectory,
  pinWorkspaceTransactionDirectories,
  syncDirectory,
  type ProcessOwnerLease,
  type WorkspaceTransactionDirectoryLease
} from "agent-platform";
import { manifestEqual, validateManifest } from "./restore-manifest-validation.js";
import {
  applyDirectoryModes,
  commitOperation,
  createOperations,
  rollback,
  writeJournal
} from "./restore-transaction-operations.js";
import type {
  RestoreExecutionState,
  RestoreTransactionOptions
} from "./restore-transaction-types.js";
import { validateRestoreCas } from "./restore-cas.js";
import {
  CheckpointConflictError,
  CheckpointRecoveryError,
  type CheckpointRestoreFaultEvent
} from "./types.js";

export {
  assertRestoreImage,
  inspectRestoreImage,
  restoreImageFromManifest,
  restoreImagesEqual
} from "./restore-image-identity.js";
export type { RestoreImageIdentity } from "./restore-image-identity.js";
export type {
  RestoreDirectoryMode,
  RestoreFinalization,
  RestoreTransactionOptions
} from "./restore-transaction-types.js";

async function fault(options: RestoreTransactionOptions, event: CheckpointRestoreFaultEvent): Promise<void> {
  await options.faultInjector?.(event);
}

async function createTransactionDirectory(transactionRootDir: string): Promise<string> {
  const root = await lstat(transactionRootDir);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new CheckpointConflictError("Checkpoint transaction root is unsafe.");
  }
  const transaction = await mkdtemp(path.join(transactionRootDir, "restore-"));
  await syncDirectory(transactionRootDir);
  return transaction;
}

/** Serializes checkpoint restore and recovery for one canonical workspace root. */
export async function acquireCheckpointMutationLease(
  transactionRootDir: string
): Promise<ProcessOwnerLease> {
  const lockPath = path.join(path.dirname(transactionRootDir), ".checkpoint-restore.mutation.lock");
  return await acquireProcessOwnerLease(lockPath, {
    pid: process.pid,
    instanceId: randomUUID(),
    startedAt: new Date().toISOString()
  }, {
    label: "checkpoint workspace mutation",
    activeOwner: "wait",
    timeoutMs: 30_000
  });
}

/**
 * A caller can resolve a transaction root before waiting for the per-workspace
 * mutation lease. The previous lease holder is allowed to remove its empty
 * root during cleanup, so validate and recreate the private directory only
 * after this operation owns the lease.
 */
export async function ensureCheckpointTransactionRoot(transactionRootDir: string): Promise<void> {
  await ensurePrivateStateDirectory(transactionRootDir);
}

async function createLeasedTransaction(
  options: RestoreTransactionOptions
): Promise<{ transactionPath: string; rootLease: WorkspaceTransactionDirectoryLease }> {
  const rootLease = await pinWorkspaceTransactionDirectories([options.transactionRootDir]);
  try {
    await rootLease.verify();
    const transactionPath = await createTransactionDirectory(options.transactionRootDir);
    await rootLease.verify();
    return { transactionPath, rootLease };
  } catch (error) {
    const closeError = await rootLease.close().then(() => undefined, (failure: unknown) => failure);
    if (closeError) {
      throw new AggregateError([error, closeError], "Checkpoint transaction initialization cleanup failed.", {
        cause: error
      });
    }
    throw error;
  }
}

function cleanupRecoveryError(
  primary: unknown,
  cleanupErrors: readonly unknown[],
  recoveryPath: string,
  message: string
): CheckpointRecoveryError {
  const errors = primary === undefined ? [...cleanupErrors] : [primary, ...cleanupErrors];
  return new CheckpointRecoveryError(
    message,
    recoveryPath,
    new AggregateError(errors, "Checkpoint primary failure and cleanup failures are preserved together.")
  );
}

async function executeRestoreCommit(
  options: RestoreTransactionOptions,
  transactionPath: string,
  state: RestoreExecutionState,
  rootLease: WorkspaceTransactionDirectoryLease
): Promise<void> {
  state.operations = await createOperations(options, transactionPath);
  state.transactionLease = await pinWorkspaceTransactionDirectories([
    transactionPath, path.join(transactionPath, "stage"), path.join(transactionPath, "backup")
  ]);
  const lease = state.transactionLease;
  await writeJournal(transactionPath, "staged", state.operations, options);
  await fault(options, { point: "before_commit" });
  await lease.verify();
  if (!manifestEqual(await options.capture(), options.current)) {
    throw new CheckpointConflictError("Workspace changed while checkpoint restore was staged.");
  }
  for (const operation of state.operations) {
    await commitOperation(
      options, operation, transactionPath, state.operations,
      async () => await lease.verify()
    );
  }
  await applyDirectoryModes(options, options.desired);
  if (!manifestEqual(await options.capture(), options.desired)) {
    throw new CheckpointConflictError("Workspace does not match the complete restored checkpoint image.");
  }
  await writeJournal(transactionPath, "verified", state.operations, options);
  await fault(options, { point: "before_record" });
  await options.finalize();
  state.finalized = true;
  await writeJournal(transactionPath, "finalized", state.operations, options);
  await lease.verify();
  await rootLease.verify();
  await lease.close();
  state.transactionLease = undefined;
  await rootLease.verify();
  await rm(transactionPath, { recursive: true, force: true });
  await rootLease.verify();
}

async function closeFailedTransactionLease(state: RestoreExecutionState): Promise<unknown> {
  const closeError = await state.transactionLease?.close().then(
    () => undefined,
    (failure: unknown) => failure
  );
  state.transactionLease = undefined;
  return closeError;
}

async function removeUnchangedTransaction(
  error: unknown,
  closeError: unknown,
  transactionPath: string,
  rootLease: WorkspaceTransactionDirectoryLease
): Promise<unknown> {
  await rootLease.verify();
  const removeError = await rm(transactionPath, { recursive: true, force: true }).then(
    () => undefined,
    (failure: unknown) => failure
  );
  return removeError
    ? cleanupRecoveryError(
      error, [...(closeError ? [closeError] : []), removeError], transactionPath,
      "Checkpoint restore failed before commit, and transaction cleanup also failed."
    )
    : error;
}

async function rollbackFailedRestore(
  options: RestoreTransactionOptions,
  state: RestoreExecutionState,
  transactionPath: string,
  error: unknown,
  closeError: unknown,
  failures: unknown[],
  rootLease: WorkspaceTransactionDirectoryLease
): Promise<unknown> {
  try {
    await rollback(options, state.operations, transactionPath);
    await rootLease.verify();
    await rm(transactionPath, { recursive: true, force: true });
    await rootLease.verify();
    return closeError
      ? cleanupRecoveryError(
        error, [closeError], transactionPath,
        "Checkpoint restore rolled back, but internal lease cleanup failed."
      )
      : error;
  } catch (rollbackError) {
    return new CheckpointRecoveryError(
      "Checkpoint restore failed and its rollback could not be verified; manual recovery is required.",
      transactionPath,
      new AggregateError([...failures, rollbackError])
    );
  }
}

async function recoverFailedRestore(
  options: RestoreTransactionOptions,
  state: RestoreExecutionState,
  transactionPath: string,
  error: unknown,
  rootLease: WorkspaceTransactionDirectoryLease
): Promise<unknown> {
  const closeError = await closeFailedTransactionLease(state);
  const failures = closeError ? [error, closeError] : [error];
  if (state.finalized) {
    return new CheckpointRecoveryError(
      "Checkpoint restore committed, but its internal transaction journal could not be removed.",
      transactionPath,
      failures.length === 1 ? error : new AggregateError(failures)
    );
  }
  const changed = state.operations.some((operation) => operation.backupMoved || operation.installed);
  if (!changed) return await removeUnchangedTransaction(error, closeError, transactionPath, rootLease);
  return await rollbackFailedRestore(options, state, transactionPath, error, closeError, failures, rootLease);
}

async function closeRestoreResources(
  state: RestoreExecutionState,
  rootLease: WorkspaceTransactionDirectoryLease
): Promise<unknown[]> {
  const cleanupErrors: unknown[] = [];
  await state.transactionLease?.close().catch((error: unknown) => { cleanupErrors.push(error); });
  await rootLease.close().catch((error: unknown) => { cleanupErrors.push(error); });
  return cleanupErrors;
}

async function performRestore(options: RestoreTransactionOptions): Promise<void> {
  validateManifest(options.desired);
  validateManifest(options.current);
  await validateRestoreCas(options.desired, options.readCas);
  if (!manifestEqual(await options.capture(), options.current)) {
    throw new CheckpointConflictError("Workspace changed before checkpoint restore staging.");
  }
  const { transactionPath, rootLease } = await createLeasedTransaction(options);
  const state: RestoreExecutionState = { operations: [], finalized: false };
  let primary: unknown;
  try {
    await executeRestoreCommit(options, transactionPath, state, rootLease);
  } catch (error) {
    primary = await recoverFailedRestore(options, state, transactionPath, error, rootLease);
  } finally {
    const cleanupErrors = await closeRestoreResources(state, rootLease);
    if (cleanupErrors.length > 0) {
      primary = cleanupRecoveryError(
        primary, cleanupErrors, transactionPath,
        "Checkpoint transaction resource cleanup failed; recovery data was preserved."
      );
    }
  }
  if (primary !== undefined) throw primary;
}

/** Apply a multi-path restore with staged replacements, rename backups, and verified rollback. */
export async function restoreCheckpointTransaction(options: RestoreTransactionOptions): Promise<void> {
  let mutationLease: ProcessOwnerLease | undefined;
  let primary: unknown;
  try {
    mutationLease = await acquireCheckpointMutationLease(options.transactionRootDir);
    await ensureCheckpointTransactionRoot(options.transactionRootDir);
    await performRestore(options);
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
    throw cleanupRecoveryError(
      primary, cleanupErrors, recoveryPath,
      "Checkpoint restore cleanup failed; primary failure and recovery path were preserved."
    );
  }
  if (primary !== undefined) throw primary;
}
