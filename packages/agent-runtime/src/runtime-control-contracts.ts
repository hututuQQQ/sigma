import type { CheckpointManager, CheckpointRecord } from "agent-checkpoint";
import type { SkillCatalog, SkillExecutionManifest } from "agent-extensions";
import type { ProcessExecutionPort } from "agent-platform";
import type { CheckpointRef, LoadedSkillResourceAccess, PlanGraph } from "agent-protocol";
import type { BudgetController } from "./budget-controller.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import type { RuntimeSession } from "./types.js";

export interface RuntimeControlServiceOptions {
  checkpoints: CheckpointManager;
  execution?: ProcessExecutionPort;
  emit: RuntimeEventEmitter;
  skills?: SkillCatalog;
  createArtifact(sessionId: string, content: string | Uint8Array): Promise<string>;
  readArtifact(sessionId: string, artifactId: string): Promise<string>;
  skillMaterializer?: {
    plannedAccess(sessionId: string, manifest: SkillExecutionManifest, relativePath: string): LoadedSkillResourceAccess;
    materialize(sessionId: string, manifest: SkillExecutionManifest, relativePath: string): Promise<LoadedSkillResourceAccess>;
  };
  planChanged?(session: RuntimeSession, previousRevision: number, plan: PlanGraph): Promise<void>;
  budgets: BudgetController;
  hasActiveChildren?(parentSessionId: string): Promise<boolean> | boolean;
}
export type OpenCheckpointRecoveryResult =
  | { kind: "clean" }
  | { kind: "needs_input"; checkpointId: string; currentManifestDigest: string };

export function checkpointRef(record: CheckpointRecord): CheckpointRef {
  return {
    checkpointId: record.checkpointId,
    sessionId: record.sessionId,
    runId: record.runId,
    status: record.status,
    createdAt: record.createdAt,
    preManifestDigest: record.preManifestDigest,
    ...(record.sealedAt ? { sealedAt: record.sealedAt } : {}),
    ...(record.restoredAt ? { restoredAt: record.restoredAt } : {}),
    ...(record.postManifestDigest ? { postManifestDigest: record.postManifestDigest } : {}),
    ...(record.delta ? { delta: {
      added: [...record.delta.added], modified: [...record.delta.modified], deleted: [...record.delta.deleted]
    } } : {})
  };
}
