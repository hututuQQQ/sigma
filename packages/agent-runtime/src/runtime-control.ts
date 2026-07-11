import { CheckpointConflictError, type CheckpointManager, type CheckpointRecord } from "agent-checkpoint";
import type { SkillCatalog, SkillExecutionManifest } from "agent-extensions";
import {
  type BudgetAmounts,
  type BudgetLimits,
  type CheckpointRef,
  type LoadedSkillResourceAccess,
  type PlanGraph,
  type RuntimeControlPort
} from "agent-protocol";
import type { BudgetController } from "./budget-controller.js";
import type { ChildCheckpointRecovery, RuntimeSession } from "./types.js";
import { CheckpointEvidenceRecorder } from "./checkpoint-evidence-recorder.js";
import { ChildBudgetControl } from "./child-budget-control.js";
import {
  planAfterChildOutcome,
  planAfterChildRollback,
  type ChildPlanOutcome
} from "./child-plan-transitions.js";
import { assertPlanTransition } from "./plan-policy.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import { RuntimeSkillControl } from "./runtime-skill-control.js";

export { DEFAULT_CHILD_BUDGET } from "./child-budget-control.js";

export interface RuntimeControlServiceOptions {
  checkpoints: CheckpointManager;
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
}

export type OpenCheckpointRecoveryResult =
  | { kind: "clean" }
  | { kind: "needs_input"; checkpointId: string; currentManifestDigest: string };

