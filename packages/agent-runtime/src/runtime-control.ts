import { randomUUID } from "node:crypto";
import {
  isCompletionEligibleEvidence,
  type BudgetAmounts,
  type BudgetLimits,
  type CheckpointRef,
  type PlanGraph,
  type ReviewRequestResult,
  type RuntimeControlPort,
  type WorkspaceRestorationEvidenceV1
} from "agent-protocol";
import type { ChildCheckpointRecovery, RuntimeSession } from "./types.js";
import { ChildBudgetControl } from "./child-budget-control.js";
import { planAfterChildOutcome, planAfterChildRollback, type ChildPlanOutcome } from "./child-plan-transitions.js";
import { assertPlanTransition } from "./plan-policy.js";
import {
  checkpointRef,
  type OpenCheckpointRecoveryResult,
  type RuntimeControlServiceOptions
} from "./runtime-control-contracts.js";
import { RuntimeCheckpointControl } from "./runtime-checkpoint-control.js";
import { RuntimeSkillControl } from "./runtime-skill-control.js";
import { reviewReadiness } from "./review-coordinator.js";
import {
  currentFrontierReview,
  frontierValidationReadiness,
  latestFrontierReview,
  reviewBasisDigest
} from "./mutation-evidence.js";

export { DEFAULT_CHILD_BUDGET } from "./child-budget-control.js";

export type { OpenCheckpointRecoveryResult, RuntimeControlServiceOptions } from "./runtime-control-contracts.js";

function restorationFailure(message: string, code: string): never {
  throw Object.assign(new Error(message), { code });
}

function assertIsolatedRestorationCall(session: RuntimeSession, callId: string): void {
  const pending = session.durable.state.pendingTools;
  if (pending.length !== 1 || pending[0]?.request.callId !== callId || !pending[0].started
    || session.durable.state.activeModelTurn) {
    restorationFailure("Restoration requires one isolated runtime-control call.", "restoration_not_quiescent");
  }
}

function assertLocalRestorationState(
  session: RuntimeSession,
  callId: string,
  manualConfirmation: boolean
): void {
  assertIsolatedRestorationCall(session, callId);
  if (session.durable.state.activeProcessIds.length > 0) {
    restorationFailure("Restoration requires all processes to be settled.", "checkpoint_processes_active");
  }
  if (session.recovery.openCheckpointRecovery || session.durable.state.checkpointHead?.status === "open") {
    restorationFailure("Restoration requires the open checkpoint to be resolved.", "checkpoint_recovery_required");
  }
  if (session.durable.state.mutationFrontier.revision === 0) {
    restorationFailure("The current run has no mutation frontier to restore.", "restoration_mutation_missing");
  }
  if (session.durable.state.mutationFrontier.repositoryStateDigest) {
    restorationFailure("Repository metadata must be restored and verified separately.", "repository_restoration_required");
  }
  if (manualConfirmation && session.durable.state.taskControl.goalEpochSource !== "steer") {
    restorationFailure("Manual restoration confirmation requires a current user steer.", "restoration_steer_required");
  }
}

export class RuntimeControlService {
  private readonly planQueues = new Map<string, Promise<void>>();
  private readonly checkpoints: RuntimeCheckpointControl;
  private readonly childBudgets: ChildBudgetControl;
  private readonly skillControl: RuntimeSkillControl;

  constructor(private readonly options: RuntimeControlServiceOptions) {
    this.checkpoints = new RuntimeCheckpointControl(options);
    this.childBudgets = new ChildBudgetControl(options.budgets);
    this.skillControl = new RuntimeSkillControl(options);
  }

  forSession(session: RuntimeSession): RuntimeControlPort {
    return {
      readPlan: async () => structuredClone(session.durable.state.plan),
      updatePlan: async (input) => await this.updatePlan(session, input),
      readBudget: async () => structuredClone(session.durable.state.budget),
      listCheckpoints: async () => (await this.options.checkpoints.list(session.identity.sessionId)).map(checkpointRef),
      createCheckpoint: async (scopePaths) => await this.createCheckpoint(session, scopePaths),
      restoreRunCheckpoint: async (checkpointId) => await this.restoreRunCheckpoint(session, checkpointId),
      restoreRunChanges: async (callId) => await this.restoreRunChanges(session, callId),
      confirmRunRestored: async (callId) => await this.confirmRunRestored(session, callId),
      requestReview: async () => this.requestReview(session),
      loadSkill: async (qualifiedName) => await this.skillControl.loadSkill(session, qualifiedName),
      resolveLoadedSkillResource: async (input) => await this.skillControl.resolveLoadedSkillResource(session, input),
      reserveChildBudget: async (childId, allocation) => await this.reserveChildBudget(session, childId, allocation),
      settleChildBudget: async (childId, consumed) => await this.settleChildBudget(session, childId, consumed),
      releaseChildBudget: async (childId) => await this.releaseChildBudget(session, childId),
      rollbackChildPlanAssignment: async (childId, nodeIds, previousPlan) =>
        await this.rollbackChildPlanAssignment(session, childId, nodeIds, previousPlan)
    };
  }

