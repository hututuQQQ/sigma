import { randomUUID } from "node:crypto";
import type { CheckpointRef, ModelToolCall, ToolCallApproval, ToolCallPlan, ToolDescriptor, ToolReceipt } from "agent-protocol";
import { isToolAllowed, prepareToolCallPlan, ResourceLockManager } from "agent-tools";
import {
  completionFailure,
  completionPlan,
  completionPlanError,
  currentRunEvidence,
  failed,
  lockKeys,
  mergeDelta,
  workspaceWriteLockKey,
  writeScopeFailure
} from "./effect-helpers.js";
import { mutatingPlan, planAllowsMutation, turnPayload, type ToolAttempt } from "./effect-runner-helpers.js";
import type { EffectRunnerOptions } from "./effect-runner.js";
import { profileAllowsTool } from "./profile-policy.js";
import { assertToolReceiptIdentity, normalizeReceiptEvidence } from "./tool-evidence.js";
import {
  assertCheckpointActionAllowed,
  assertReceiptWithinPlan,
  validationScope,
  type FrozenValidationScope
} from "./tool-plan-enforcement.js";
import type { ToolExecutionMonitor } from "./tool-execution-monitor.js";
import type { RuntimeSession } from "./types.js";
import { WorkspaceMutationLease } from "./workspace-mutation-lease.js";
import { recordLostProcess, recordProcessReceipt } from "./process-lifecycle.js";
import { ToolApprovalCoordinator } from "./tool-approval-coordinator.js";
import { settleEligibleToolBudgets } from "./mutation-budget.js";
import { completionRepairPhase, descriptorAllowedForRepair, effectsAllowedForRepair } from "./tool-turn-policy.js";
import { failedExternalInputReceipt } from "./failed-input-evidence.js";
import {
  createMutationCheckpoint,
  delegatesWorkspaceMutation,
  executionFailureCode,
  failureCode,
  isToolReceipt,
  settleNoChangeProbe
} from "./tool-transaction-support.js";
interface PreparedTool extends ToolAttempt {
  descriptor: ToolDescriptor;
  plan: ToolCallPlan;
  startedAt: string;
  approval?: ToolCallApproval;
  validationScope?: FrozenValidationScope;
}
interface TransactionState { executionStarted: boolean }
export class ToolTransactionRunner {
  private readonly locks = new ResourceLockManager();
  private readonly workspaceLease = new WorkspaceMutationLease();
  private readonly approvals: ToolApprovalCoordinator;

  constructor(
    private readonly options: Pick<
      EffectRunnerOptions,
      "runtime" | "permissionMode" | "emit" | "finish" | "control" | "budgets" | "hooks"
    >,
    private readonly execution: ToolExecutionMonitor
  ) {
    this.approvals = new ToolApprovalCoordinator(options);
  }

  async execute(session: RuntimeSession, attempt: ToolAttempt, signal: AbortSignal): Promise<ToolReceipt> {
    const startedAt = new Date().toISOString();
    try {
      const prepared = await this.prepare(session, attempt, startedAt, signal);
      if (isToolReceipt(prepared)) return prepared;
      return await this.executePrepared(session, prepared, signal);
    } catch (error) {
      if ((error as { code?: unknown })?.code === "approval_needs_input") throw error;
      return failed(
        attempt.call,
        startedAt,
        error instanceof Error ? error.message : String(error),
        failureCode(error, signal)
      );
    }
  }

