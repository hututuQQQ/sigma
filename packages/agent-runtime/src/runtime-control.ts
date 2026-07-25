import {
  isCompletionEligibleEvidence,
  isPlanGraph,
  type BudgetAmounts,
  type BudgetLimits,
  type CheckpointRef,
  type PlanGraph,
  type ModelPlanUpdateV2,
  type ModelPlanUpdateV3,
  type ModelPlanUpdateResultV3,
  type RuntimeControlPort,
  type WorkspaceRestorationEvidenceV1
} from "agent-protocol";
import type { CheckpointReviewMaterial } from "agent-checkpoint";
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
import { RuntimeRestorationControl } from "./runtime-restoration-control.js";
import { RuntimeSkillControl } from "./runtime-skill-control.js";
import { RuntimeInspectionControl } from "./runtime-inspection-control.js";
import {
  isLegacyPlanUpdate,
  modelPlanProjection,
  normalizedWorkPlan
} from "./runtime-plan-normalization.js";
import { runtimeReviewRequest } from "./runtime-review-request.js";

export { DEFAULT_CHILD_BUDGET } from "./child-budget-control.js";

export type {
  OpenCheckpointRecoveryResult,
  RuntimeControlServiceOptions
} from "./runtime-control-contracts.js";

export class RuntimeControlService {
  private readonly planQueues = new Map<string, Promise<void>>();
  private readonly checkpoints: RuntimeCheckpointControl;
  private readonly restoration: RuntimeRestorationControl;
  private readonly childBudgets: ChildBudgetControl;
  private readonly skillControl: RuntimeSkillControl;
  private readonly inspection: RuntimeInspectionControl;

  constructor(private readonly options: RuntimeControlServiceOptions) {
    this.checkpoints = new RuntimeCheckpointControl(options);
    this.restoration = new RuntimeRestorationControl(options, this.checkpoints);
    this.childBudgets = new ChildBudgetControl(options.budgets);
    this.skillControl = new RuntimeSkillControl(options);
    this.inspection = new RuntimeInspectionControl(options);
  }

  forSession(session: RuntimeSession): RuntimeControlPort {
    return {
      readPlan: async () => structuredClone(session.durable.state.plan),
      readWorkPlan: async () => modelPlanProjection(session.durable.state.plan),
      updatePlan: async (input) => await this.updatePlan(session, input),
      updateWorkPlan: async (input) => await this.updateWorkPlan(session, input),
      readBudget: async () => structuredClone(session.durable.state.budget),
      readWorkspaceFrontier: async (input) => this.inspection.readWorkspaceFrontier(session, input),
      readArtifact: async (input) => await this.inspection.readArtifact(session, input),
      listCheckpoints: async () => (await this.options.checkpoints.list(session.identity.sessionId)).map(checkpointRef),
      createCheckpoint: async (scopePaths) => await this.createCheckpoint(session, scopePaths),
      restoreRunCheckpoint: async (checkpointId) => await this.restoreRunCheckpoint(session, checkpointId),
      restoreRunChanges: async (callId) => await this.restoreRunChanges(session, callId),
      confirmRunRestored: async (callId) => await this.confirmRunRestored(session, callId),
      requestReview: async () => runtimeReviewRequest(session),
      loadSkill: async (qualifiedName) => await this.skillControl.loadSkill(session, qualifiedName),
      resolveLoadedSkillResource: async (input) => await this.skillControl.resolveLoadedSkillResource(session, input),
      reserveChildBudget: async (childId, allocation) => await this.reserveChildBudget(session, childId, allocation),
      settleChildBudget: async (childId, consumed) => await this.settleChildBudget(session, childId, consumed),
      releaseChildBudget: async (childId) => await this.releaseChildBudget(session, childId),
      rollbackChildPlanAssignment: async (childId, nodeIds, previousPlan) =>
        await this.rollbackChildPlanAssignment(session, childId, nodeIds, previousPlan)
    };
  }

  async consolidatedReviewMaterial(
    session: RuntimeSession,
    maxBytes = 8 * 1024 * 1024
  ): Promise<CheckpointReviewMaterial> {
    return await this.options.checkpoints.consolidatedReviewMaterial(
      session.identity.sessionId,
      session.durable.state.mutationFrontier.sourceCheckpointIds,
      maxBytes
    );
  }

