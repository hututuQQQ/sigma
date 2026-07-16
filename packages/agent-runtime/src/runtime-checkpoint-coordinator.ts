import type { CheckpointRef } from "agent-protocol";
import type { RuntimeControlService } from "./runtime-control.js";
import type { EffectRunner } from "./effect-runner.js";
import type { RuntimeOptions, RuntimeSession } from "./types.js";
import { isChildCheckpointRecovery } from "./child-workspace-recovery.js";

export class RuntimeCheckpointCoordinator {
  private readonly activeSessions = new Set<string>();

  constructor(
    private readonly effects: EffectRunner,
    private readonly control: RuntimeControlService,
    private readonly hasActiveChildren?: RuntimeOptions["hasActiveChildren"]
  ) {}

  async undoLatest(session: RuntimeSession): Promise<CheckpointRef> {
    if (session.recovery.openCheckpointRecovery) {
      throw Object.assign(new Error("Resolve the interrupted open checkpoint before undoing a sealed checkpoint."), {
        code: "checkpoint_recovery_required"
      });
    }
    if (!new Set(["terminal", "needs_input", "ready_model"]).has(session.durable.state.phase)) {
      throw new Error(`Checkpoint undo is unavailable while session phase is '${session.durable.state.phase}'.`);
    }
    const restored = await this.withWorkspaceLock(session, async () =>
      await this.control.undoLatestCheckpoint(session));
    await this.effects.settleMutationBudgets(session);
    return restored;
  }

  async resolveOpen(
    session: RuntimeSession,
    checkpointId: string,
    decision: "restore" | "keep"
  ): Promise<CheckpointRef> {
    const recovery = session.recovery.openCheckpointRecovery;
    if (!recovery || recovery.checkpointId !== checkpointId) {
      throw Object.assign(new Error(`Checkpoint ${checkpointId} is not awaiting user recovery.`), {
        code: "checkpoint_recovery_not_pending"
      });
    }
    if (session.durable.state.phase !== "needs_input") {
      throw new Error("Open checkpoint recovery requires a NeedsInput session.");
    }
    try {
      const resolved = await this.withWorkspaceLock(session, async () => {
        if (!isChildCheckpointRecovery(recovery)) {
          return await this.control.resolveOpenCheckpoint(
            session,
            checkpointId,
            decision,
            recovery.currentManifestDigest
          );
        }
        // The human decision is durable before touching the foreign
        // checkpoint, so a crash can finish the same decision without asking
        // the model or user to choose again.
        await this.control.recordChildCheckpointDecision(session, recovery, decision);
        const applied = await this.control.applyChildCheckpointDecision(session, recovery, decision);
        await this.control.recordChildCheckpointDecisionApplied(session, recovery, decision);
        return applied;
      }, true);
      session.recovery.openCheckpointRecovery = undefined;
      await this.effects.settleMutationBudgets(session);
      return resolved;
    } catch (error) {
      if ((error as { code?: unknown })?.code === "checkpoint_conflict") {
        if (isChildCheckpointRecovery(recovery)) {
          session.recovery.openCheckpointRecovery = await this.control.refreshChildCheckpointRecovery(recovery);
        } else {
          const refreshed = await this.control.recoverOpen(session);
          session.recovery.openCheckpointRecovery = refreshed.kind === "needs_input"
            ? {
              checkpointId: refreshed.checkpointId,
              currentManifestDigest: refreshed.currentManifestDigest
            }
            : undefined;
        }
      }
      throw error;
    }
  }

  async replayRecordedChildDecision(session: RuntimeSession): Promise<CheckpointRef> {
    const recovery = session.recovery.openCheckpointRecovery;
    if (!isChildCheckpointRecovery(recovery) || !recovery.recordedDecision) {
      throw new Error("No durable child checkpoint recovery decision is pending replay.");
    }
    const resolved = await this.withWorkspaceLock(session, async () => {
      const applied = await this.control.applyChildCheckpointDecision(session, recovery, recovery.recordedDecision!);
      await this.control.recordChildCheckpointDecisionApplied(session, recovery, recovery.recordedDecision!);
      return applied;
    }, true);
    session.recovery.openCheckpointRecovery = undefined;
    await this.effects.settleMutationBudgets(session);
    return resolved;
  }

  private async withWorkspaceLock<T>(
    session: RuntimeSession,
    action: () => Promise<T>,
    allowInterruptedTools = false
  ): Promise<T> {
    if (this.activeSessions.has(session.identity.sessionId)) {
      throw Object.assign(new Error("Another checkpoint control operation is already active for this session."), {
        code: "checkpoint_busy"
      });
    }
    this.assertIdle(session, allowInterruptedTools);
    this.activeSessions.add(session.identity.sessionId);
    try {
      await this.effects.waitForQuiescence(session.identity.sessionId);
      return await this.effects.withWorkspaceWriteLock(session, async () => {
        this.assertIdle(session, allowInterruptedTools);
        if (await this.hasActiveChildren?.(session.identity.sessionId)) {
          throw Object.assign(new Error("Checkpoint control requires no running child agents."), {
            code: "checkpoint_children_active"
          });
        }
        return await action();
      });
    } finally {
      this.activeSessions.delete(session.identity.sessionId);
    }
  }

  private assertIdle(session: RuntimeSession, allowInterruptedTools = false): void {
    const pendingTools = session.durable.state.pendingTools.length > 0;
    if (session.execution.running || (pendingTools && !allowInterruptedTools) || session.execution.controller || session.execution.turnController) {
      throw Object.assign(new Error("Checkpoint control requires an idle session with no pending tools."), {
        code: "checkpoint_session_active"
      });
    }
  }
}
