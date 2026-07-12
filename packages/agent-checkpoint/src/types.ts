export type CheckpointStatus = "open" | "sealed" | "restored";

export type CheckpointEntryKind = "file" | "directory" | "symlink";

export interface CheckpointCasIdentity {
  dev: string;
  ino: string;
  mode: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

export interface CheckpointEntry {
  path: string;
  kind: CheckpointEntryKind;
  mode: number;
  size: number;
  digest?: string;
  casIdentity?: CheckpointCasIdentity;
  linkTarget?: string;
  /** Required for newly captured Windows links so restore never guesses from the live postimage. */
  linkType?: "file" | "directory";
}

export interface CheckpointManifest {
  entries: CheckpointEntry[];
  fileCount: number;
  totalBytes: number;
}

export interface CheckpointDelta {
  added: string[];
  modified: string[];
  deleted: string[];
}

export interface CheckpointRecord {
  schemaVersion: 1;
  checkpointId: string;
  sessionId: string;
  runId: string;
  status: CheckpointStatus;
  workspacePath: string;
  scopePaths: string[];
  baseSeq: number;
  createdAt: string;
  sealedAt?: string;
  restoredAt?: string;
  preManifestDigest: string;
  postManifestDigest?: string;
  delta?: CheckpointDelta;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function checkpointDeltaValue(value: unknown): value is CheckpointDelta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const delta = value as Partial<CheckpointDelta>;
  return stringArray(delta.added) && stringArray(delta.modified) && stringArray(delta.deleted);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function checkpointDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function optionalCheckpointDigest(value: unknown): boolean {
  return value === undefined || checkpointDigest(value);
}

function checkpointStatus(value: unknown): value is CheckpointStatus {
  return value === "open" || value === "sealed" || value === "restored";
}

function optionalCheckpointDelta(value: unknown): boolean {
  return value === undefined || checkpointDeltaValue(value);
}

/** Strictly validates records before persisted state is trusted or replayed. */
export function isCheckpointRecord(value: unknown): value is CheckpointRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<CheckpointRecord>;
  return [
    record.schemaVersion === 1,
    nonEmptyString(record.checkpointId),
    nonEmptyString(record.sessionId),
    nonEmptyString(record.runId),
    checkpointStatus(record.status),
    nonEmptyString(record.workspacePath),
    stringArray(record.scopePaths),
    Number.isSafeInteger(record.baseSeq),
    nonEmptyString(record.createdAt),
    optionalString(record.sealedAt),
    optionalString(record.restoredAt),
    checkpointDigest(record.preManifestDigest),
    optionalCheckpointDigest(record.postManifestDigest),
    optionalCheckpointDelta(record.delta)
  ].every(Boolean);
}

export interface CreateCheckpointInput {
  sessionId: string;
  runId: string;
  workspacePath: string;
  scopePaths: string[];
  baseSeq: number;
}

export interface CheckpointManagerOptions {
  rootDir: string;
  maxFiles?: number;
  maxBytes?: number;
  excludedNames?: string[];
  restoreFaultInjector?: (event: CheckpointRestoreFaultEvent) => void | Promise<void>;
}

export type CheckpointRestoreFaultPoint =
  | "before_commit"
  | "before_backup_move"
  | "after_backup"
  | "before_install_move"
  | "after_install"
  | "before_record"
  | "before_rollback"
  | "before_rollback_restore";

export interface CheckpointRestoreFaultEvent {
  point: CheckpointRestoreFaultPoint;
  path?: string;
  operationIndex?: number;
}

export interface OpenCheckpointInspection {
  checkpoint: CheckpointRecord;
  currentManifestDigest: string;
  changed: boolean;
  delta: CheckpointDelta;
}

export interface SealedCheckpointInspection {
  checkpoint: CheckpointRecord;
  currentManifestDigest: string;
  changed: boolean;
}

export class CheckpointConflictError extends Error {
  readonly code = "checkpoint_conflict";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CheckpointConflictError";
  }
}

export class CheckpointLimitError extends Error {
  readonly code = "checkpoint_limit_exceeded";

  constructor(message: string) {
    super(message);
    this.name = "CheckpointLimitError";
  }
}

export class CheckpointRecoveryError extends Error {
  readonly code = "checkpoint_recovery_failed";
  readonly transactionPath: string;
  readonly recoveryPath: string;

  constructor(message: string, transactionPath: string, cause?: unknown) {
    super(message, { cause });
    this.name = "CheckpointRecoveryError";
    this.transactionPath = transactionPath;
    this.recoveryPath = transactionPath;
  }
}
