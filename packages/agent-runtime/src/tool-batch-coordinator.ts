import type { ModelToolCall, ToolDescriptor, ToolOutcome, ToolReceipt } from "agent-protocol";
import type { ActiveModelTurn } from "agent-kernel";
import { loadNestedInstructions } from "agent-context";
import { isToolAllowed } from "agent-tools";
import { failed, requestTargets, requiresInstructionReplan, steeringRestart } from "./effect-helpers.js";
import { turnPayload, type ToolAttempt } from "./effect-runner-helpers.js";
import type { EffectRunnerOptions } from "./effect-runner.js";
import { currentFrontierReview, reviewBasisDigest } from "./mutation-evidence.js";
import { profileAllowsTool } from "./profile-policy.js";
import type { ReviewCoordinator } from "./review-coordinator.js";
import {
  completionRepairPhase,
  descriptorAllowedForRepair,
  maximumTaskControlCalls,
  type CompletionRepairPhase
} from "./tool-turn-policy.js";
import type { ToolTransactionRunner } from "./tool-transaction-runner.js";
import type { RuntimeSession } from "./types.js";

type DurableToolReceipt = ToolReceipt & { outcome: ToolOutcome };

function durableToolReceipt(receipt: ToolReceipt): DurableToolReceipt {
  const diagnosticCodes = [...new Set([
    ...(receipt.outcome?.diagnosticCodes ?? []),
    ...receipt.diagnostics
  ])];
  return {
    ...receipt,
    outcome: {
      status: receipt.ok ? "succeeded" : "failed",
      output: receipt.output,
      diagnosticCodes
    }
  };
}

function receiptToolName(
  session: RuntimeSession,
  receipt: ToolReceipt,
  modelTurn: ActiveModelTurn
): string {
  return session.durable.state.pendingTools.find((item) => item.request.callId === receipt.callId
    && item.modelTurn.turnId === modelTurn.turnId
    && item.modelTurn.effectRevision === modelTurn.effectRevision)?.request.name ?? "tool";
}

function shouldReviewReceipt(name: string, reviewMode: "off" | "advisory" | "required"): boolean {
  if (name === "runtime_finalize") return reviewMode !== "off";
  return reviewMode === "required" && name === "validate";
}