  private planEvidence(
    session: RuntimeSession,
    evidenceIds: readonly string[]
  ): PlanGraph["nodes"][number]["evidence"] {
    const byId = new Map(session.durable.state.evidence
      .filter((item) => isCompletionEligibleEvidence(
        item, session.identity.sessionId, session.durable.runId
      ))
      .map((item) => [item.evidenceId, item] as const));
    return evidenceIds.map((evidenceId) => {
      const evidence = byId.get(evidenceId);
      if (!evidence || evidence.status === "failed") {
        throw Object.assign(
          new Error(`Plan evidence '${evidenceId}' is missing, failed, or outside the current run.`),
          { code: "plan_evidence_invalid" }
        );
      }
      return {
        evidenceId,
        kind: evidence.kind
      };
    });
  }

  private assertModelPlanActivity(plan: PlanGraph): void {
    const rootNodes = plan.nodes.filter((node) => node.owner.kind === "root");
    const inProgress = rootNodes.filter((node) => node.status === "in_progress");
    const byId = new Map(plan.nodes.map((node) => [node.id, node] as const));
    const executablePending = rootNodes.filter((node) => node.status === "pending"
      && node.dependencies.every((dependency) => byId.get(dependency)?.status === "completed"));
    const hasExecutableWork = inProgress.length > 0 || executablePending.length > 0;
    if (hasExecutableWork && (inProgress.length !== 1 || plan.activeNodeId !== inProgress[0]?.id)) {
      throw Object.assign(
        new Error("A plan with executable root work must have exactly one in_progress node and matching activeNodeId."),
        { code: "plan_active_node_invalid" }
      );
    }
    if (!hasExecutableWork && plan.activeNodeId !== undefined) {
      throw Object.assign(
        new Error("activeNodeId must be omitted when no root node is executable."),
        { code: "plan_active_node_invalid" }
      );
    }
  }

  async updateWorkPlan(
    session: RuntimeSession,
    input: ModelPlanUpdateV3 | ModelPlanUpdateV2
  ): Promise<ModelPlanUpdateResultV3> {
    return await this.serialPlan(session.identity.sessionId, async () =>
      await this.updateWorkPlanLocked(session, input));
  }

  private async updateWorkPlanLocked(
    session: RuntimeSession,
    input: ModelPlanUpdateV3 | ModelPlanUpdateV2
  ): Promise<ModelPlanUpdateResultV3> {
    if (isLegacyPlanUpdate(input)) return await this.updateLegacyWorkPlanLocked(session, input);
    const current = session.durable.state.plan;
    const normalized = normalizedWorkPlan(current, input);
    if (!normalized.changed) {
      return {
        status: "no_change",
        warnings: normalized.warnings,
        plan: modelPlanProjection(current)
      };
    }
    const updated = await this.updatePlanLocked(
      session,
      current.revision,
      normalized.proposed,
      false
    );
    return {
      status: normalized.warnings.length > 0 ? "normalized" : "updated",
      warnings: normalized.warnings,
      plan: modelPlanProjection(updated)
    };
  }

  private async updateLegacyWorkPlanLocked(
    session: RuntimeSession,
    input: ModelPlanUpdateV2
  ): Promise<ModelPlanUpdateResultV3> {
    const previousNodes = new Map(session.durable.state.plan.nodes.map((node) => [node.id, node] as const));
    const nodes = input.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      dependencies: node.dependencies ?? [],
      status: node.status,
      owner: node.owner ?? previousNodes.get(node.id)?.owner ?? { kind: "root" as const },
      acceptanceCriteria: node.acceptanceCriteria ?? [],
      evidence: node.evidence ?? this.planEvidence(session, node.evidenceIds ?? []),
      ...(node.blockedReason ? { blockedReason: node.blockedReason } : {}),
      ...(node.reopenReason ? { reopenReason: node.reopenReason } : {})
    }));
    const plan = {
      revision: input.expectedRevision + 1,
      goal: input.goal,
      ...(input.activeNodeId ? { activeNodeId: input.activeNodeId } : {}),
      nodes
    };
    if (!isPlanGraph(plan)) {
      throw Object.assign(new Error("Proposed work plan is invalid or cyclic."), {
        code: "plan_invalid"
      });
    }
    this.assertModelPlanActivity(plan);
    const updated = await this.updatePlanLocked(
      session,
      input.expectedRevision,
      plan,
      false
    );
    return { status: "updated", warnings: [], plan: modelPlanProjection(updated) };
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
    return await this.restoration.restoreRunChanges(session, callId);
  }

  async confirmRunRestored(
    session: RuntimeSession,
    callId: string
  ): Promise<WorkspaceRestorationEvidenceV1["data"]> {
    return await this.restoration.confirmRunRestored(session, callId);
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
