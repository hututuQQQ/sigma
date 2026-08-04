import type { ModelToolCall, ToolDescriptor, ToolReceipt } from "agent-protocol";
import type { ActiveModelTurn } from "agent-kernel";
import { loadNestedInstructions } from "agent-context";
import { isToolAllowed } from "agent-tools";
import {
  failed,
  projectModelToolDescriptors,
  requestTargets,
  requiresInstructionReplan,
  stableSessionModelToolProjectionCapabilities,
  steeringRestart
} from "./effect-helpers.js";
import { turnPayload, type ToolAttempt } from "./effect-runner-helpers.js";
import type { EffectRunnerOptions } from "./effect-runner.js";
import { currentFrontierReview, reviewBasisDigest } from "./mutation-evidence.js";
import { completionCandidate } from "./completion-evidence-gate.js";
import { profileAllowsTool } from "./profile-policy.js";
import type { ReviewCoordinator } from "./review-coordinator.js";
import type { ToolTransactionRunner } from "./tool-transaction-runner.js";
import type { RuntimeSession } from "./types.js";
import {
  READ_BATCH_TOOL_NAME,
  withReadBatchDescriptor
} from "./read-batch-tool.js";
import { ReadBatchExecutor } from "./read-batch-executor.js";
import { ToolReceiptRecorder } from "./tool-receipt-recorder.js";

function settledReviewRequestReceipt(session: RuntimeSession, receipt: ToolReceipt): ToolReceipt {
  const candidateDigest = completionCandidate(session)?.digest;
  const review = currentFrontierReview(session, candidateDigest);
  const basis = reviewBasisDigest(session, undefined, candidateDigest);
  if (review?.status === "passed" && review.data.verdict === "approved") {
    return {
      ...receipt,
      ok: true,
      output: JSON.stringify({
        status: "approved", reviewState: "current", reviewBasisDigest: basis,
        frontierRevision: review.data.frontierRevision, stateDigest: review.data.stateDigest
      }),
      diagnostics: []
    };
  }
  if (review?.data.verdict === "validation_required") {
    return {
      ...receipt,
      ok: false,
      output: JSON.stringify({
        status: "validation_required",
        reviewState: "current",
        reviewBasisDigest: basis,
        criteria: review.data.criteria ?? [],
        requiredValidations: review.data.requiredValidations ?? []
      }),
      diagnostics: ["review_validation_required"]
    };
  }
  if (review?.data.failureKind === "protocol") {
    return {
      ...receipt,
      ok: false,
      output: JSON.stringify({ status: "review_unavailable", reviewState: "current", reviewBasisDigest: basis }),
      diagnostics: ["review_unavailable"]
    };
  }
  if (review?.status === "failed") {
    return {
      ...receipt,
      ok: false,
      output: JSON.stringify({
        status: "changes_required", reviewState: "current", reviewBasisDigest: basis,
        findings: review.data.findings
      }),
      diagnostics: ["review_changes_required"]
    };
  }
  return receipt;
}

function projectedDirectTools(
  session: RuntimeSession,
  descriptors: readonly ToolDescriptor[]
): ToolDescriptor[] {
  return projectModelToolDescriptors(
    descriptors.filter((descriptor) =>
      isToolAllowed(descriptor, session.durable.mode)
      && profileAllowsTool(session, descriptor)),
    stableSessionModelToolProjectionCapabilities(session)
  );
}

const TERMINAL_TOOL_NAMES = new Set(["report_blocked", "request_user_input"]);
const BARRIER_TOOL_NAMES = new Set(["request_review", READ_BATCH_TOOL_NAME]);

function violatesToolProjection(
  attempts: readonly ToolAttempt[],
  offeredNames: ReadonlySet<string>
): boolean {
  const terminalCount = attempts.filter(({ call }) => TERMINAL_TOOL_NAMES.has(call.name)).length;
  const conflictingTerminalBatch = attempts.length > 1 && terminalCount > 0;
  const conflictingBarrierBatch = attempts.length > 1
    && attempts.some(({ call }) => BARRIER_TOOL_NAMES.has(call.name));
  return terminalCount > 1 || conflictingTerminalBatch || conflictingBarrierBatch
    || attempts.some((attempt) => !offeredNames.has(attempt.call.name));
}

function terminalAttempt(attempt: ToolAttempt): boolean {
  return TERMINAL_TOOL_NAMES.has(attempt.call.name);
}

