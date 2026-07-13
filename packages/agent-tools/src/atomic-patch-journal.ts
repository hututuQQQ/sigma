import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { durableReplaceFile, syncDirectory } from "agent-platform";
import { readPatchPath } from "./atomic-patch-file-state.js";
import { AtomicPatchError } from "./atomic-patch-parser.js";
import { pinPatchParent } from "./atomic-patch-path-safety.js";
import type { AtomicPatchMutation, PreparedPatchChange } from "./atomic-patch-types.js";

type RecoveryHook = (operation: AtomicPatchMutation) => Promise<void>;

export type AtomicPatchJournalPhase = "preparing" | "prepared" | "applying" | "rolling_back" | "committed";

export interface AtomicPatchJournalOperation {
  changeIndex: number;
  source?: string;
  target?: string;
  sourceKind?: "file" | "symlink";
  sourceMode?: number;
  sourceDigest?: string;
  targetKind?: "file" | "symlink";
  targetMode?: number;
  targetDigest?: string;
  backupIntent: boolean;
  backupMoved: boolean;
  installIntent: boolean;
  installed: boolean;
}

export interface AtomicPatchJournalParent {
  relativePath: string;
  changeIndex: number;
  createIntent: boolean;
  created: boolean;
}

export interface AtomicPatchJournal {
  schemaVersion: 1;
  phase: AtomicPatchJournalPhase;
  operations: AtomicPatchJournalOperation[];
  parents: AtomicPatchJournalParent[];
}

export class AtomicPatchRecoveryError extends AtomicPatchError {
  readonly recoveryPath: string;

  constructor(message: string, recoveryPath: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AtomicPatchRecoveryError";
    this.recoveryPath = recoveryPath;
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createPatchJournal(changes: readonly PreparedPatchChange[]): AtomicPatchJournal {
  return {
    schemaVersion: 1,
    phase: "preparing",
    parents: [],
    operations: changes.map((change, changeIndex) => ({
      changeIndex,
      ...(change.source ? {
        source: change.source,
        sourceKind: change.original.kind,
        sourceMode: change.original.mode & 0o7777,
        sourceDigest: digest(change.original.bytes)
      } : {}),
      ...(change.target ? {
        target: change.target,
        targetKind: change.kind!,
        targetMode: change.mode! & 0o7777,
        targetDigest: digest(Buffer.from(change.content!, "utf8"))
      } : {}),
      backupIntent: false,
      backupMoved: false,
      installIntent: false,
      installed: false
    }))
  };
}

export async function writePatchJournal(transactionPath: string, journal: AtomicPatchJournal): Promise<void> {
  await durableReplaceFile(
    path.join(transactionPath, "journal.json"),
    JSON.stringify(journal, null, 2),
    { mode: 0o600 }
  );
}

function safeRelative(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.includes("\\")) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && !path.posix.isAbsolute(value)
    && value !== "." && value !== ".." && !value.startsWith("../");
}

function boolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validEndpoint(
  pathValue: unknown,
  kind: unknown,
  mode: unknown,
  digestValue: unknown
): boolean {
  if (pathValue === undefined) return kind === undefined && mode === undefined && digestValue === undefined;
  return [
    safeRelative(pathValue),
    ["file", "symlink"].includes(String(kind)),
    Number.isSafeInteger(mode),
    validDigest(digestValue)
  ].every(Boolean);
}

function validOperation(value: unknown, indices: Set<number>): value is AtomicPatchJournalOperation {
  if (!value || typeof value !== "object") return false;
  const operation = value as Partial<AtomicPatchJournalOperation>;
  const index = operation.changeIndex;
  const valid = [
    Number.isSafeInteger(index),
    typeof index === "number" && index >= 0,
    typeof index === "number" && !indices.has(index),
    validEndpoint(operation.source, operation.sourceKind, operation.sourceMode, operation.sourceDigest),
    validEndpoint(operation.target, operation.targetKind, operation.targetMode, operation.targetDigest),
    Boolean(operation.source || operation.target),
    boolean(operation.backupIntent),
    boolean(operation.backupMoved),
    boolean(operation.installIntent),
    boolean(operation.installed)
  ].every(Boolean);
  if (valid) indices.add(index as number);
  return valid;
}

function validParent(value: unknown, indices: ReadonlySet<number>): value is AtomicPatchJournalParent {
  if (!value || typeof value !== "object") return false;
  const parent = value as Partial<AtomicPatchJournalParent>;
  return [
    safeRelative(parent.relativePath),
    Number.isSafeInteger(parent.changeIndex),
    typeof parent.changeIndex === "number" && indices.has(parent.changeIndex),
    boolean(parent.createIntent),
    boolean(parent.created)
  ].every(Boolean);
}

function parseJournal(value: unknown, transactionPath: string): AtomicPatchJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AtomicPatchRecoveryError("Atomic patch recovery journal is invalid.", transactionPath);
  }
  const candidate = value as Partial<AtomicPatchJournal>;
  if (candidate.schemaVersion !== 1
    || !["preparing", "prepared", "applying", "rolling_back", "committed"].includes(String(candidate.phase))
    || !Array.isArray(candidate.operations) || !Array.isArray(candidate.parents)) {
    throw new AtomicPatchRecoveryError("Atomic patch recovery journal has an unsupported schema.", transactionPath);
  }
  const indices = new Set<number>();
  if (!candidate.operations.every((operation) => validOperation(operation, indices))) {
    throw new AtomicPatchRecoveryError("Atomic patch recovery journal contains an invalid operation.", transactionPath);
  }
  if (!candidate.parents.every((parent) => validParent(parent, indices))) {
    throw new AtomicPatchRecoveryError("Atomic patch recovery journal contains an invalid parent operation.", transactionPath);
  }
  return candidate as AtomicPatchJournal;
}

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
  if (!current.exists || current.kind !== expected.kind || digest(current.bytes) !== expected.digest
    || (process.platform !== "win32" && expected.kind === "file" && (current.mode & 0o7777) !== expected.mode)) {
    throw new AtomicPatchRecoveryError(`Atomic patch recovery found an unexpected path: ${relativePath}`, transactionPath);
  }
}

