import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type RestoreDirectoryMode,
  type RestoreFinalization,
  type RestoreImageIdentity
} from "./restore-transaction.js";
import { CheckpointRecoveryError, isCheckpointRecord } from "./types.js";

export interface RecoveryOperation {
  path: string;
  index: number;
  backupMoved: boolean;
  installed: boolean;
  backupIntent?: boolean;
  installIntent?: boolean;
  currentImage?: RestoreImageIdentity;
  installedImage?: RestoreImageIdentity;
  hadCurrent?: boolean;
  hasDesired?: boolean;
}

export interface RecoveryJournal {
  schemaVersion: 1 | 2 | 3;
  phase: string;
  operations: RecoveryOperation[];
  directoryModes?: RestoreDirectoryMode[];
  finalization?: RestoreFinalization;
}

function safePath(value: string): boolean {
  const normalized = path.posix.normalize(value);
  return Boolean(value) && !path.posix.isAbsolute(value) && normalized === value
    && value !== "." && value !== ".." && !value.startsWith("../") && !value.includes("\\");
}

function restoreImage(value: unknown): value is RestoreImageIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const image = value as Partial<RestoreImageIdentity>;
  return (image.kind === "file" || image.kind === "directory" || image.kind === "symlink")
    && Number.isSafeInteger(image.mode) && (image.mode as number) >= 0
    && Number.isSafeInteger(image.size) && (image.size as number) >= 0
    && typeof image.digest === "string" && /^[a-f0-9]{64}$/u.test(image.digest);
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function basicRecoveryOperation(operation: Partial<RecoveryOperation>): boolean {
  return [
    Number.isSafeInteger(operation.index),
    (operation.index as number) >= 0,
    typeof operation.path === "string" && safePath(operation.path),
    typeof operation.backupMoved === "boolean",
    typeof operation.installed === "boolean",
    optionalBoolean(operation.backupIntent),
    optionalBoolean(operation.installIntent)
  ].every(Boolean);
}

function recoveryImagesValid(operation: Partial<RecoveryOperation>): boolean {
  const currentValid = operation.currentImage === undefined || restoreImage(operation.currentImage);
  const installedValid = operation.installedImage === undefined || restoreImage(operation.installedImage);
  return [
    currentValid,
    installedValid,
    typeof operation.hadCurrent === "boolean",
    typeof operation.hasDesired === "boolean",
    typeof operation.backupIntent === "boolean",
    typeof operation.installIntent === "boolean",
    operation.hadCurrent === (operation.currentImage !== undefined),
    operation.hasDesired === (operation.installedImage !== undefined),
    !(operation.backupMoved || operation.backupIntent) || operation.hadCurrent,
    !(operation.installed || operation.installIntent) || operation.hasDesired
  ].every(Boolean);
}

function recoveryOperation(value: unknown, schemaVersion: number): value is RecoveryOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const operation = value as Partial<RecoveryOperation>;
  const basic = basicRecoveryOperation(operation);
  if (!basic || schemaVersion < 3) return basic;
  return recoveryImagesValid(operation);
}

function recoveryFinalization(value: unknown): value is RestoreFinalization {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const finalization = value as Partial<RestoreFinalization>;
  return typeof finalization.desiredManifestDigest === "string"
    && /^[a-f0-9]{64}$/u.test(finalization.desiredManifestDigest)
    && isCheckpointRecord(finalization.record)
    && finalization.record.status === "restored"
    && finalization.record.preManifestDigest === finalization.desiredManifestDigest;
}

function recoveryDirectoryMode(value: unknown): value is RestoreDirectoryMode {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const mode = value as Partial<RestoreDirectoryMode>;
  const currentValid = mode.currentMode === undefined
    || (Number.isSafeInteger(mode.currentMode) && mode.currentMode >= 0);
  const desiredValid = mode.desiredMode === undefined
    || (Number.isSafeInteger(mode.desiredMode) && mode.desiredMode >= 0);
  return typeof mode.path === "string" && safePath(mode.path)
    && currentValid && desiredValid
    && (mode.currentMode !== undefined || mode.desiredMode !== undefined);
}

function recoverySchemaVersion(value: unknown): value is RecoveryJournal["schemaVersion"] {
  return value === 1 || value === 2 || value === 3;
}

function recoveryPhase(value: unknown): value is string {
  return typeof value === "string"
    && ["staged", "applying", "rolling_back", "verified", "finalized"].includes(value);
}

function operationsHaveUniqueIndices(operations: readonly RecoveryOperation[]): boolean {
  return new Set(operations.map((operation) => operation.index)).size === operations.length;
}

function validDirectoryModes(candidate: Partial<RecoveryJournal>): boolean {
  if (candidate.schemaVersion !== 3) return true;
  return Array.isArray(candidate.directoryModes)
    && candidate.directoryModes.every(recoveryDirectoryMode);
}

function journal(value: unknown, transactionPath: string): RecoveryJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CheckpointRecoveryError("Checkpoint recovery journal is invalid.", transactionPath);
  }
  const candidate = value as Partial<RecoveryJournal>;
  if (!recoverySchemaVersion(candidate.schemaVersion)
    || !recoveryPhase(candidate.phase) || !Array.isArray(candidate.operations)) {
    throw new CheckpointRecoveryError("Checkpoint recovery journal has an unsupported schema.", transactionPath);
  }
  if (!candidate.operations.every((operation) => recoveryOperation(operation, candidate.schemaVersion!))) {
    throw new CheckpointRecoveryError("Checkpoint recovery journal contains an invalid operation.", transactionPath);
  }
  if (!operationsHaveUniqueIndices(candidate.operations as RecoveryOperation[])) {
    throw new CheckpointRecoveryError("Checkpoint recovery journal contains duplicate operation indices.", transactionPath);
  }
  if (candidate.schemaVersion >= 2 && !recoveryFinalization(candidate.finalization)) {
    throw new CheckpointRecoveryError("Checkpoint recovery journal finalization is invalid.", transactionPath);
  }
  if (!validDirectoryModes(candidate)) {
    throw new CheckpointRecoveryError("Checkpoint recovery journal directory modes are invalid.", transactionPath);
  }
  return candidate as RecoveryJournal;
}

export async function readRecoveryJournal(transactionPath: string): Promise<RecoveryJournal> {
  try {
    return journal(
      JSON.parse(await readFile(path.join(transactionPath, "journal.json"), "utf8")),
      transactionPath
    );
  } catch (error) {
    if (error instanceof CheckpointRecoveryError) throw error;
    throw new CheckpointRecoveryError("Checkpoint recovery journal is unreadable.", transactionPath, error);
  }
}