interface InstructionPreparation {
  loaded: boolean;
  failures: Set<string>;
}

export class ToolBatchCoordinator {
  private readonly receipts: ToolReceiptRecorder;
  private readonly readBatches: ReadBatchExecutor;

  constructor(
    private readonly options: EffectRunnerOptions,
    private readonly reviews: ReviewCoordinator,
    private readonly transactions: ToolTransactionRunner
  ) {
    this.receipts = new ToolReceiptRecorder(options, transactions);
    this.readBatches = new ReadBatchExecutor(
      options,
      transactions,
      this.receipts,
      async (session, call, descriptor) => await this.loadInstructions(session, call, descriptor)
    );
  }

  async execute(session: RuntimeSession, attempts: ToolAttempt[], signal: AbortSignal): Promise<void> {
    const turnController = session.execution.turnController ?? new AbortController();
    session.execution.turnController = turnController;
    const turnSignal = AbortSignal.any([signal, turnController.signal]);
    if (steeringRestart(turnSignal)) return;
    try {
      const descriptors = new Map(this.options.runtime.tools.descriptors().map((item) => [item.name, item]));
      const modelDescriptors = this.options.runtime.tools.modelDescriptors?.() ?? [...descriptors.values()];
      const projectedDescriptors = projectedDirectTools(session, modelDescriptors);
      if (violatesToolProjection(
        attempts,
        new Set(withReadBatchDescriptor(projectedDescriptors).map((item) => item.name))
      )) {
        await this.rejectProjection(session, attempts);
        return;
      }
      if (attempts.length === 1 && attempts[0]!.call.name === READ_BATCH_TOOL_NAME) {
        await this.readBatches.execute(
          session,
          attempts[0]!,
          projectedDescriptors,
          turnSignal
        );
        return;
      }
      const instructions = await this.prepareInstructions(session, attempts, descriptors);
      const pending = attempts.filter((attempt) => !terminalAttempt(attempt));
      const completions = attempts.filter(terminalAttempt);
      if (await this.executePending(session, pending, completions, descriptors, instructions, turnSignal)) return;
      for (const completion of completions) {
        if (steeringRestart(turnSignal)) return;
        await this.executeAttempt(session, completion, descriptors, instructions, turnSignal);
      }
    } finally {
      if (session.execution.turnController === turnController) session.execution.turnController = null;
    }
  }

  async rejectForResourceBoundary(
    session: RuntimeSession,
    attempts: readonly ToolAttempt[],
    message: string
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    for (const { call, modelTurn } of attempts) {
      await this.emitReceipt(session, failed(
        call,
        startedAt,
        message,
        "budget_exhausted"
      ), modelTurn);
    }
  }

  private async rejectProjection(
    session: RuntimeSession,
    attempts: readonly ToolAttempt[]
  ): Promise<void> {
    for (const { call, modelTurn } of attempts) {
      await this.emitReceipt(session, failed(
        call,
        new Date().toISOString(),
        "Tool batch contains an unavailable tool or combines an explicit terminal action with another call. "
          + "Use currently offered tool names and schemas, and issue terminal or review-barrier actions alone.",
        "model_tool_policy_violation"
      ), modelTurn);
    }
  }

  private async prepareInstructions(
    session: RuntimeSession,
    attempts: readonly ToolAttempt[],
    descriptors: ReadonlyMap<string, ToolDescriptor>
  ): Promise<InstructionPreparation> {
    let loaded = false;
    const failures = new Set<string>();
    for (const attempt of attempts) {
      const descriptor = descriptors.get(attempt.call.name);
      if (!descriptor) continue;
      const result = await this.loadInstructions(session, attempt.call, descriptor);
      if (result.failure) {
        failures.add(attempt.call.id);
        await this.emitReceipt(session, result.failure, attempt.modelTurn);
      } else if (result.loaded) {
        loaded = true;
      }
    }
    return { loaded, failures };
  }