  async withWorkspaceWriteLock<T>(session: RuntimeSession, action: () => Promise<T>): Promise<T> {
    const locallyLocked = async (): Promise<T> =>
      await this.locks.withLocks([workspaceWriteLockKey(session)], action);
    return session.identity.workspaceLeaseInherited
      ? await locallyLocked()
      : await this.workspaceLease.withLease(session.identity.workspacePath, session.execution.controller?.signal, locallyLocked);
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
    if (!isToolAllowed(descriptor, session.durable.mode)) {
      return failed(call, startedAt, `Tool '${call.name}' is not allowed in ${session.durable.mode} mode.`, "mode_denied");
    }
    if (!profileAllowsTool(session, descriptor)) {
      return failed(call, startedAt, `Tool '${call.name}' is denied by the frozen Agent Profile.`, "profile_denied");
    }
    const repairPhase = completionRepairPhase(session);
    if (!descriptorAllowedForRepair(descriptor, repairPhase)) {
      return failed(
        call,
        startedAt,
        `Tool '${call.name}' was not offered for the active protocol-repair turn.`,
        "tool_unavailable_for_repair"
      );
    }
    const context = {
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      workspacePath: session.identity.workspacePath,
      runMode: session.durable.mode,
      runtimeControl: this.options.control.forSession(session)
    } as const;
    const plan = this.options.runtime.tools.prepare
      ? await this.options.runtime.tools.prepare({
        callId: call.id, name: call.name, arguments: call.arguments
      }, context)
      : await prepareToolCallPlan(descriptor, call.arguments, context);
    if (!effectsAllowedForRepair(plan.exactEffects, repairPhase)) {
      return failed(
        call,
        startedAt,
        `Tool '${call.name}' planned effects that were not offered for the active protocol-repair turn.`,
        "tool_unavailable_for_repair"
      );
    }
    const selectedValidationScope = validationScope(session, call, plan);
    await this.options.emit(session, "execution.planned", "runtime", {
      executionId: call.id, toolCallId: call.id, plan
    });
    const gateFailure = await this.preflight(session, call, descriptor, plan, startedAt, signal);
    return gateFailure ?? {
      ...attempt, descriptor, plan, startedAt,
      ...(selectedValidationScope ? { validationScope: selectedValidationScope } : {})
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
    if (session.durable.mode === "analyze" && mutatingPlan(plan)) {
      return failed(
        call,
        startedAt,
        `Tool '${call.name}' planned mutating effects that are not allowed in analyze mode.`,
        "mode_denied"
      );
    }
    if (session.durable.mode === "change" && mutatingPlan(plan) && !planAllowsMutation(session)) {
      return failed(
        call,
        startedAt,
        "A root-owned active in-progress plan node is required before mutation.",
        "plan_required"
      );
    }
    const scopeError = await writeScopeFailure(session, call, descriptor, startedAt, plan);
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
    const pending = session.durable.state.plan.nodes.filter((node) =>
      node.status !== "completed" && node.status !== "cancelled");
    if (currentRunEvidence(session).length === 0
      && session.durable.state.mutationFrontier.changedPaths.length === 0
      && pending.length === 1
      && pending[0]?.id === "root"
      && pending[0].status === "in_progress") {
      await this.options.emit(session, "evidence.recorded", "runtime", {
        evidenceId: randomUUID(),
        sessionId: session.identity.sessionId,
        runId: session.durable.runId,
        kind: "diagnostic",
        status: "passed",
        createdAt: startedAt,
        producer: { authority: "runtime", id: "completion" },
        summary: "The runtime accepted a completion intent with no net workspace changes.",
        data: {
          source: "runtime_completion_intent",
          diagnostic: { callId: call.id, noNetWorkspaceChanges: true }
        }
      });
    }
    const completed = completionPlan(session);
    if (completed) {
      const previousRevision = session.durable.state.plan.revision;
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
        sessionId: session.identity.sessionId,
        runId: session.durable.runId,
        mode: session.durable.mode,
        callId: call.id,
        toolName: call.name,
        arguments: call.arguments,
        plan
      }, signal);
      const decision = await this.approvals.decision(session, prepared, signal);
      if (decision === "deny") {
        session.interaction.callApprovals.delete(call.id);
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
      const code = failureCode(error, signal);
      const receipt = failed(
        call,
        startedAt,
        error instanceof Error ? error.message : String(error),
        code
      );
      return failedExternalInputReceipt(session, call, plan, receipt, code);
    }
  }

