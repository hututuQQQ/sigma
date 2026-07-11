import type {
  CheckpointRef,
  ModelToolCall,
  ToolCallApproval,
  ToolCallPlan,
  ToolDescriptor,
  ToolReceipt,
  WorkspaceDeltaEvidence
} from "agent-protocol";
import { isToolAllowed, prepareToolCallPlan, ResourceLockManager } from "agent-tools";
import {
  completionFailure,
  completionPlan,
  completionPlanError,
  failed,
  lockKeys,
  workspaceWriteLockKey,
  writeScopeFailure
} from "./effect-helpers.js";
import {
  mutatingPlan,
  planAllowsMutation,
  turnPayload,
  type ToolAttempt
} from "./effect-runner-helpers.js";
import type { EffectRunnerOptions } from "./effect-runner.js";
import { profileAllowsTool } from "./profile-policy.js";
import {
  assertToolReceiptIdentity,
  effectsOutsidePlan,
  normalizeReceiptEvidence
} from "./tool-evidence.js";
import type { ToolExecutionMonitor } from "./tool-execution-monitor.js";
import type { RuntimeSession } from "./types.js";
import { WorkspaceMutationLease } from "./workspace-mutation-lease.js";
import { recordLostProcess, recordProcessReceipt } from "./process-lifecycle.js";
import { ToolApprovalCoordinator } from "./tool-approval-coordinator.js";
import { settleEligibleToolBudgets } from "./mutation-budget.js";
import { sessionMutationEvidence, unresolvedWorkspaceDeltas } from "./mutation-evidence.js";

interface PreparedTool extends ToolAttempt {
  descriptor: ToolDescriptor;
  plan: ToolCallPlan;
  startedAt: string;
  approval?: ToolCallApproval;
  validationTargetIds?: string[];
}

interface TransactionState {
  executionStarted: boolean;
}

function delegatesWorkspaceMutation(plan: ToolCallPlan): boolean {
  return plan.exactEffects.includes("agent.spawn") && plan.processMode === "background";
}

function isReceipt(value: PreparedTool | ToolReceipt): value is ToolReceipt {
  return "ok" in value;
}

function failureCode(error: unknown, signal: AbortSignal): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string") return code;
  return signal.aborted ? "tool_cancelled" : "tool_exception";
}

function executionFailureCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : "tool_exception";
}

function validationTargetIds(
  session: RuntimeSession,
  call: ModelToolCall,
  plan: ToolCallPlan
): string[] | undefined {
  if (!plan.exactEffects.includes("validation")) return undefined;
  const argumentsValue = call.arguments;
  const input = argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
    ? argumentsValue as Record<string, unknown> : {};
  const requested = input.workspaceDeltaEvidenceIds;
  if (requested === undefined) return undefined;
  if (!Array.isArray(requested) || requested.length === 0
    || requested.some((item) => typeof item !== "string" || item.length === 0)) {
    throw Object.assign(new Error(
      "workspaceDeltaEvidenceIds must be a non-empty array of unresolved workspace delta evidence IDs."
    ), { code: "validation_scope_invalid" });
  }
  const unresolved = new Set(unresolvedWorkspaceDeltas(session).map((item) => item.evidenceId));
  const ids = [...new Set(requested as string[])];
  const invalid = ids.filter((id) => !unresolved.has(id));
  if (invalid.length > 0) {
    throw Object.assign(new Error(
      `Validation targets are missing, foreign, or already covered: ${invalid.join(", ")}.`
    ), { code: "validation_scope_invalid" });
  }
  return ids;
}

function workspaceDeltas(session: RuntimeSession, selectedIds: string[] | undefined): WorkspaceDeltaEvidence[] {
  if (!selectedIds) return unresolvedWorkspaceDeltas(session);
  const byId = new Map(sessionMutationEvidence(session)
    .filter((item): item is WorkspaceDeltaEvidence => item.kind === "workspace_delta" && item.status === "passed")
    .map((item) => [item.evidenceId, item]));
  return selectedIds.map((id) => byId.get(id)).filter((item): item is WorkspaceDeltaEvidence => Boolean(item));
}

export class ToolTransactionRunner {
  private readonly locks = new ResourceLockManager();
  private readonly workspaceLease = new WorkspaceMutationLease();
  private readonly approvals: ToolApprovalCoordinator;

  constructor(
    private readonly options: Pick<
      EffectRunnerOptions,
      "runtime" | "permissionMode" | "emit" | "control" | "budgets" | "hooks"
    >,
    private readonly execution: ToolExecutionMonitor
  ) {
    this.approvals = new ToolApprovalCoordinator(options);
  }

  async execute(session: RuntimeSession, attempt: ToolAttempt, signal: AbortSignal): Promise<ToolReceipt> {
    const startedAt = new Date().toISOString();
    const prepared = await this.prepare(session, attempt, startedAt, signal);
    if (isReceipt(prepared)) return prepared;
    return await this.executePrepared(session, prepared, signal);
  }