function checkpointRef(record: CheckpointRecord): CheckpointRef {
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

export class RuntimeControlService {
  private readonly planQueues = new Map<string, Promise<void>>();
  private readonly checkpointEvidence: CheckpointEvidenceRecorder;
  private readonly childBudgets: ChildBudgetControl;
  private readonly skillControl: RuntimeSkillControl;

  constructor(private readonly options: RuntimeControlServiceOptions) {
    this.checkpointEvidence = new CheckpointEvidenceRecorder(options.checkpoints, options.emit);
    this.childBudgets = new ChildBudgetControl(options.budgets);
    this.skillControl = new RuntimeSkillControl(options);
  }

  forSession(session: RuntimeSession): RuntimeControlPort {
    return {
      readPlan: async () => structuredClone(session.state.plan),
      updatePlan: async (input) => await this.updatePlan(session, input),
      readBudget: async () => structuredClone(session.state.budget),
      listCheckpoints: async () => (await this.options.checkpoints.list(session.sessionId)).map(checkpointRef),
      createCheckpoint: async (scopePaths) => await this.createCheckpoint(session, scopePaths),
      loadSkill: async (qualifiedName) => await this.skillControl.loadSkill(session, qualifiedName),
      resolveLoadedSkillResource: async (input) => await this.skillControl.resolveLoadedSkillResource(session, input),
      reserveChildBudget: async (childId, allocation) => await this.reserveChildBudget(session, childId, allocation),
      settleChildBudget: async (childId, consumed) => await this.settleChildBudget(session, childId, consumed),
      releaseChildBudget: async (childId) => await this.releaseChildBudget(session, childId),
      rollbackChildPlanAssignment: async (childId, nodeIds, previousPlan) =>
        await this.rollbackChildPlanAssignment(session, childId, nodeIds, previousPlan)
    };
  }

  async updatePlan(
    session: RuntimeSession,
    { expectedRevision, plan }: { expectedRevision: number; plan: PlanGraph },
    allowChildOwnedChanges = false
  ): Promise<PlanGraph> {
    return await this.serialPlan(session.sessionId, async () =>
      await this.updatePlanLocked(session, expectedRevision, plan, allowChildOwnedChanges));
  }

  async updatePlanFromChildOutcome(
    session: RuntimeSession,
    input: ChildPlanOutcome
  ): Promise<PlanGraph> {
    return await this.serialPlan(session.sessionId, async () => {
      const current = session.state.plan;
      const next = planAfterChildOutcome(current, input);
      if (!next) return structuredClone(current);
      return await this.updatePlanLocked(session, current.revision, next, true);
    });
  }

  async rollbackChildPlanAssignment(
    session: RuntimeSession,
    childId: string,
    nodeIds: string[],
    previousPlan: PlanGraph
  ): Promise<PlanGraph> {
    return await this.serialPlan(session.sessionId, async () => {
      const current = session.state.plan;
      const next = planAfterChildRollback(current, childId, nodeIds, previousPlan);
      if (!next) return structuredClone(current);
      return await this.updatePlanLocked(session, current.revision, next, true);
    });
  }

  private async updatePlanLocked(
    session: RuntimeSession,
    expectedRevision: number,
    plan: PlanGraph,
    allowChildOwnedChanges: boolean
  ): Promise<PlanGraph> {
    if (session.state.plan.revision !== expectedRevision) {
      throw Object.assign(new Error(`Plan revision conflict: expected ${expectedRevision}, actual ${session.state.plan.revision}.`), {
        code: "plan_revision_conflict"
      });
    }
    const currentRunEvidence = new Map(session.state.evidence
      .filter((item) => item.sessionId === session.sessionId && item.runId === session.runId)
      .map((item) => [item.evidenceId, item] as const));
    assertPlanTransition(session.state.plan, plan, currentRunEvidence, allowChildOwnedChanges);
    await this.options.emit(session, "plan.updated", "runtime", { previousRevision: expectedRevision, plan });
    await this.options.planChanged?.(session, expectedRevision, plan);
    return structuredClone(session.state.plan);
  }

  private async serialPlan<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.planQueues.get(sessionId) ?? Promise.resolve();
    let accept!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<T>((resolve, decline) => { accept = resolve; reject = decline; });
    const current = previous.then(async () => {
      try { accept(await operation()); } catch (error) { reject(error); }
    });
    const queued = current.finally(() => {
      if (this.planQueues.get(sessionId) === queued) this.planQueues.delete(sessionId);
    });
    this.planQueues.set(sessionId, queued);
    return await result;
  }

  async reserveChildBudget(
    session: RuntimeSession,
    childId: string,
    requested?: Partial<BudgetLimits>
  ): Promise<BudgetLimits> {
    return await this.childBudgets.reserve(session, childId, requested);
  }

  async settleChildBudget(
    session: RuntimeSession,
    childId: string,
    reported: Partial<BudgetAmounts> = {}
  ): Promise<void> {
    await this.childBudgets.settle(session, childId, reported);
  }

  async releaseChildBudget(session: RuntimeSession, childId: string): Promise<void> {
    await this.childBudgets.release(session, childId);
  }

  async createCheckpoint(session: RuntimeSession, scopePaths: string[]): Promise<CheckpointRef> {
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

  async undoLatestCheckpoint(session: RuntimeSession): Promise<CheckpointRef> {
    const restored = checkpointRef(await this.options.checkpoints.undoLatest(session.sessionId));
    await this.options.emit(session, "checkpoint.restored", "user", restored);
    return restored;
  }

  async sealCheckpoint(session: RuntimeSession, checkpointId: string): Promise<CheckpointRef> {
    const sealed = checkpointRef(await this.options.checkpoints.seal(session.sessionId, checkpointId));
    await this.checkpointEvidence.record(session, sealed);
    return sealed;
  }

  async recoverOpen(session: RuntimeSession): Promise<OpenCheckpointRecoveryResult> {
    const records = await this.options.checkpoints.list(session.sessionId);
    await this.reconcileCheckpointHead(session, records);
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
    await this.sealCheckpoint(session, open.checkpointId);
    return { kind: "clean" };
  }

  private async reconcileCheckpointHead(
    session: RuntimeSession,
    records: CheckpointRecord[]
  ): Promise<void> {
    const head = session.state.checkpointHead;
    const persistedHead = head ? records.find((item) => item.checkpointId === head.checkpointId) : undefined;
    if (head?.status === "open" && persistedHead?.status === "sealed") {
      await this.checkpointEvidence.record(session, checkpointRef(persistedHead));
    } else if (head?.status === "sealed" && persistedHead?.status === "sealed") {
      await this.checkpointEvidence.record(session, checkpointRef(persistedHead));
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

  async resolveOpenCheckpoint(
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

  async recordChildCheckpointDecision(
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

  async applyChildCheckpointDecision(
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
    await this.checkpointEvidence.recordImported(session, ref, recovery.sourceSessionId, recovery.childId);
    return ref;
  }

  async refreshChildCheckpointRecovery(
    recovery: ChildCheckpointRecovery
  ): Promise<ChildCheckpointRecovery> {
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
      await this.checkpointEvidence.record(session, sealed);
    }
    return sealed;
  }

}