  private requestReview(session: RuntimeSession): ReviewRequestResult {
    const readiness = reviewReadiness(session);
    const validation = frontierValidationReadiness(session);
    const frontier = session.durable.state.mutationFrontier;
    const currentReview = currentFrontierReview(session);
    const latestReview = latestFrontierReview(session);
    return {
      status: readiness.pending.length === 0
        ? "not_required"
        : readiness.eligible.length === 0 ? "validation_required"
          : readiness.blockedReview ? "changes_required" : "review_requested",
      reviewState: currentReview ? "current" : latestReview ? "stale" : "none",
      reviewBasisDigest: reviewBasisDigest(session),
      frontierRevision: frontier.revision,
      stateDigest: frontier.currentStateDigest,
      changedPaths: [...frontier.changedPaths],
      missingValidationPaths: validation.missingPaths,
      ...(readiness.blockedReview ? {
        findings: [...readiness.blockedReview.data.findings]
      } : {}),
      ...(readiness.retryableReview ? {
        findings: [...readiness.retryableReview.data.findings]
      } : {})
    };
  }

  async updatePlan(
    session: RuntimeSession,
    { expectedRevision, plan }: { expectedRevision: number; plan: PlanGraph },
    allowChildOwnedChanges = false
  ): Promise<PlanGraph> {
    return await this.serialPlan(session.identity.sessionId, async () =>
      await this.updatePlanLocked(session, expectedRevision, plan, allowChildOwnedChanges));
  }

