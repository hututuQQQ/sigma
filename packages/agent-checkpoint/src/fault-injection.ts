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

export type CheckpointRestoreFaultInjector = (
  event: CheckpointRestoreFaultEvent
) => void | Promise<void>;