async function removeInstalled(
  workspace: string,
  transactionPath: string,
  journal: AtomicPatchJournal,
  operation: AtomicPatchJournalOperation,
  beforeMutation?: RecoveryHook
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

async function restoreBackup(
  workspace: string,
  transactionPath: string,
  journal: AtomicPatchJournal,
  operation: AtomicPatchJournalOperation,
  beforeMutation?: RecoveryHook
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
      if (sourceExists) {
        throw new AtomicPatchRecoveryError(`Atomic patch restore destination is occupied: ${operation.source}`, transactionPath);
      }
      await assertExpected(backupPath, operation.source, {
        kind: operation.sourceKind, mode: operation.sourceMode, digest: operation.sourceDigest
      }, transactionPath);
      await beforeMutation?.({
        direction: "rollback", phase: "restore_source",
        changeIndex: operation.changeIndex, relativePath: operation.source
      });
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
  beforeMutation?: RecoveryHook
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
  const journal = parseJournal(value, transactionPath);
  if (journal.phase === "committed") {
    await rm(transactionPath, { recursive: true, force: true });
    return;
  }
  journal.phase = "rolling_back";
  await writePatchJournal(transactionPath, journal);
  for (const operation of [...journal.operations].reverse()) {
    await removeInstalled(workspace, transactionPath, journal, operation, beforeMutation);
  }
  for (const operation of [...journal.operations].reverse()) {
    await restoreBackup(workspace, transactionPath, journal, operation, beforeMutation);
  }
  await removeCreatedParents(workspace, transactionPath, journal, beforeMutation);
  await rm(transactionPath, { recursive: true, force: true });
}

export async function recoverAtomicPatchTransactions(workspace: string): Promise<void> {
  const root = path.join(workspace, ".agent", "patch-transactions");
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
    await recoverAtomicPatchTransaction(workspace, transactionPath);
  }
}