  async updatePlanFromChildOutcome(
    session: RuntimeSession,
    input: ChildPlanOutcome
  ): Promise<PlanGraph> {
    return await this.serialPlan(session.identity.sessionId, async () => {
      const current = session.durable.state.plan;
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
    return await this.serialPlan(session.identity.sessionId, async () => {
      const current = session.durable.state.plan;
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
    if (session.durable.state.plan.revision !== expectedRevision) {
      throw Object.assign(new Error(`Plan revision conflict: expected ${expectedRevision}, actual ${session.durable.state.plan.revision}.`), {
        code: "plan_revision_conflict"
      });
    }
    const currentRunEvidence = new Map(session.durable.state.evidence
      .filter((item) => isCompletionEligibleEvidence(
        item,
        session.identity.sessionId,
        session.durable.runId
      ))
      .map((item) => [item.evidenceId, item] as const));
    assertPlanTransition(session.durable.state.plan, plan, currentRunEvidence, allowChildOwnedChanges);
    await this.options.emit(session, "plan.updated", "runtime", { previousRevision: expectedRevision, plan });
    await this.options.planChanged?.(session, expectedRevision, plan);
    return structuredClone(session.durable.state.plan);
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
    return await this.checkpoints.create(session, scopePaths);
  }

  async undoLatestCheckpoint(session: RuntimeSession): Promise<CheckpointRef> {
    return await this.checkpoints.undoLatest(session);
  }

  async restoreRunCheckpoint(session: RuntimeSession, checkpointId: string): Promise<CheckpointRef> {
    return await this.checkpoints.restoreRun(session, checkpointId);
  }

  async restoreRunChanges(
    session: RuntimeSession,
    callId: string
  ): Promise<WorkspaceRestorationEvidenceV1["data"]> {
    await this.assertRestorationQuiescence(session, callId, false);
    if (session.durable.state.mutationFrontier.repositoryStateDigest) {
      throw Object.assign(new Error("Workspace checkpoint restore cannot restore repository metadata."), {
        code: "repository_restoration_required"
      });
    }
    const inspection = await this.checkpoints.restoreRunChanges(session);
    return await this.recordRestorationEvidence(session, inspection, true);
  }

  async confirmRunRestored(
    session: RuntimeSession,
    callId: string
  ): Promise<WorkspaceRestorationEvidenceV1["data"]> {
    await this.assertRestorationQuiescence(session, callId, true);
    const inspection = await this.checkpoints.inspectRunRestoration(session);
    if (!inspection.restored) {
      throw Object.assign(new Error("Workspace does not match the run baseline."), {
        code: "workspace_not_restored"
      });
    }
    return await this.recordRestorationEvidence(session, inspection, false);
  }

  private async assertRestorationQuiescence(
    session: RuntimeSession,
    callId: string,
    manualConfirmation: boolean
  ): Promise<void> {
    assertLocalRestorationState(session, callId, manualConfirmation);
    if (await this.options.hasActiveChildren?.(session.identity.sessionId)) {
      restorationFailure("Restoration requires all child agents to be settled.", "checkpoint_children_active");
    }
  }

  private async recordRestorationEvidence(
    session: RuntimeSession,
    inspection: import("agent-checkpoint").RunRestorationInspection,
    explicitRestore: boolean
  ): Promise<WorkspaceRestorationEvidenceV1["data"]> {
    const frontier = session.durable.state.mutationFrontier;
    const data: WorkspaceRestorationEvidenceV1["data"] = {
      schemaVersion: 1,
      goalEpoch: session.durable.state.taskControl.goalEpoch,
      frontierRevision: frontier.revision,
      frontierStateDigest: frontier.currentStateDigest,
      baselineManifestDigest: inspection.baselineManifestDigest,
      currentManifestDigest: inspection.currentManifestDigest,
      restoredCheckpointIds: explicitRestore
        ? inspection.checkpoints.map((item) => item.checkpointId) : [],
      quiescence: {
        supersededExecutionStopped: true,
        noPendingMutations: true,
        noProcesses: true,
        noChildren: true,
        noOpenCheckpoint: true
      },
      repository: { status: "unchanged" }
    };
    const evidence: WorkspaceRestorationEvidenceV1 = {
      evidenceId: randomUUID(),
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      kind: "restoration",
      status: inspection.restored ? "passed" : "failed",
      createdAt: new Date().toISOString(),
      producer: { authority: "runtime", id: "workspace-restoration-v1" },
      summary: inspection.restored
        ? "The current goal epoch is quiescent and the workspace matches its run baseline."
        : "The workspace does not match its run baseline.",
      data
    };
    await this.options.emit(session, "evidence.recorded", "runtime", evidence);
    return data;
  }

  async sealCheckpoint(session: RuntimeSession, checkpointId: string): Promise<CheckpointRef> {
    return await this.checkpoints.seal(session, checkpointId);
  }

  async inspectOpenCheckpoint(
    session: RuntimeSession,
    checkpointId: string
  ): Promise<{ currentManifestDigest: string; delta: { added: string[]; modified: string[]; deleted: string[] } }> {
    return await this.checkpoints.inspectOpen(session, checkpointId);
  }

  async restorePolicyViolation(
    session: RuntimeSession,
    checkpointId: string,
    expectedCurrentManifestDigest: string
  ): Promise<CheckpointRef> {
    return await this.checkpoints.restorePolicyViolation(session, checkpointId, expectedCurrentManifestDigest);
  }

  async recoverOpen(session: RuntimeSession): Promise<OpenCheckpointRecoveryResult> {
    return await this.checkpoints.recoverOpen(session);
  }

  async resolveOpenCheckpoint(
    session: RuntimeSession,
    checkpointId: string,
    decision: "restore" | "keep",
    expectedCurrentManifestDigest: string
  ): Promise<CheckpointRef> {
    return await this.checkpoints.resolveOpen(session, checkpointId, decision, expectedCurrentManifestDigest);
  }

  async recordChildCheckpointDecision(
    session: RuntimeSession,
    recovery: ChildCheckpointRecovery,
    decision: "restore" | "keep"
  ): Promise<void> {
    await this.checkpoints.recordChildDecision(session, recovery, decision);
  }

  async recordChildCheckpointDecisionApplied(
    session: RuntimeSession,
    recovery: ChildCheckpointRecovery,
    decision: "restore" | "keep"
  ): Promise<void> {
    await this.checkpoints.recordChildDecisionApplied(session, recovery, decision);
  }

  async applyChildCheckpointDecision(
    session: RuntimeSession,
    recovery: ChildCheckpointRecovery,
    decision: "restore" | "keep"
  ): Promise<CheckpointRef> {
    return await this.checkpoints.applyChildDecision(session, recovery, decision);
  }

  async refreshChildCheckpointRecovery(
    recovery: ChildCheckpointRecovery
  ): Promise<ChildCheckpointRecovery> {
    return await this.checkpoints.refreshChildRecovery(recovery);
  }

}
