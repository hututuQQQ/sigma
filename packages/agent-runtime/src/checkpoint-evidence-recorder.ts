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
    if (session.durable.state.checkpointHead?.checkpointId !== checkpointId
      || session.durable.state.checkpointHead.status !== "sealed") {
      await this.emit(session, "checkpoint.sealed", "runtime", sealed);
    }
    const existingCheckpointEvidence = session.durable.state.evidence.find((item) =>
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
    if (!session.durable.state.evidence.some((item) => item.evidenceId === checkpointEvidenceId)) {
      const checkpoint: EvidenceRecord = {
        evidenceId: checkpointEvidenceId,
        sessionId: session.identity.sessionId,
        runId: session.durable.runId,
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
    await this.existingOrRecordImportedDelta(
      session, sealed, sealed.delta, sourceSessionId, childId
    );
    const validationId = `checkpoint-validation:${sourceSessionId}:${sealed.checkpointId}`;
    if (!session.durable.state.evidence.some((item) => item.evidenceId === validationId)) {
      const validation: EvidenceRecord = {
        evidenceId: validationId,
        sessionId: session.identity.sessionId,
        runId: session.durable.runId,
        kind: "validation",
        status: "passed",
        createdAt: new Date().toISOString(),
        producer: { authority: "runtime", id: "checkpoint-manager" },
        summary: `Child checkpoint '${sealed.checkpointId}' postimage was captured and content-addressed successfully.`,
        data: {
          validator: "checkpoint_postimage_integrity",
          artifactIds: [],
          frontierRevision: session.durable.state.mutationFrontier.revision,
          stateDigest: session.durable.state.mutationFrontier.currentStateDigest,
          coveredPaths: [],
          sourceSessionId,
          childId
        }
      };
      await this.emit(session, "evidence.recorded", "runtime", validation);
    }
  }

  private async existingOrRecordImportedDelta(
    session: RuntimeSession,
    sealed: CheckpointRef,
    checkpointDelta: NonNullable<CheckpointRef["delta"]>,
    sourceSessionId: string,
    childId: string
  ): Promise<WorkspaceDeltaEvidence> {
    const evidenceId = `workspace-delta:${sourceSessionId}:${sealed.checkpointId}`;
    const existing = session.durable.state.evidence.find((item): item is WorkspaceDeltaEvidence =>
      item.kind === "workspace_delta" && item.evidenceId === evidenceId);
    if (existing) return existing;
    const material = await this.checkpoints.reviewMaterial(sourceSessionId, sealed.checkpointId);
    const evidence: WorkspaceDeltaEvidence = {
      evidenceId,
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
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
          added: [...checkpointDelta.added],
          modified: [...checkpointDelta.modified],
          deleted: [...checkpointDelta.deleted]
        },
        reviewDiff: material.reviewDiff,
        reviewDiffPaths: material.reviewDiffPaths,
        ...(material.opaqueArtifacts.length > 0 ? { opaqueArtifacts: material.opaqueArtifacts } : {}),
        ...(material.reviewProblem ? { reviewProblem: material.reviewProblem } : {})
      }
    };
    await this.emit(session, "evidence.recorded", "runtime", evidence);
    return evidence;
  }

  private async recordCheckpoint(session: RuntimeSession, sealed: CheckpointRef): Promise<void> {
    const checkpointId = sealed.checkpointId;
    const evidence: EvidenceRecord = {
      evidenceId: `checkpoint:${checkpointId}`,
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
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
    await this.existingOrRecordDelta(session, sealed);
    const existingValidation = session.durable.state.evidence.find((item) =>
      item.kind === "validation"
      && item.data.validator === "checkpoint_postimage_integrity"
      && item.data.frontierRevision === session.durable.state.mutationFrontier.revision
      && item.data.stateDigest === session.durable.state.mutationFrontier.currentStateDigest);
    if (existingValidation) return;
    const checkpointId = sealed.checkpointId;
    const validation: EvidenceRecord = {
      evidenceId: `checkpoint-validation:${checkpointId}`,
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      kind: "validation",
      status: "passed",
      createdAt: new Date().toISOString(),
      producer: { authority: "runtime", id: "checkpoint-manager" },
      summary: `Checkpoint '${checkpointId}' postimage was captured and content-addressed successfully.`,
      data: {
        validator: "checkpoint_postimage_integrity",
        artifactIds: [],
        frontierRevision: session.durable.state.mutationFrontier.revision,
        stateDigest: session.durable.state.mutationFrontier.currentStateDigest,
        coveredPaths: []
      }
    };
    await this.emit(session, "evidence.recorded", "runtime", validation);
  }

  private async existingOrRecordDelta(
    session: RuntimeSession,
    sealed: CheckpointRef
  ): Promise<WorkspaceDeltaEvidence> {
    const checkpointId = sealed.checkpointId;
    const existing = session.durable.state.evidence.find((item): item is WorkspaceDeltaEvidence =>
      item.kind === "workspace_delta" && item.data.checkpointId === checkpointId);
    if (existing) return existing;
    const material = await this.checkpoints.reviewMaterial(session.identity.sessionId, checkpointId);
    const evidence: WorkspaceDeltaEvidence = {
      evidenceId: `workspace-delta:${checkpointId}`,
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
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
        reviewDiff: material.reviewDiff,
        reviewDiffPaths: material.reviewDiffPaths,
        ...(material.opaqueArtifacts.length > 0 ? { opaqueArtifacts: material.opaqueArtifacts } : {}),
        ...(material.reviewProblem ? { reviewProblem: material.reviewProblem } : {})
      }
    };
    await this.emit(session, "evidence.recorded", "runtime", evidence);
    return evidence;
  }
}
