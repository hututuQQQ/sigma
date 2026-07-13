import type { WorkspaceTransactionDirectoryLease } from "agent-platform";
import type { RestoreImageIdentity } from "./restore-image-identity.js";
import type { RestoreCasReader } from "./restore-cas.js";
import type {
  CheckpointEntry,
  CheckpointManifest,
  CheckpointRecord,
  CheckpointRestoreFaultEvent
} from "./types.js";

export interface RestoreOperation {
  path: string;
  index: number;
  current?: CheckpointEntry;
  desired?: CheckpointEntry;
  stagePath?: string;
  backupPath: string;
  backupMoved: boolean;
  installed: boolean;
  backupIntent: boolean;
  installIntent: boolean;
  currentImage?: RestoreImageIdentity;
  installedImage?: RestoreImageIdentity;
}

export interface RestoreTransactionOptions {
  workspacePath: string;
  transactionRootDir: string;
  desired: CheckpointManifest;
  current: CheckpointManifest;
  readCas: RestoreCasReader;
  capture(ignoredRootName?: string): Promise<CheckpointManifest>;
  finalization: RestoreFinalization;
  finalize: () => Promise<void>;
  faultInjector?: (event: CheckpointRestoreFaultEvent) => void | Promise<void>;
}

export interface RestoreFinalization {
  record: CheckpointRecord;
  desiredManifestDigest: string;
}

export interface RestoreDirectoryMode {
  path: string;
  currentMode?: number;
  desiredMode?: number;
}

export interface RestoreExecutionState {
  operations: RestoreOperation[];
  finalized: boolean;
  transactionLease?: WorkspaceTransactionDirectoryLease;
}