  private async runReserved(
    session: RuntimeSession,
    prepared: PreparedTool,
    reservationId: string,
    signal: AbortSignal
  ): Promise<ToolReceipt> {
    const keys = lockKeys(session, prepared.descriptor, prepared.plan);
    const state: TransactionState = { executionStarted: false };
    try {
      await this.execution.awaitSettled(keys, signal);
      const run = async (): Promise<ToolReceipt> => await this.locks.withLocks(keys, async () =>
        await this.runLocked(session, prepared, reservationId, signal, keys, state));
      return mutatingPlan(prepared.plan) && !delegatesWorkspaceMutation(prepared.plan)
        && !session.identity.workspaceLeaseInherited
        ? await this.workspaceLease.withLease(session.identity.workspacePath, signal, run)
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
    const scopeError = await writeScopeFailure(session, call, descriptor, startedAt, plan);
    if (scopeError) return scopeError;
    await assertCheckpointActionAllowed(
      session,
      plan,
      async () => await this.options.runtime.hasActiveChildren?.(session.identity.sessionId)
    );
    const noChange = await settleNoChangeProbe(
      this.options,
      session,
      prepared,
      signal,
      () => { state.executionStarted = true; }
    );
    if (noChange) return noChange;
    const checkpoint = await createMutationCheckpoint(this.options, session, plan);
    if (checkpoint) {
      await this.options.budgets.bindToolCheckpoint(
        session, reservationId, call.id, checkpoint.checkpointId
      );
    }
    state.executionStarted = true;
    await this.options.emit(session, "execution.started", "runtime", { executionId: call.id });
    return await this.executeAndSeal(session, prepared, checkpoint, signal, keys);
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
        session, call, modelTurn, descriptor, plan, signal, keys, prepared.approval);
      assertToolReceiptIdentity(rawReceipt, call.id);
      let receipt = rawReceipt;
      if (checkpoint) {
        const inspection = await this.options.control.inspectOpenCheckpoint(session, checkpoint.checkpointId);
        receipt = {
          ...rawReceipt,
          workspaceDelta: mergeDelta(rawReceipt.workspaceDelta, inspection.delta)
        };
      }
      await assertReceiptWithinPlan(session, receipt, plan);
      if (checkpoint) await this.options.control.sealCheckpoint(session, checkpoint.checkpointId);
      await recordProcessReceipt(session, call, plan, receipt, this.options.emit);
      const finalValidationScope = plan.exactEffects.includes("validation")
        && plan.exactEffects.includes("filesystem.write")
        ? validationScope(session, call, plan)
        : prepared.validationScope;
      const normalizedReceipt = normalizeReceiptEvidence(receipt, descriptor.name, plan, {
        sessionId: session.identity.sessionId,
        runId: session.durable.runId,
        workspaceDeltas: [],
        ...(finalValidationScope ? { validationScope: finalValidationScope } : {})
      });
      await this.options.emit(session, "execution.completed", "runtime", {
        executionId: call.id,
        evidenceIds: (normalizedReceipt.evidence ?? []).map((item) => item.evidenceId)
      });
      return normalizedReceipt;
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
            session.recovery.openCheckpointRecovery = {
              checkpointId: recovery.checkpointId,
              currentManifestDigest: recovery.currentManifestDigest
            };
            if (executionFailureCode(error) === "effect_plan_violation"
              && recovery.checkpointId === checkpoint.checkpointId) {
              await this.options.control.restorePolicyViolation(
                session,
                recovery.checkpointId,
                recovery.currentManifestDigest
              );
              session.recovery.openCheckpointRecovery = undefined;
            }
          }
        } catch (recoveryError) {
          session.recovery.openCheckpointRecovery ??= {
            checkpointId: checkpoint.checkpointId,
            // A preimage digest cannot authorize keeping/restoring a changed
            // postimage; it only provides a fail-closed placeholder until a
            // later inspection refreshes the recovery state.
            currentManifestDigest: checkpoint.preManifestDigest
          };
          throw Object.assign(new AggregateError(
            [error],
            "Failed to settle the mutation checkpoint after tool failure.",
            { cause: recoveryError }
          ), { code: "checkpoint_recovery_failed" });
        }
      }
      throw error;
    }
  }
}
