import { chmod, lstat, mkdir, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { readPatchPath } from "./atomic-patch-file-state.js";
import { AtomicPatchError } from "./atomic-patch-parser.js";
import { pinPatchParent } from "./atomic-patch-path-safety.js";
import type {
  AtomicPatchMutation, AtomicPatchTransactionHooks, AtomicPatchTransactionValidators, PreparedPatchChange
} from "./atomic-patch-types.js";

interface InstalledTarget { absolutePath: string; relativePath: string; changeIndex: number }
interface MovedSource { target: string; backup: string; relativePath: string; changeIndex: number }
interface CreatedParent { absolutePath: string; relativePath: string; changeIndex: number }

interface TransactionState {
  installed: InstalledTarget[];
  moved: MovedSource[];
  createdParents: CreatedParent[];
}

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

async function stageChanges(staged: string, changes: readonly PreparedPatchChange[]): Promise<void> {
  for (const [index, change] of changes.entries()) {
    if (!change.target) continue;
    const candidate = path.join(staged, String(index));
    if (change.kind === "symlink") {
      await symlink(change.content!, candidate);
      continue;
    }
    const permissions = change.mode! & 0o7777;
    await writeFile(candidate, change.content!, { encoding: "utf8", mode: permissions });
    await chmod(candidate, permissions);
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

async function ensureTargetParents(
  options: AtomicPatchTransactionOptions,
  relative: string,
  changeIndex: number,
  created: CreatedParent[]
): Promise<void> {
  const parts = relative.split("/").slice(0, -1);
  let current = options.workspace;
  for (const part of parts) {
    current = path.join(current, part);
    if (await existingDirectory(current, relative)) continue;
    const relativeParent = relativeFrom(options.workspace, current);
    await runHook(options.beforeMutation, {
      direction: "commit", phase: "create_parent", changeIndex, relativePath: relativeParent
    });
    try {
      const pinned = await pinPatchParent(options.workspace, relativeParent);
      try {
        await pinned.verify();
        await mkdir(pinned.targetPath, { mode: 0o700 });
        await pinned.verify();
      } finally {
        await pinned.close();
      }
      created.push({ absolutePath: current, relativePath: relativeParent, changeIndex });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await existingDirectory(current, relative))) throw error;
    }
  }
}

async function moveSource(
  options: AtomicPatchTransactionOptions,
  backup: string,
  change: PreparedPatchChange,
  changeIndex: number,
  moved: MovedSource[]
): Promise<void> {
  await runHook(options.beforeMutation, {
    direction: "commit", phase: "backup_source", changeIndex, relativePath: change.source!
  });
  await options.validators.assertSourceUnchanged(change);
  const target = path.join(options.workspace, ...change.source!.split("/"));
  const saved = path.join(backup, String(changeIndex));
  const pinned = await pinPatchParent(options.workspace, change.source!);
  try {
    await pinned.verify();
    await rename(pinned.targetPath, saved);
    await pinned.verify();
  } finally {
    await pinned.close();
  }
  moved.push({ target, backup: saved, relativePath: change.source!, changeIndex });
}

async function installTarget(
  options: AtomicPatchTransactionOptions,
  staged: string,
  change: PreparedPatchChange,
  changeIndex: number,
  state: TransactionState
): Promise<void> {
  await ensureTargetParents(options, change.target!, changeIndex, state.createdParents);
  await runHook(options.beforeMutation, {
    direction: "commit", phase: "install_target", changeIndex, relativePath: change.target!
  });
  await options.validators.assertTargetAbsent(change);
  const target = path.join(options.workspace, ...change.target!.split("/"));
  const pinned = await pinPatchParent(options.workspace, change.target!);
  try {
    await pinned.verify();
    await rename(path.join(staged, String(changeIndex)), pinned.targetPath);
    await pinned.verify();
  } finally {
    await pinned.close();
  }
  state.installed.push({ absolutePath: target, relativePath: change.target!, changeIndex });
}

async function installChanges(
  options: AtomicPatchTransactionOptions,
  staged: string,
  backup: string,
  state: TransactionState
): Promise<void> {
  for (const [index, change] of options.changes.entries()) {
    if (change.source) await moveSource(options, backup, change, index, state.moved);
    if (change.target) await installTarget(options, staged, change, index, state);
  }
}

async function captureRollback(
  errors: Error[],
  label: string,
  action: () => Promise<void>
): Promise<void> {
  try {
    await action();
  } catch (error) {
    errors.push(errorFrom(error, label));
  }
}

async function rollbackInstalled(
  options: AtomicPatchTransactionOptions,
  state: TransactionState,
  errors: Error[]
): Promise<void> {
  for (let index = state.installed.length - 1; index >= 0; index -= 1) {
    const item = state.installed[index]!;
    await captureRollback(errors, `Could not remove installed target '${item.relativePath}'`, async () => {
      await runHook(options.beforeMutation, {
        direction: "rollback", phase: "remove_installed",
        changeIndex: item.changeIndex, relativePath: item.relativePath
      });
      const pinned = await pinPatchParent(options.workspace, item.relativePath);
      try {
        await pinned.verify();
        await assertInstalledTarget(options.changes[item.changeIndex]!, pinned.targetPath, item.relativePath);
        await rm(pinned.targetPath, { force: true, recursive: false });
        await pinned.verify();
      } finally {
        await pinned.close();
      }
    });
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
    throw new AtomicPatchError(`Installed path changed before rollback: ${relative}`);
  }
  if (process.platform !== "win32" && change.kind === "file"
    && (current.mode & 0o7777) !== (change.mode! & 0o7777)) {
    throw new AtomicPatchError(`Installed file mode changed before rollback: ${relative}`);
  }
}

async function rollbackMoved(
  options: AtomicPatchTransactionOptions,
  state: TransactionState,
  errors: Error[]
): Promise<void> {
  for (let index = state.moved.length - 1; index >= 0; index -= 1) {
    const item = state.moved[index]!;
    await captureRollback(errors, `Could not restore source '${item.relativePath}'`, async () => {
      await runHook(options.beforeMutation, {
        direction: "rollback", phase: "restore_source",
        changeIndex: item.changeIndex, relativePath: item.relativePath
      });
      const pinned = await pinPatchParent(options.workspace, item.relativePath);
      try {
        await pinned.verify();
        const existing = await lstat(pinned.targetPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (existing) throw new AtomicPatchError(`Restore destination is occupied: ${item.relativePath}`);
        await rename(item.backup, pinned.targetPath);
        await pinned.verify();
      } finally {
        await pinned.close();
      }
    });
  }
}

async function rollbackCreatedParents(
  options: AtomicPatchTransactionOptions,
  state: TransactionState,
  errors: Error[]
): Promise<void> {
  for (let index = state.createdParents.length - 1; index >= 0; index -= 1) {
    const item = state.createdParents[index]!;
    await captureRollback(errors, `Could not remove created parent '${item.relativePath}'`, async () => {
      await runHook(options.beforeMutation, {
        direction: "rollback", phase: "remove_created_parent",
        changeIndex: item.changeIndex, relativePath: item.relativePath
      });
      const pinned = await pinPatchParent(options.workspace, item.relativePath);
      try {
        await pinned.verify();
        if (!(await existingDirectory(pinned.targetPath, item.relativePath))) {
          throw new AtomicPatchError(`Created parent disappeared before rollback: ${item.relativePath}`);
        }
        await rmdir(pinned.targetPath);
        await pinned.verify();
      } finally {
        await pinned.close();
      }
    });
  }
}

async function rollbackChanges(
  options: AtomicPatchTransactionOptions,
  state: TransactionState
): Promise<Error[]> {
  const errors: Error[] = [];
  await rollbackInstalled(options, state, errors);
  await rollbackMoved(options, state, errors);
  await rollbackCreatedParents(options, state, errors);
  await captureRollback(errors, "Workspace restoration verification failed", options.validators.assertRestored);
  return errors;
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
  backup: string
): Promise<void> {
  await mkdir(staged, { mode: 0o700 });
  await mkdir(backup, { mode: 0o700 });
  await stageChanges(staged, options.changes);
  await options.beforeCommit?.();
  await options.validators.assertAllUnchanged();
}

async function throwAfterCleanup(
  primary: unknown,
  transaction: string
): Promise<never> {
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
    await mkdir(options.transaction, { mode: 0o700 });
  } catch (error) {
    throw patchError(error);
  }
  try {
    await initializeTransaction(options, staged, backup);
  } catch (error) {
    return await throwAfterCleanup(error, options.transaction);
  }
  const state: TransactionState = { installed: [], moved: [], createdParents: [] };
  try {
    await installChanges(options, staged, backup, state);
  } catch (error) {
    const rollbackErrors = await rollbackChanges(options, state);
    if (rollbackErrors.length > 0) throw new AtomicPatchRollbackError(error, rollbackErrors, options.transaction);
    return await throwAfterCleanup(error, options.transaction);
  }
  const cleanupError = await cleanup(options.transaction);
  return cleanupError ? { transactionPath: options.transaction, error: cleanupError.message } : undefined;
}