  async withWorkspaceWriteLock<T>(session: RuntimeSession, action: () => Promise<T>): Promise<T> {
    const locallyLocked = async (): Promise<T> =>
      await this.locks.withLocks([workspaceWriteLockKey(session)], action);
    return session.workspaceLeaseInherited
      ? await locallyLocked()
      : await this.workspaceLease.withLease(session.workspacePath, session.controller?.signal, locallyLocked);
  }

  async settleBudgetsAfterReceipt(session: RuntimeSession): Promise<void> {
    await settleEligibleToolBudgets(session, this.options.budgets);
  }

  private async prepare(
    session: RuntimeSession,
    attempt: ToolAttempt,
    startedAt: string,
    signal: AbortSignal
  ): Promise<PreparedTool | ToolReceipt> {
    const { call, modelTurn } = attempt;
    const descriptor = this.options.runtime.tools.descriptors().find((item) => item.name === call.name);
    if (!descriptor) return failed(call, startedAt, `Unknown tool '${call.name}'.`, "unknown_tool");
    await this.options.emit(session, "tool.requested", "runtime", {
      callId: call.id, name: call.name, arguments: call.arguments, ...turnPayload(modelTurn)
    });
    if (!isToolAllowed(descriptor, session.mode)) {
      return failed(call, startedAt, `Tool '${call.name}' is not allowed in ${session.mode} mode.`, "mode_denied");
    }
    if (!profileAllowsTool(session, descriptor)) {
      return failed(call, startedAt, `Tool '${call.name}' is denied by the frozen Agent Profile.`, "profile_denied");
    }
    const context = {
      sessionId: session.sessionId,
      runId: session.runId,
      workspacePath: session.workspacePath,
      runMode: session.mode,
      runtimeControl: this.options.control.forSession(session)
    } as const;
    const plan = this.options.runtime.tools.prepare
      ? await this.options.runtime.tools.prepare({
        callId: call.id, name: call.name, arguments: call.arguments
      }, context)
      : await prepareToolCallPlan(descriptor, call.arguments, context);
    const selectedValidationTargets = validationTargetIds(session, call, plan);
    await this.options.emit(session, "execution.planned", "runtime", {
      executionId: call.id, toolCallId: call.id, plan
    });
    const gateFailure = await this.preflight(session, call, descriptor, plan, startedAt, signal);
    return gateFailure ?? {
      ...attempt, descriptor, plan, startedAt,
      ...(selectedValidationTargets ? { validationTargetIds: selectedValidationTargets } : {})
    };
  }

  private async preflight(
    session: RuntimeSession,
    call: ModelToolCall,
    descriptor: ToolDescriptor,
    plan: ToolCallPlan,
    startedAt: string,
    signal: AbortSignal
  ): Promise<ToolReceipt | undefined> {
    if (session.mode === "change" && mutatingPlan(plan) && !planAllowsMutation(session)) {
      return failed(
        call,
        startedAt,
        "A root-owned active in-progress plan node is required before mutation.",
        "plan_required"
      );
    }
    const scopeError = await writeScopeFailure(session, call, descriptor, startedAt);
    if (scopeError) return scopeError;
    const completionError = completionFailure(session, call, descriptor, startedAt);
    if (completionError) return completionError;
    return await this.completionGate(session, call, descriptor, startedAt, signal);
  }

  private async completionGate(
    session: RuntimeSession,
    call: ModelToolCall,
    descriptor: ToolDescriptor,
    startedAt: string,
    signal: AbortSignal
  ): Promise<ToolReceipt | undefined> {
    if (!descriptor.possibleEffects.includes("outcome.propose")) return undefined;
    const completed = completionPlan(session);
    if (completed) {
      const previousRevision = session.state.plan.revision;
      await this.options.emit(session, "plan.updated", "runtime", { previousRevision, plan: completed });
      await this.options.hooks.dispatch(session, "plan_changed", {
        previousRevision, plan: completed, source: "completion"
      }, signal);
    }
    return completionPlanError(session, call, startedAt) ?? undefined;
  }

  private async executePrepared(
    session: RuntimeSession,
    prepared: PreparedTool,
    signal: AbortSignal
  ): Promise<ToolReceipt> {
    const { call, plan, startedAt } = prepared;
    try {
      await this.options.hooks.dispatch(session, "pre_tool", {
        sessionId: session.sessionId,
        runId: session.runId,
        mode: session.mode,
        callId: call.id,
        toolName: call.name,
        arguments: call.arguments,
        plan
      }, signal);
      const decision = await this.approvals.decision(session, prepared, signal);
      if (decision === "deny") {
        session.callApprovals.delete(call.id);
        return failed(call, startedAt, "Tool request denied.", "permission_denied");
      }
      const approval = this.approvals.consume(session, prepared);
      const reservationId = await this.options.budgets.reserve(
        session,
        `tool:${call.id}`,
        { toolCalls: 1 }
      );
      return await this.runReserved(session, { ...prepared, ...(approval ? { approval } : {}) }, reservationId, signal);
    } catch (error) {
      return failed(
        call,
        startedAt,
        error instanceof Error ? error.message : String(error),
        failureCode(error, signal)
      );
    }
  }

