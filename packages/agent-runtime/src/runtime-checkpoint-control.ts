import { CheckpointConflictError, type CheckpointRecord } from "agent-checkpoint";
import type { CheckpointRef } from "agent-protocol";
import { CheckpointEvidenceRecorder } from "./checkpoint-evidence-recorder.js";
import { checkpointRef, type OpenCheckpointRecoveryResult, type RuntimeControlServiceOptions } from "./runtime-control-contracts.js";
import type { ChildCheckpointRecovery, RuntimeSession } from "./types.js";

export class RuntimeCheckpointControl {
  private readonly evidence: CheckpointEvidenceRecorder;

  constructor(private readonly options: RuntimeControlServiceOptions) {
    this.evidence = new CheckpointEvidenceRecorder(options.checkpoints, options.emit);
  }

  async create(session: RuntimeSession, scopePaths: string[]): Promise<CheckpointRef> {
    const created = checkpointRef(await this.options.checkpoints.create({
      sessionId: session.sessionId,
      runId: session.runId,
      workspacePath: session.workspacePath,
      scopePaths,
      baseSeq: session.seq
    }));
    await this.options.emit(session, "checkpoint.created", "runtime", created);
    return created;
  }

  async undoLatest(session: RuntimeSession): Promise<CheckpointRef> {
    const restored = checkpointRef(await this.options.checkpoints.undoLatest(session.sessionId));
    await this.options.emit(session, "checkpoint.restored", "user", restored);
    return restored;
  }

  async restoreRun(session: RuntimeSession, checkpointId: string): Promise<CheckpointRef> {
    if (session.openCheckpointRecovery) {
      throw Object.assign(new Error("Resolve the interrupted open checkpoint before restoring sealed run changes."), {
        code: "checkpoint_recovery_required"
      });
    }
    const records = await this.options.checkpoints.list(session.sessionId);
    const latest = [...records].reverse().find((item) => item.status !== "restored");
    if (!latest || latest.checkpointId !== checkpointId) {
      throw Object.assign(new Error(`Checkpoint ${checkpointId} is not the latest restorable checkpoint.`), {
        code: "checkpoint_not_latest"
      });
    }
    if (latest.status !== "sealed") {
      throw Object.assign(new Error(`Checkpoint ${checkpointId} is not sealed.`), {
        code: "checkpoint_not_sealed"
      });
    }
    if (latest.runId !== session.runId) {
      throw Object.assign(new Error(`Checkpoint ${checkpointId} was not created by the current run.`), {
        code: "checkpoint_run_mismatch"
      });
    }
    return await this.undoLatest(session);
  }

  async seal(session: RuntimeSession, checkpointId: string): Promise<CheckpointRef> {
    const sealed = checkpointRef(await this.options.checkpoints.seal(session.sessionId, checkpointId));
    await this.evidence.record(session, sealed);
    return sealed;
  }

  async inspectOpen(
    session: RuntimeSession,
    checkpointId: string
  ): Promise<{ currentManifestDigest: string; delta: { added: string[]; modified: string[]; deleted: string[] } }> {
    const inspection = await this.options.checkpoints.inspectOpen(session.sessionId, checkpointId);
    return {
      currentManifestDigest: inspection.currentManifestDigest,
      delta: {
        added: [...inspection.delta.added],
        modified: [...inspection.delta.modified],
        deleted: [...inspection.delta.deleted]
      }
    };
  }

  async restorePolicyViolation(
    session: RuntimeSession,
    checkpointId: string,
    expectedCurrentManifestDigest: string
  ): Promise<CheckpointRef> {
    const restored = checkpointRef(await this.options.checkpoints.restoreOpen(
      session.sessionId,
      checkpointId,
      expectedCurrentManifestDigest
    ));
    if (restored.status !== "restored") {
      throw new Error(`Checkpoint ${checkpointId} was not restored after an effect-plan violation.`);
    }
    await this.options.emit(session, "checkpoint.restored", "runtime", restored);
    return restored;
  }

  async recoverOpen(session: RuntimeSession): Promise<OpenCheckpointRecoveryResult> {
    const records = await this.options.checkpoints.list(session.sessionId);
    await this.reconcileHead(session, records);
    const open = records.filter((item) => item.status === "open").at(-1);
    if (!open) return { kind: "clean" };
    const inspection = await this.options.checkpoints.inspectOpen(session.sessionId, open.checkpointId);
    if (inspection.changed) {
      return {
        kind: "needs_input",
        checkpointId: open.checkpointId,
        currentManifestDigest: inspection.currentManifestDigest
      };
    }
    await this.seal(session, open.checkpointId);
    return { kind: "clean" };
  }

  private async reconcileHead(session: RuntimeSession, records: CheckpointRecord[]): Promise<void> {
    const head = session.state.checkpointHead;
    const persistedHead = head ? records.find((item) => item.checkpointId === head.checkpointId) : undefined;
    if (head?.status === "open" && persistedHead?.status === "sealed") {
      await this.evidence.record(session, checkpointRef(persistedHead));
    } else if (head?.status === "sealed" && persistedHead?.status === "sealed") {
      await this.evidence.record(session, checkpointRef(persistedHead));
    }
    const activeDeltaCheckpoints = new Set([
      ...session.state.mutationEvidence,
      ...session.state.evidence
    ].flatMap((item) => item.kind === "workspace_delta" ? [item.data.checkpointId] : []));
    const restored = records.filter((item) => item.status === "restored"
      && (activeDeltaCheckpoints.has(item.checkpointId)
        || (head?.checkpointId === item.checkpointId && head.status !== "restored")))
      .sort((left, right) => (left.restoredAt ?? left.createdAt).localeCompare(
        right.restoredAt ?? right.createdAt
      ));
    for (const record of restored) {
      await this.options.emit(session, "checkpoint.restored", "runtime", checkpointRef(record));
    }
  }