  private async executePending(
    session: RuntimeSession,
    pending: ToolAttempt[],
    deferredTerminal: readonly ToolAttempt[],
    descriptors: ReadonlyMap<string, ToolDescriptor>,
    instructions: InstructionPreparation,
    signal: AbortSignal
  ): Promise<boolean> {
    while (pending.length > 0) {
      if (steeringRestart(signal)) return true;
      const batch = pending.splice(0, this.options.maxParallelTools);
      await Promise.all(batch.map(async (attempt) =>
        await this.executeAttempt(session, attempt, descriptors, instructions, signal)));
      if (session.recovery.openCheckpointRecovery) {
        await this.rejectDeferredForCheckpoint(session, deferredTerminal);
        return await this.suspendForCheckpointRecovery(session);
      }
    }
    return false;
  }

  private async rejectDeferredForCheckpoint(
    session: RuntimeSession,
    deferred: readonly ToolAttempt[]
  ): Promise<void> {
    for (const { call, modelTurn } of deferred) {
      await this.emitReceipt(session, failed(
        call,
        new Date().toISOString(),
        "The terminal action was not executed because an open mutation checkpoint requires recovery.",
        "checkpoint_recovery_required"
      ), modelTurn);
    }
  }

  private async executeAttempt(
    session: RuntimeSession,
    attempt: ToolAttempt,
    descriptors: ReadonlyMap<string, ToolDescriptor>,
    instructions: InstructionPreparation,
    signal: AbortSignal
  ): Promise<void> {
    const { call, modelTurn } = attempt;
    if (instructions.failures.has(call.id)) return;
    const descriptor = descriptors.get(call.name);
    if (instructions.loaded && descriptor && requiresInstructionReplan(descriptor)) {
      const startedAt = new Date().toISOString();
      await this.options.emit(session, "tool.requested", "runtime", {
        callId: call.id, name: call.name, arguments: call.arguments, ...turnPayload(modelTurn)
      });
      await this.emitReceipt(session, failed(
        call,
        startedAt,
        "New nested project instructions were loaded. Re-evaluate the request and propose a new tool call that follows them.",
        "nested_instructions_require_replan"
      ), modelTurn);
      return;
    }
    let receipt = await this.transactions.execute(session, attempt, signal);
    if (call.name === "request_review" && receipt.ok) {
      await this.reviews.maybeReview(
        session,
        signal,
        true,
        completionCandidate(session) ? "completion" : "workspace"
      );
      receipt = settledReviewRequestReceipt(session, receipt);
    }
    await this.emitReceipt(session, receipt, modelTurn);
  }

  private async loadInstructions(
    session: RuntimeSession,
    call: ModelToolCall,
    descriptor: ToolDescriptor
  ): Promise<{ loaded: boolean; failure?: ToolReceipt }> {
    const discovered = await Promise.all(requestTargets(call, descriptor).map(async (targetPath) => {
      try {
        return await loadNestedInstructions({
          workspacePath: session.identity.workspacePath,
          targetPath
        });
      } catch (error) {
        // Nested AGENTS.md discovery is workspace-scoped. External absolute
        // paths are still decided by the selected tool's own read policy and
        // fresh approval, so instruction preloading must not preempt it.
        if ((error as { code?: unknown })?.code === "path_escape") return [];
        throw error;
      }
    }));
    const unseen = discovered.flat().filter((item) => !session.interaction.loadedContextIds.has(item.id));
    for (const item of unseen) {
      session.interaction.loadedContextIds.add(item.id);
      session.interaction.contextItems.push(item);
    }
    if (unseen.length === 0) return { loaded: false };
    await this.options.emit(session, "diagnostic", "runtime", {
      kind: "nested_instructions_loaded",
      callId: call.id,
      provenance: unseen.map((item) => item.provenance),
      items: unseen,
      affectsMutation: descriptor.possibleEffects.includes("filesystem.write")
    });
    return { loaded: true };
  }

  private async suspendForCheckpointRecovery(session: RuntimeSession): Promise<boolean> {
    const recovery = session.recovery.openCheckpointRecovery;
    if (!recovery) return false;
    return await this.options.finish(session, {
      kind: "needs_input",
      requestId: `checkpoint:${recovery.checkpointId}`,
      message: `Mutation checkpoint '${recovery.checkpointId}' contains an interrupted delta. Choose safe restore or keep before continuing.`
    }, undefined, { checkpointId: recovery.checkpointId, choices: ["restore", "keep"] });
  }

  private async emitReceipt(
    session: RuntimeSession,
    receipt: ToolReceipt,
    modelTurn: ActiveModelTurn
  ): Promise<void> {
    await this.receipts.record(session, receipt, modelTurn);
  }
}
