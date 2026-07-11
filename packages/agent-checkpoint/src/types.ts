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
  | "after_backup"
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

  constructor(message: string, transactionPath: string, cause?: unknown) {
    super(message, { cause });
    this.name = "CheckpointRecoveryError";
    this.transactionPath = transactionPath;
  }
}