  private async runReserved(
    session: RuntimeSession,
    prepared: PreparedTool,
    reservationId: string,
    signal: AbortSignal
  ): Promise<ToolReceipt> {
    const keys = lockKeys(session, prepared.descriptor);
    const state: TransactionState = { executionStarted: false };
    try {
      await this.execution.awaitSettled(keys, signal);
      const run = async (): Promise<ToolReceipt> => await this.locks.withLocks(keys, async () =>
        await this.runLocked(session, prepared, reservationId, signal, keys, state));
      return mutatingPlan(prepared.plan) && !delegatesWorkspaceMutation(prepared.plan)
        && !session.workspaceLeaseInherited
        ? await this.workspaceLease.withLease(session.workspacePath, signal, run)
        : await run();
    } finally {
      if (!state.executionStarted) await this.options.budgets.release(session, reservationId);
    }
  }

  private async runLocked(
    session: RuntimeSession,
    prepared: PreparedTool,
    reservationId: string,
    signal: AbortSignal,
    keys: string[],
    state: TransactionState
  ): Promise<ToolReceipt> {
    const { call, descriptor, plan, startedAt } = prepared;
    const scopeError = await writeScopeFailure(session, call, descriptor, startedAt);
    if (scopeError) return scopeError;
    const checkpoint = await this.createCheckpoint(session, call, plan);
    if (checkpoint) {
      await this.options.budgets.bindToolCheckpoint(
        session, reservationId, call.id, checkpoint.checkpointId
      );
    }
    state.executionStarted = true;
    await this.options.emit(session, "execution.started", "runtime", { executionId: call.id });
    return await this.executeAndSeal(session, prepared, checkpoint, signal, keys);
  }

  private async createCheckpoint(
    session: RuntimeSession,
    call: ModelToolCall,
    plan: ToolCallPlan
  ): Promise<CheckpointRef | undefined> {
    if (!mutatingPlan(plan) || delegatesWorkspaceMutation(plan)) return undefined;
    const scope = plan.checkpointScope.length > 0 ? plan.checkpointScope : ["."];
    return await this.options.control.createCheckpoint(session, scope);
  }

  private async executeAndSeal(
    session: RuntimeSession,
    prepared: PreparedTool,
    checkpoint: CheckpointRef | undefined,
    signal: AbortSignal,
    keys: string[]
  ): Promise<ToolReceipt> {
    const { call, modelTurn, descriptor, plan } = prepared;
    try {
      const rawReceipt = await this.execution.execute(
        session, call, modelTurn, descriptor, signal, keys, prepared.approval
      );
      assertToolReceiptIdentity(rawReceipt, call.id);
      this.assertEffectsWithinPlan(rawReceipt, plan);
      if (checkpoint) await this.options.control.sealCheckpoint(session, checkpoint.checkpointId);
      await recordProcessReceipt(session, call, plan, rawReceipt, this.options.emit);
      const receipt = normalizeReceiptEvidence(rawReceipt, descriptor.name, plan, {
        sessionId: session.sessionId,
        runId: session.runId,
        workspaceDeltas: plan.exactEffects.includes("validation")
          ? workspaceDeltas(session, prepared.validationTargetIds) : []
      });
      await this.options.emit(session, "execution.completed", "runtime", {
        executionId: call.id,
        evidenceIds: (receipt.evidence ?? []).map((item) => item.evidenceId)
      });
      return receipt;
    } catch (error) {
      await recordLostProcess(session, call, error, this.options.emit);
      await this.options.emit(session, "execution.failed", "runtime", {
        executionId: call.id,
        code: executionFailureCode(error),
        message: error instanceof Error ? error.message : String(error)
      });
      if (checkpoint) {
        try {
          const recovery = await this.options.control.recoverOpen(session);
          if (recovery.kind === "needs_input") {
            session.openCheckpointRecovery = {
              checkpointId: recovery.checkpointId,
              currentManifestDigest: recovery.currentManifestDigest
            };
          }
        } catch (recoveryError) {
          throw new AggregateError([error], "Failed to inspect the mutation checkpoint after tool failure.", {
            cause: recoveryError
          });
        }
      }
      throw error;
    }
  }

  private assertEffectsWithinPlan(receipt: ToolReceipt, plan: ToolCallPlan): void {
    const outside = effectsOutsidePlan(receipt, plan);
    if (outside.length === 0) return;
    throw Object.assign(new Error(
      `Tool observed effects outside its approved plan: ${outside.join(", ")}.`
    ), { code: "effect_plan_violation" });
  }

}
