import type { CheckpointManager } from "agent-checkpoint";
import type {
  CheckpointRef,
  EvidenceRecord,
  WorkspaceDeltaEvidence
} from "agent-protocol";
import type { RuntimeSession } from "./types.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";

export class CheckpointEvidenceRecorder {
  constructor(
    private readonly checkpoints: CheckpointManager,
    private readonly emit: RuntimeEventEmitter
  ) {}

  async record(session: RuntimeSession, sealed: CheckpointRef): Promise<void> {
    const checkpointId = sealed.checkpointId;
    if (session.state.checkpointHead?.checkpointId !== checkpointId
      || session.state.checkpointHead.status !== "sealed") {
      await this.emit(session, "checkpoint.sealed", "runtime", sealed);
    }
    const existingCheckpointEvidence = session.state.evidence.find((item) =>
      item.kind === "checkpoint" && item.data.checkpointId === checkpointId);
    if (!existingCheckpointEvidence) await this.recordCheckpoint(session, sealed);
    if (sealed.delta && sealed.delta.added.length + sealed.delta.modified.length + sealed.delta.deleted.length > 0) {
      await this.recordDelta(session, sealed);
    }
  }

  async recordImported(
    session: RuntimeSession,
    sealed: CheckpointRef,
    sourceSessionId: string,
    childId: string
  ): Promise<void> {
    if (sealed.status !== "sealed" || !sealed.delta || !sealed.postManifestDigest) {
      throw new Error(`Child checkpoint ${sealed.checkpointId} is not a sealed mutation.`);
    }
    const checkpointEvidenceId = `checkpoint:${sourceSessionId}:${sealed.checkpointId}`;
    if (!session.state.evidence.some((item) => item.evidenceId === checkpointEvidenceId)) {
      const checkpoint: EvidenceRecord = {
        evidenceId: checkpointEvidenceId,
        sessionId: session.sessionId,
        runId: session.runId,
        kind: "checkpoint",
        status: "passed",
        createdAt: new Date().toISOString(),
        producer: { authority: "runtime", id: "checkpoint-manager" },
        summary: `Kept child '${childId}' checkpoint '${sealed.checkpointId}'.`,
        data: {
          checkpointId: sealed.checkpointId,
          checkpointStatus: "sealed",
          preManifestDigest: sealed.preManifestDigest,
          postManifestDigest: sealed.postManifestDigest,
          sourceSessionId,
          childId
        }
      };
      await this.emit(session, "evidence.recorded", "runtime", checkpoint);
    }
    const deltaEvidenceId = `workspace-delta:${sourceSessionId}:${sealed.checkpointId}`;
    let delta = session.state.evidence.find((item): item is WorkspaceDeltaEvidence =>
      item.kind === "workspace_delta" && item.evidenceId === deltaEvidenceId);
    if (!delta) {
      delta = {
        evidenceId: deltaEvidenceId,
        sessionId: session.sessionId,
        runId: session.runId,
        kind: "workspace_delta",
        status: "passed",
        createdAt: new Date().toISOString(),
        producer: { authority: "runtime", id: "checkpoint-manager" },
        summary: `Kept interrupted child '${childId}' workspace changes from checkpoint '${sealed.checkpointId}'.`,
        data: {
          checkpointId: sealed.checkpointId,
          sourceSessionId,
          childId,
          delta: {
            added: [...sealed.delta.added],
            modified: [...sealed.delta.modified],
            deleted: [...sealed.delta.deleted]
          },
          reviewDiff: await this.checkpoints.reviewDiff(sourceSessionId, sealed.checkpointId)
        }
      };
      await this.emit(session, "evidence.recorded", "runtime", delta);
    }
    const validationId = `checkpoint-validation:${sourceSessionId}:${sealed.checkpointId}`;
    if (!session.state.evidence.some((item) => item.evidenceId === validationId)) {
      const validation: EvidenceRecord = {
        evidenceId: validationId,
        sessionId: session.sessionId,
        runId: session.runId,
        kind: "validation",
        status: "passed",
        createdAt: new Date().toISOString(),
        producer: { authority: "runtime", id: "checkpoint-manager" },
        summary: `Child checkpoint '${sealed.checkpointId}' postimage was captured and content-addressed successfully.`,
        data: {
          validator: "checkpoint_postimage_integrity",
          artifactIds: [],
          workspaceDeltaEvidenceIds: [delta.evidenceId],
          sourceSessionId,
          childId
        }
      };
      await this.emit(session, "evidence.recorded", "runtime", validation);
    }
  }

