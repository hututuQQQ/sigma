export type PatchFileKind = "file" | "symlink";

export interface PatchOriginalFile {
  exists: boolean;
  kind: PatchFileKind;
  content: string;
  bytes: Buffer;
  mode: number;
  eol: "\n" | "\r\n";
  finalNewline: boolean;
}

export interface PreparedPatchChange {
  source?: string;
  target?: string;
  original: PatchOriginalFile;
  content?: string;
  kind?: PatchFileKind;
  mode?: number;
}

export type AtomicPatchMutationPhase =
  | "create_parent"
  | "backup_source"
  | "backup_source_pinned"
  | "install_target"
  | "install_target_pinned"
  | "remove_installed"
  | "restore_source"
  | "remove_created_parent";

export interface AtomicPatchMutation {
  direction: "commit" | "rollback";
  phase: AtomicPatchMutationPhase;
  changeIndex: number;
  relativePath: string;
}

export interface AtomicPatchTransactionHooks {
  /** Test-only fault-injection hook. It is not exposed through the model tool schema. */
  beforeMutation?: (operation: AtomicPatchMutation) => Promise<void>;
}

export interface AtomicPatchTransactionValidators {
  assertAllUnchanged(): Promise<void>;
  assertSourceUnchanged(change: PreparedPatchChange): Promise<void>;
  assertTargetAbsent(change: PreparedPatchChange): Promise<void>;
  assertInstalled(change: PreparedPatchChange): Promise<void>;
  assertRestored(): Promise<void>;
}