  async resolveOpen(
    session: RuntimeSession,
    checkpointId: string,
    decision: "restore" | "keep",
    expectedCurrentManifestDigest: string
  ): Promise<CheckpointRef> {
    const records = await this.options.checkpoints.list(session.sessionId);
    const existing = records.find((item) => item.checkpointId === checkpointId);
    if (!existing) throw new Error(`Checkpoint ${checkpointId} does not exist.`);
    const resolved = decision === "restore"
      ? await this.restoreOpenDecision(session, existing, expectedCurrentManifestDigest)
      : await this.keepOpenDecision(session, existing, expectedCurrentManifestDigest);
    await this.options.emit(session, "checkpoint.recovery_resolved", "user", { checkpointId, decision });
    return resolved;
  }

  async recordChildDecision(
    session: RuntimeSession,
    recovery: ChildCheckpointRecovery,
    decision: "restore" | "keep"
  ): Promise<void> {
    await this.options.emit(session, "checkpoint.recovery_resolved", "user", {
      checkpointId: recovery.checkpointId,
      decision,
      sourceSessionId: recovery.sourceSessionId,
      childId: recovery.childId
    });
  }

  async applyChildDecision(
    session: RuntimeSession,
    recovery: ChildCheckpointRecovery,
    decision: "restore" | "keep"
  ): Promise<CheckpointRef> {
    const records = await this.options.checkpoints.list(recovery.sourceSessionId);
    const existing = records.find((item) => item.checkpointId === recovery.checkpointId);
    if (!existing) throw new Error(`Child checkpoint ${recovery.checkpointId} does not exist.`);
    if (decision === "restore") {
      if (existing.status === "restored") return checkpointRef(existing);
      const restored = existing.status === "open"
        ? await this.options.checkpoints.restoreOpen(
          recovery.sourceSessionId,
          recovery.checkpointId,
          recovery.currentManifestDigest
        )
        : await this.options.checkpoints.undoLatest(recovery.sourceSessionId);
      if (restored.checkpointId !== recovery.checkpointId || restored.status !== "restored") {
        throw new CheckpointConflictError(
          `Child checkpoint ${recovery.checkpointId} is not the latest safely restorable checkpoint.`
        );
      }
      return checkpointRef(restored);
    }
    const sealed = existing.status === "open"
      ? await this.options.checkpoints.seal(
        recovery.sourceSessionId,
        recovery.checkpointId,
        recovery.currentManifestDigest
      )
      : existing;
    if (sealed.status !== "sealed") {
      throw new CheckpointConflictError(`Child checkpoint ${recovery.checkpointId} cannot be kept from '${sealed.status}'.`);
    }
    const inspection = await this.options.checkpoints.inspectSealed(
      recovery.sourceSessionId,
      recovery.checkpointId
    );
    if (inspection.changed || inspection.currentManifestDigest !== recovery.currentManifestDigest) {
      throw new CheckpointConflictError(
        `Child checkpoint ${recovery.checkpointId} postimage changed after recovery was offered; keep was not completed.`
      );
    }
    const ref = checkpointRef(sealed);
    await this.evidence.recordImported(session, ref, recovery.sourceSessionId, recovery.childId);
    return ref;
  }

  async refreshChildRecovery(recovery: ChildCheckpointRecovery): Promise<ChildCheckpointRecovery> {
    const record = (await this.options.checkpoints.list(recovery.sourceSessionId))
      .find((item) => item.checkpointId === recovery.checkpointId);
    if (!record || record.status === "restored") return recovery;
    const currentManifestDigest = record.status === "open"
      ? (await this.options.checkpoints.inspectOpen(recovery.sourceSessionId, recovery.checkpointId)).currentManifestDigest
      : (await this.options.checkpoints.inspectSealed(recovery.sourceSessionId, recovery.checkpointId)).currentManifestDigest;
    return {
      ...recovery,
      checkpointStatus: record.status,
      currentManifestDigest
    };
  }

  private async restoreOpenDecision(
    session: RuntimeSession,
    existing: CheckpointRecord,
    expectedCurrentManifestDigest: string
  ): Promise<CheckpointRef> {
    const restored = existing.status === "open"
      ? checkpointRef(await this.options.checkpoints.restoreOpen(
        session.sessionId,
        existing.checkpointId,
        expectedCurrentManifestDigest
      ))
      : checkpointRef(existing);
    if (restored.status !== "restored") {
      throw new Error(`Checkpoint ${existing.checkpointId} was not restored by the requested recovery.`);
    }
    if (session.state.checkpointHead?.checkpointId !== restored.checkpointId
      || session.state.checkpointHead.status !== "restored") {
      await this.options.emit(session, "checkpoint.restored", "user", restored);
    }
    return restored;
  }

  private async keepOpenDecision(
    session: RuntimeSession,
    existing: CheckpointRecord,
    expectedCurrentManifestDigest: string
  ): Promise<CheckpointRef> {
    const sealed = existing.status === "open"
      ? checkpointRef(await this.options.checkpoints.seal(
        session.sessionId,
        existing.checkpointId,
        expectedCurrentManifestDigest
      ))
      : checkpointRef(existing);
    if (sealed.status !== "sealed") {
      throw new Error(`Checkpoint ${existing.checkpointId} was not sealed by the requested recovery.`);
    }
    if (session.state.checkpointHead?.checkpointId !== sealed.checkpointId
      || session.state.checkpointHead.status !== "sealed") {
      await this.evidence.record(session, sealed);
    }
    return sealed;
  }
}