function settledReviewRequestReceipt(session: RuntimeSession, receipt: ToolReceipt): ToolReceipt {
  const review = currentFrontierReview(session);
  const basis = reviewBasisDigest(session);
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

function projectedToolNames(
  session: RuntimeSession,
  descriptors: readonly ToolDescriptor[],
  phase: CompletionRepairPhase
): Set<string> {
  return new Set(descriptors.filter((descriptor) => isToolAllowed(descriptor, session.durable.mode)
    && profileAllowsTool(session, descriptor)
    && descriptorAllowedForRepair(session, descriptor, phase)).map((descriptor) => descriptor.name));
}

function internalCompletion(attempt: ToolAttempt): boolean {
  return attempt.call.name === "runtime_finalize" && attempt.call.id.startsWith("runtime_completion_intent_");
}

const TERMINAL_TOOL_NAMES = new Set(["runtime_finalize", "report_blocked", "request_user_input"]);

function violatesToolProjection(
  session: RuntimeSession,
  attempts: readonly ToolAttempt[],
  offeredNames: ReadonlySet<string>,
  phase: CompletionRepairPhase
): boolean {
  const terminalCount = attempts.filter(({ call }) => TERMINAL_TOOL_NAMES.has(call.name)).length;
  const conflictingTerminalBatch = attempts.length > 1 && terminalCount > 0;
  // An ordinary turn may pair work with one terminal intent. The coordinator
  // executes ordinary work first and checks checkpoint recovery before the
  // terminal intent is allowed to run. Multiple terminal intents remain an
  // unambiguous protocol conflict. Single-call task control is otherwise
  // imposed only after an obligation has been opened.
  if (phase === "none") return terminalCount > 1;
  return conflictingTerminalBatch || attempts.length > maximumTaskControlCalls(session)
    || attempts.some((attempt) => !internalCompletion(attempt) && !offeredNames.has(attempt.call.name));
}

function terminalAttempt(attempt: ToolAttempt): boolean {
  return TERMINAL_TOOL_NAMES.has(attempt.call.name);
}

interface InstructionPreparation {
  loaded: boolean;
  failures: Set<string>;
}

export class ToolBatchCoordinator {
  constructor(
    private readonly options: EffectRunnerOptions,
    private readonly reviews: ReviewCoordinator,
    private readonly transactions: ToolTransactionRunner
  ) {}

  async execute(session: RuntimeSession, attempts: ToolAttempt[], signal: AbortSignal): Promise<void> {
    const turnController = session.execution.turnController ?? new AbortController();
    session.execution.turnController = turnController;
    const turnSignal = AbortSignal.any([signal, turnController.signal]);
    if (steeringRestart(turnSignal)) return;
    try {
      const phase = completionRepairPhase(session);
      const descriptors = new Map(this.options.runtime.tools.descriptors().map((item) => [item.name, item]));
      const modelDescriptors = this.options.runtime.tools.modelDescriptors?.() ?? [...descriptors.values()];
      if (violatesToolProjection(
        session,
        attempts,
        projectedToolNames(session, modelDescriptors, phase),
        phase
      )) {
        await this.rejectProjection(session, attempts, phase);
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

  private async rejectProjection(
    session: RuntimeSession,
    attempts: readonly ToolAttempt[],
    phase: CompletionRepairPhase
  ): Promise<void> {
    for (const { call, modelTurn } of attempts) {
      await this.emitReceipt(session, failed(
        call,
        new Date().toISOString(),
        `Tool batch is outside the active task-control projection (${phase}). Use one currently offered action.`,
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
      await this.reviews.maybeReview(session, signal, true, "workspace");
      receipt = settledReviewRequestReceipt(session, receipt);
    }
    await this.emitReceipt(session, receipt, modelTurn);
  }

  private async loadInstructions(
    session: RuntimeSession,
    call: ModelToolCall,
    descriptor: ToolDescriptor
  ): Promise<{ loaded: boolean; failure?: ToolReceipt }> {
    let discovered;
    try {
      discovered = await Promise.all(requestTargets(call, descriptor).map(async (targetPath) =>
        await loadNestedInstructions({ workspacePath: session.identity.workspacePath, targetPath })));
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "path_escape") throw error;
      return {
        loaded: false,
        failure: failed(call, new Date().toISOString(), error instanceof Error ? error.message : String(error), "path_escape")
      };
    }
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
    const name = receiptToolName(session, receipt, modelTurn);
    await this.emitDurableReceipt(session, receipt, modelTurn, name);
    try {
      await this.dispatchPostTool(session, receipt, name);
      await this.reviewAfterReceipt(session, name);
    } finally {
      await this.transactions.settleBudgetsAfterReceipt(session);
    }
  }

  private async emitDurableReceipt(
    session: RuntimeSession,
    receipt: ToolReceipt,
    modelTurn: ActiveModelTurn,
    name: string
  ): Promise<void> {
    await this.options.emit(session, receipt.ok ? "tool.completed" : "tool.failed", "tool", {
      ...durableToolReceipt(receipt), name, ...turnPayload(modelTurn)
    });
    for (const evidence of receipt.evidence ?? []) {
      await this.options.emit(session, "evidence.recorded", "tool", evidence);
    }
    await this.options.emit(session, "diagnostic", "runtime", {
      kind: "tool.batch_settled",
      callId: receipt.callId,
      ok: receipt.ok,
      evidenceIds: (receipt.evidence ?? []).map((item) => item.evidenceId),
      diagnosticCodes: [...new Set([...receipt.diagnostics, ...(receipt.outcome?.diagnosticCodes ?? [])])]
    });
  }

  private async dispatchPostTool(session: RuntimeSession, receipt: ToolReceipt, name: string): Promise<void> {
    await this.options.hooks.dispatch(session, "post_tool", {
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      callId: receipt.callId,
      toolName: name,
      ok: receipt.ok,
      diagnostics: receipt.diagnostics,
      actualEffects: receipt.actualEffects ?? receipt.observedEffects,
      evidenceIds: (receipt.evidence ?? []).map((item) => item.evidenceId),
      artifactRefs: receipt.artifactRefs ?? []
    }, session.execution.controller?.signal ?? new AbortController().signal);
  }

  private async reviewAfterReceipt(session: RuntimeSession, name: string): Promise<void> {
    if (session.recovery.openCheckpointRecovery) return;
    const reviewMode = session.services.profile?.profile.mutationPolicy.reviewMode ?? "advisory";
    if (!shouldReviewReceipt(name, reviewMode)) return;
    await this.reviews.maybeReview(
      session,
      session.execution.controller?.signal ?? new AbortController().signal,
      name === "request_review",
      name === "runtime_finalize" ? "completion" : "workspace"
    );
  }
}