  private async recordCheckpoint(session: RuntimeSession, sealed: CheckpointRef): Promise<void> {
    const checkpointId = sealed.checkpointId;
    const evidence: EvidenceRecord = {
      evidenceId: `checkpoint:${checkpointId}`,
      sessionId: session.sessionId,
      runId: session.runId,
      kind: "checkpoint",
      status: "passed",
      createdAt: new Date().toISOString(),
      producer: { authority: "runtime", id: "checkpoint-manager" },
      summary: `Sealed mutation checkpoint '${checkpointId}'.`,
      data: {
        checkpointId,
        checkpointStatus: "sealed",
        preManifestDigest: sealed.preManifestDigest,
        ...(sealed.postManifestDigest ? { postManifestDigest: sealed.postManifestDigest } : {})
      }
    };
    await this.emit(session, "evidence.recorded", "runtime", evidence);
  }

  private async recordDelta(session: RuntimeSession, sealed: CheckpointRef): Promise<void> {
    const delta = await this.existingOrRecordDelta(session, sealed);
    const existingValidation = session.state.evidence.find((item) =>
      item.kind === "validation"
      && item.data.validator === "checkpoint_postimage_integrity"
      && item.data.workspaceDeltaEvidenceIds.includes(delta.evidenceId));
    if (existingValidation) return;
    const checkpointId = sealed.checkpointId;
    const validation: EvidenceRecord = {
      evidenceId: `checkpoint-validation:${checkpointId}`,
      sessionId: session.sessionId,
      runId: session.runId,
      kind: "validation",
      status: "passed",
      createdAt: new Date().toISOString(),
      producer: { authority: "runtime", id: "checkpoint-manager" },
      summary: `Checkpoint '${checkpointId}' postimage was captured and content-addressed successfully.`,
      data: {
        validator: "checkpoint_postimage_integrity",
        artifactIds: [],
        workspaceDeltaEvidenceIds: [delta.evidenceId]
      }
    };
    await this.emit(session, "evidence.recorded", "runtime", validation);
  }

  private async existingOrRecordDelta(
    session: RuntimeSession,
    sealed: CheckpointRef
  ): Promise<WorkspaceDeltaEvidence> {
    const checkpointId = sealed.checkpointId;
    const existing = session.state.evidence.find((item): item is WorkspaceDeltaEvidence =>
      item.kind === "workspace_delta" && item.data.checkpointId === checkpointId);
    if (existing) return existing;
    const reviewDiff = await this.checkpoints.reviewDiff(session.sessionId, checkpointId);
    const evidence: WorkspaceDeltaEvidence = {
      evidenceId: `workspace-delta:${checkpointId}`,
      sessionId: session.sessionId,
      runId: session.runId,
      kind: "workspace_delta",
      status: "passed",
      createdAt: new Date().toISOString(),
      producer: { authority: "runtime", id: "checkpoint-manager" },
      summary: `Observed workspace changes for checkpoint '${checkpointId}'.`,
      data: {
        checkpointId,
        delta: {
          added: [...sealed.delta!.added],
          modified: [...sealed.delta!.modified],
          deleted: [...sealed.delta!.deleted]
        },
        reviewDiff
      }
    };
    await this.emit(session, "evidence.recorded", "runtime", evidence);
    return evidence;
  }
}
