import { chmod, lstat, mkdir, open, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { durableReplaceFile, syncDirectory } from "agent-platform";
import { readPatchPath } from "./atomic-patch-file-state.js";
import {
  createPatchJournal,
  recoverAtomicPatchTransaction,
  writePatchJournal,
  type AtomicPatchJournal,
  type AtomicPatchJournalOperation
} from "./atomic-patch-journal.js";
import { AtomicPatchError } from "./atomic-patch-parser.js";
import { pinPatchParent } from "./atomic-patch-path-safety.js";
import type {
  AtomicPatchMutation, AtomicPatchTransactionHooks, AtomicPatchTransactionValidators, PreparedPatchChange
} from "./atomic-patch-types.js";

export interface AtomicPatchCleanupWarning {
  transactionPath: string;
  error: string;
}

export interface AtomicPatchTransactionOptions extends AtomicPatchTransactionHooks {
  workspace: string;
  transaction: string;
  changes: readonly PreparedPatchChange[];
  beforeCommit?: () => Promise<void>;
  validators: AtomicPatchTransactionValidators;
}

export class AtomicPatchRollbackError extends AtomicPatchError {
  readonly recoveryPath: string;
  readonly rollbackErrors: readonly Error[];

  constructor(primary: unknown, rollbackErrors: readonly Error[], recoveryPath: string) {
    const cause = new AggregateError(rollbackErrors, "One or more rollback operations failed.", {
      cause: primary instanceof Error ? primary : undefined
    });
    super(`Atomic patch rollback failed; recovery data was preserved at '${recoveryPath}'.`, { cause });
    this.name = "AtomicPatchRollbackError";
    this.recoveryPath = recoveryPath;
    this.rollbackErrors = rollbackErrors;
  }
}

export class AtomicPatchCleanupError extends AtomicPatchError {
  readonly recoveryPath: string;

  constructor(primary: unknown, cleanupError: Error, recoveryPath: string) {
    super(`Atomic patch workspace was restored, but transaction cleanup failed at '${recoveryPath}'.`, {
      cause: new AggregateError([cleanupError], "Transaction cleanup failed.", {
        cause: primary instanceof Error ? primary : undefined
      })
    });
    this.name = "AtomicPatchCleanupError";
    this.recoveryPath = recoveryPath;
  }
}

function errorFrom(value: unknown, prefix: string): Error {
  if (value instanceof Error) return new AtomicPatchError(`${prefix}: ${value.message}`, { cause: value });
  return new AtomicPatchError(`${prefix}: ${String(value)}`);
}

function patchError(value: unknown): AtomicPatchError {
  if (value instanceof AtomicPatchError) return value;
  if (value instanceof Error) return new AtomicPatchError(`Atomic patch failed: ${value.message}`, { cause: value });
  return new AtomicPatchError(`Atomic patch failed: ${String(value)}`);
}

function relativeFrom(workspace: string, absolute: string): string {
  return path.relative(workspace, absolute).split(path.sep).join("/");
}

async function runHook(
  hook: AtomicPatchTransactionHooks["beforeMutation"],
  operation: AtomicPatchMutation
): Promise<void> {
  await hook?.(operation);
}

async function syncFile(target: string): Promise<void> {
  const handle = await open(target, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function stageChanges(staged: string, changes: readonly PreparedPatchChange[]): Promise<void> {
  for (const [index, change] of changes.entries()) {
    if (!change.target) continue;
    const candidate = path.join(staged, String(index));
    if (change.kind === "symlink") {
      await symlink(change.content!, candidate);
      await syncDirectory(staged);
      continue;
    }
    const permissions = change.mode! & 0o7777;
    await durableReplaceFile(candidate, change.content!, { mode: permissions });
    await chmod(candidate, permissions);
    await syncFile(candidate);
  }
}

async function existingDirectory(absolute: string, relative: string): Promise<boolean> {
  const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return false;
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new AtomicPatchError(`Patch parent is not a contained directory: ${relative}`);
  }
  return true;
}

function journalOperation(journal: AtomicPatchJournal, changeIndex: number): AtomicPatchJournalOperation {
  const operation = journal.operations.find((item) => item.changeIndex === changeIndex);
  if (!operation) throw new AtomicPatchError(`Patch journal is missing change ${changeIndex}.`);
  return operation;
}

async function persistApplying(options: AtomicPatchTransactionOptions, journal: AtomicPatchJournal): Promise<void> {
  journal.phase = "applying";
  await writePatchJournal(options.transaction, journal);
}

async function ensureTargetParents(
  options: AtomicPatchTransactionOptions,
  relative: string,
  changeIndex: number,
  journal: AtomicPatchJournal
): Promise<void> {
  const parts = relative.split("/").slice(0, -1);
  let current = options.workspace;
  for (const part of parts) {
    current = path.join(current, part);
    if (await existingDirectory(current, relative)) continue;
    const relativeParent = relativeFrom(options.workspace, current);
    const parent = { relativePath: relativeParent, changeIndex, createIntent: true, created: false };
    journal.parents.push(parent);
    await persistApplying(options, journal);
    await runHook(options.beforeMutation, {
      direction: "commit", phase: "create_parent", changeIndex, relativePath: relativeParent
    });
    const pinned = await pinPatchParent(options.workspace, relativeParent);
    try {
      await pinned.verify();
      try {
        await mkdir(pinned.targetPath, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST"
          && await existingDirectory(current, relative)) {
          journal.parents.splice(journal.parents.indexOf(parent), 1);
          await persistApplying(options, journal);
          continue;
        }
        if (await existingDirectory(current, relative).catch(() => false)) {
          parent.created = true;
          await persistApplying(options, journal).catch(() => undefined);
        }
        throw error;
      }
      await syncDirectory(path.dirname(pinned.targetPath));
      await runHook(options.beforeMutation, {
        direction: "commit", phase: "create_parent_created", changeIndex, relativePath: relativeParent
      });
      parent.created = true;
      await persistApplying(options, journal);
      await pinned.verify();
    } finally {
      await pinned.close();
    }
  }
}

async function moveSource(
  options: AtomicPatchTransactionOptions,
  backup: string,
  change: PreparedPatchChange,
  changeIndex: number,
  journal: AtomicPatchJournal
): Promise<void> {
  await runHook(options.beforeMutation, {
    direction: "commit", phase: "backup_source", changeIndex, relativePath: change.source!
  });
  await options.validators.assertSourceUnchanged(change);
  const saved = path.join(backup, String(changeIndex));
  const operation = journalOperation(journal, changeIndex);
  const pinned = await pinPatchParent(options.workspace, change.source!);
  try {
    await pinned.verify();
    operation.backupIntent = true;
    await persistApplying(options, journal);
    await runHook(options.beforeMutation, {
      direction: "commit", phase: "backup_source_pinned", changeIndex, relativePath: change.source!
    });
    await rename(pinned.targetPath, saved);
    await syncDirectory(path.dirname(pinned.targetPath));
    await syncDirectory(path.dirname(saved));
    await runHook(options.beforeMutation, {
      direction: "commit", phase: "backup_source_moved", changeIndex, relativePath: change.source!
    });
    operation.backupMoved = true;
    await persistApplying(options, journal);
    await pinned.verify();
  } finally {
    await pinned.close();
  }
}

async function assertInstalledTarget(
  change: PreparedPatchChange,
  absolute: string,
  relative: string
): Promise<void> {
  const current = await readPatchPath(absolute, relative);
  if (!current.exists || current.kind !== change.kind
    || !current.bytes.equals(Buffer.from(change.content!, "utf8"))) {
    throw new AtomicPatchError(`Installed path changed before commit: ${relative}`);
  }
  if (process.platform !== "win32" && change.kind === "file"
    && (current.mode & 0o7777) !== (change.mode! & 0o7777)) {
    throw new AtomicPatchError(`Installed file mode changed before commit: ${relative}`);
  }
}

async function installTarget(
  options: AtomicPatchTransactionOptions,
  staged: string,
  change: PreparedPatchChange,
  changeIndex: number,
  journal: AtomicPatchJournal
): Promise<void> {
  await ensureTargetParents(options, change.target!, changeIndex, journal);
  await runHook(options.beforeMutation, {
    direction: "commit", phase: "install_target", changeIndex, relativePath: change.target!
  });
  await options.validators.assertTargetAbsent(change);
  const candidate = path.join(staged, String(changeIndex));
  await assertInstalledTarget(change, candidate, change.target!);
  const operation = journalOperation(journal, changeIndex);
  const pinned = await pinPatchParent(options.workspace, change.target!);
  try {
    await pinned.verify();
    operation.installIntent = true;
    await persistApplying(options, journal);
    await runHook(options.beforeMutation, {
      direction: "commit", phase: "install_target_pinned", changeIndex, relativePath: change.target!
    });
    await rename(candidate, pinned.targetPath);
    await syncDirectory(path.dirname(candidate));
    await syncDirectory(path.dirname(pinned.targetPath));
    await runHook(options.beforeMutation, {
      direction: "commit", phase: "install_target_moved", changeIndex, relativePath: change.target!
    });
    operation.installed = true;
    await persistApplying(options, journal);
    await pinned.verify();
  } finally {
    await pinned.close();
  }
}

async function installChanges(
  options: AtomicPatchTransactionOptions,
  staged: string,
  backup: string,
  journal: AtomicPatchJournal
): Promise<void> {
  for (const [index, change] of options.changes.entries()) {
    if (change.source) await moveSource(options, backup, change, index, journal);
    if (change.target) await installTarget(options, staged, change, index, journal);
  }
}

async function cleanup(transaction: string): Promise<Error | undefined> {
  try {
    await rm(transaction, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    return errorFrom(error, `Could not remove transaction '${transaction}'`);
  }
}

async function initializeTransaction(
  options: AtomicPatchTransactionOptions,
  staged: string,
  backup: string,
  journal: AtomicPatchJournal
): Promise<void> {
  await mkdir(staged, { mode: 0o700 });
  await mkdir(backup, { mode: 0o700 });
  await stageChanges(staged, options.changes);
  await options.beforeCommit?.();
  await options.validators.assertAllUnchanged();
  journal.phase = "prepared";
  await writePatchJournal(options.transaction, journal);
}

async function throwAfterCleanup(primary: unknown, transaction: string): Promise<never> {
  const cleanupError = await cleanup(transaction);
  if (cleanupError) throw new AtomicPatchCleanupError(primary, cleanupError, transaction);
  throw patchError(primary);
}

export async function commitPreparedPatch(
  options: AtomicPatchTransactionOptions
): Promise<AtomicPatchCleanupWarning | undefined> {
  const staged = path.join(options.transaction, "staged");
  const backup = path.join(options.transaction, "backup");
  try {
    const relative = relativeFrom(options.workspace, options.transaction);
    const pinned = await pinPatchParent(options.workspace, relative);
    try {
      await pinned.verify();
      await mkdir(pinned.targetPath, { mode: 0o700 });
      await syncDirectory(path.dirname(pinned.targetPath));
      await pinned.verify();
    } finally {
      await pinned.close();
    }
  } catch (error) {
    throw patchError(error);
  }
  const journal = createPatchJournal(options.changes);
  try {
    await writePatchJournal(options.transaction, journal);
  } catch (error) {
    return await throwAfterCleanup(error, options.transaction);
  }
  try {
    await initializeTransaction(options, staged, backup, journal);
    await installChanges(options, staged, backup, journal);
    for (const change of options.changes) {
      if (change.target) await options.validators.assertInstalled(change);
    }
    journal.phase = "committed";
    await writePatchJournal(options.transaction, journal);
  } catch (error) {
    try {
      await recoverAtomicPatchTransaction(options.workspace, options.transaction, options.beforeMutation);
    } catch (rollbackError) {
      throw new AtomicPatchRollbackError(
        error,
        [errorFrom(rollbackError, "Durable patch recovery failed")],
        options.transaction
      );
    }
    throw patchError(error);
  }
  const cleanupError = await cleanup(options.transaction);
  return cleanupError ? { transactionPath: options.transaction, error: cleanupError.message } : undefined;
}
