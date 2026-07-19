import type { JsonValue, ModelToolCall, ReviewEvidence, RunOutcome, ToolReceipt } from "agent-protocol";
import {
  completionRepairFailureMessage,
  completionSummary,
  blockedReport,
  failedTerminalRepairState,
  currentRunReferenceableEvidenceCount,
  protectedCompletionAnswer,
  requestedInput
} from "./model-convergence.js";
import {
  semanticInfrastructureFailureMessage,
  SEMANTIC_INFRASTRUCTURE_FAILURE_CODE
} from "./semantic-failures.js";
import { isCurrentModelTurn, modelTurn } from "./model-event-parsing.js";
import type { KernelState, PendingTool } from "./state.js";
import {
  actionableReview,
  advisoryReviewWarnings,
  boundedReviewFindings
} from "./terminal-review-helpers.js";

export function nextPhase(pending: readonly PendingTool[]): KernelState["phase"] {
  if (pending.some((item) => item.approval === "pending")) return "needs_input";
  if (pending.some((item) => item.started)) return "tool_in_flight";
  return pending.length > 0 ? "tool_pending" : "ready_model";
}

export function pendingForEvent(
  state: KernelState,
  payload: Record<string, JsonValue>
): PendingTool | undefined {
  const turn = modelTurn(payload);
  const callId = typeof payload.callId === "string" ? payload.callId : "";
  if (!turn || !callId) return undefined;
  return state.pendingTools.find((item) => item.request.callId === callId
    && item.modelTurn.turnId === turn.turnId
    && item.modelTurn.effectRevision === turn.effectRevision);
}

export function isRecoverySuspension(state: KernelState, payload: Record<string, JsonValue>): boolean {
  const checkpointRecovery = typeof payload.checkpointId === "string"
    && Array.isArray(payload.choices)
    && payload.choices.length === 2
    && payload.choices[0] === "restore"
    && payload.choices[1] === "keep";
  const processRecovery = Array.isArray(payload.processIds)
    && payload.processIds.length > 0
    && payload.processIds.every((item) => typeof item === "string" && item.length > 0);
  const interruptedModelRecovery = state.phase === "model_in_flight" && isCurrentModelTurn(state, payload);
  return checkpointRecovery || processRecovery || interruptedModelRecovery;
}

export function acceptsOutcomeRevision(state: KernelState, payload: Record<string, JsonValue>): boolean {
  if (payload.outcomeRevision === undefined) return true;
  return Number.isInteger(payload.outcomeRevision)
    && payload.outcomeRevision === state.revision - 1
    && state.phase === "outcome_pending";
}

export function terminalState(state: KernelState, outcome: RunOutcome): KernelState {
  return {
    ...state,
    phase: "terminal",
    activeModelTurn: undefined,
    activeModelSemanticDelta: undefined,
    pendingTools: [],
    completionRepairAttempts: 0,
    completionRepair: undefined,
    proposedOutcome: undefined,
    outcome
  };
}

export function proposedOutcomeState(state: KernelState, outcome: RunOutcome): KernelState {
  return {
    ...state,
    phase: "outcome_pending",
    activeModelTurn: undefined,
    activeModelSemanticDelta: undefined,
    proposedOutcome: outcome
  };
}

export function protectedToolBatchFailure(
  state: KernelState,
  calls: readonly ModelToolCall[]
): { code: "terminal_batch_conflict" | "terminal_protocol_invalid"; message: string } | null {
  const noChange = state.completionRepair?.kind === "no_change_confirmation";
  if (!noChange && state.completionRepair?.kind !== "protected_completion") return null;
  const allowed = noChange
    ? new Set(["confirm_no_change", "report_blocked", "request_user_input"])
    : new Set(["runtime_finalize", "report_blocked", "request_user_input"]);
  const terminal = allowed.has(calls[0]?.name ?? "");
  if (calls.length === 1 && terminal) return null;
  const terminalCount = calls.filter((call) => allowed.has(call.name)).length;
  return calls.length > 1 && terminalCount > 0
    ? {
        code: "terminal_batch_conflict",
        message: "The protected terminal-intent phase mixed a terminal action with another call."
      }
    : {
        code: "terminal_protocol_invalid",
        message: `The protected terminal-intent phase did not produce exactly one of: ${[...allowed].join(", ")}.`
      };
}

function terminalReceiptFailure(
  state: KernelState,
  progressed: KernelState,
  toolName: string,
  action: "complete" | "report_blocked" | "request_input"
): KernelState | null {
  const expectedTool = action === "complete"
    ? state.completionRepair?.kind === "no_change_confirmation" ? "confirm_no_change" : "runtime_finalize"
    : action === "report_blocked" ? "report_blocked" : "request_user_input";
  if (toolName === expectedTool) return null;
  return proposedOutcomeState(progressed, {
    kind: "recoverable_failure",
    code: "terminal_protocol_invalid",
    message: completionRepairFailureMessage(
      state,
      `Only the standard ${expectedTool} tool may produce this terminal outcome.`
    )
  });
}

function assistantBodyForToolCall(state: KernelState, callId: string): string | null {
  // Pending tools are created only from the latest model.completed message,
  // so the latest assistant message is the same model turn even for legacy
  // snapshots that did not retain toolCalls on the message itself.
  const message = [...state.messages].reverse().find((item) =>
    item.role === "assistant" && item.toolCalls?.some((call) => call.id === callId))
    ?? [...state.messages].reverse().find((item) => item.role === "assistant");
  if (!message || message.content.trim().length === 0) return null;
  return message.content;
}

function ordinaryCompletionMessage(answer: string | null, summary: string): string {
  if (!answer) return summary;
  const normalizedAnswer = answer.trim();
  const normalizedSummary = summary.trim();
  if (!normalizedSummary || normalizedAnswer.includes(normalizedSummary)) return answer;
  if (normalizedSummary.includes(normalizedAnswer)) return summary;
  return `${answer}\n\nResult: ${summary}`;
}

function reviewRepairState(
  state: KernelState,
  progressed: KernelState,
  review: ReviewEvidence
): KernelState {
  const findings = boundedReviewFindings(review);
  if (state.completionRepair?.kind === "review_changes_requested") {
    return proposedOutcomeState(progressed, {
      kind: "recoverable_failure",
      code: "review_changes_requested",
      message: `Independent review still has actionable error findings after the bounded correction opportunity.\n\n${findings}`
    });
  }
  return {
    ...progressed,
    phase: "ready_model",
    completionRepairAttempts: Math.max(1, state.completionRepairAttempts),
    completionRepair: {
      kind: "review_changes_requested",
      reviewEvidenceId: review.evidenceId
    },
    messages: [...progressed.messages, {
      role: "developer",
      content: `Independent review requested changes before completion. You have one bounded correction opportunity: repair the actionable errors or add independent current-frontier evidence that rebuts them, validate the result, and then finalize once. Do not repeat an unchanged completion proposal.\n\nReview evidence ${review.evidenceId}:\n${findings}`
    }]
  };
}

function hasCurrentActualFailedValidation(state: KernelState): boolean {
  return state.evidence.some((item) => item.kind === "validation"
    && item.status === "failed"
    && item.data.claim?.status !== "unavailable"
    && item.data.frontierRevision === state.mutationFrontier.revision
    && item.data.stateDigest === state.mutationFrontier.currentStateDigest);
}

function currentFrontierEvidence(state: KernelState) {
  return state.evidence.filter((item) => {
    if (item.kind !== "validation" && item.kind !== "review") return true;
    return item.data.frontierRevision === state.mutationFrontier.revision
      && item.data.stateDigest === state.mutationFrontier.currentStateDigest;
  });
}

const CAPABILITY_FAILURE_FAMILIES = new Set([
  "container_unavailable",
  "executable_unavailable",
  "filesystem_acl_unsupported",
  "network_capability_unavailable",
  "sandbox_recovery_required",
  "toolchain_unavailable"
]);

/** Runtime-owned stable taxonomy for a model-reported durable blocker. */
export function canonicalReportedBlockerCode(state: KernelState): string {
  if (hasCurrentActualFailedValidation(state)) return "validation_failed";
  const evidence = currentFrontierEvidence(state);
  const reviewBlocked = evidence.some((item) => item.kind === "review"
    && (item.status === "failed" || item.data.verdict === "changes_requested"));
  if (reviewBlocked) return "review_blocked";
  const capabilityBlocked = evidence.some((item) => item.kind === "validation"
    && item.data.claim?.status === "unavailable")
    || CAPABILITY_FAILURE_FAMILIES.has(state.semanticFailureCluster?.family ?? "")
    || /(?:^|_)(?:capability|executable|toolchain)_unavailable$/u.test(state.semanticFailureCluster?.family ?? "");
  if (capabilityBlocked) return "capability_unavailable";
  if (evidence.some((item) => item.kind === "input_access" && item.status === "failed")) {
    return "input_unavailable";
  }
  return "reported_blocker";
}

const COMPLETION_PREREQUISITE_CODES = new Set([
  "validation_evidence_required",
  "validation_result_reporting_required",
  "review_evidence_required"
]);

function prerequisiteFingerprint(receipt: ToolReceipt): string {
  const result = receipt.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return JSON.stringify({ diagnostics: [...new Set(receipt.diagnostics)].sort() });
  }
  const strings = (value: JsonValue | undefined): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").sort() : [];
  return JSON.stringify({
    code: typeof result.code === "string" ? result.code : null,
    frontierRevision: typeof result.frontierRevision === "number" ? result.frontierRevision : null,
    stateDigest: typeof result.stateDigest === "string" ? result.stateDigest : null,
    missingClaims: strings(result.missingClaims),
    missingPaths: strings(result.missingPaths),
    diagnostics: [...new Set(receipt.diagnostics)].sort()
  });
}

function previousPrerequisiteReceipt(state: KernelState): ToolReceipt | undefined {
  return [...state.receipts].reverse().find((receipt) =>
    receipt.diagnostics.some((code) => COMPLETION_PREREQUISITE_CODES.has(code)));
}

function prerequisiteRetryCount(
  state: KernelState,
  receipt: ToolReceipt,
  previous: { retryCount: number } | undefined
): number {
  if (!previous) return 0;
  const prior = previousPrerequisiteReceipt(state);
  return prior && prerequisiteFingerprint(prior) === prerequisiteFingerprint(receipt)
    ? previous.retryCount + 1 : 0;
}

function isCompletionPrerequisiteFailure(input: TerminalReceiptTransition): boolean {
  if (input.toolName !== "runtime_finalize" || input.receipt.ok || input.remainingTools !== 0) return false;
  return input.receipt.diagnostics.some((code) => COMPLETION_PREREQUISITE_CODES.has(code));
}

function completionPrerequisiteRepair(input: TerminalReceiptTransition): KernelState | null {
  if (!isCompletionPrerequisiteFailure(input)) return null;
  const pending = input.state.pendingTools.find((item) => item.request.callId === input.receipt.callId);
  if (!pending) return null;
  const previous = input.state.completionRepair?.kind === "completion_prerequisite"
    ? input.state.completionRepair : undefined;
  const retryCount = prerequisiteRetryCount(input.state, input.receipt, previous);
  if (retryCount >= 2) {
    return proposedOutcomeState(input.progressed, {
      kind: "recoverable_failure",
      code: "convergence_no_progress",
      message: completionRepairFailureMessage(
        input.state,
        "Completion prerequisites remained unresolved after two correction turns."
      )
    });
  }
  const raw = pending.request.arguments;
  const summary = raw && typeof raw === "object" && !Array.isArray(raw)
    && typeof raw.summary === "string" ? raw.summary : "Task completion is awaiting required evidence.";
  return {
    ...input.progressed,
    phase: "ready_model",
    completionRepairAttempts: Math.max(1, input.state.completionRepairAttempts),
    completionRepair: {
      kind: "completion_prerequisite",
      answer: protectedCompletionAnswer(input.state)
        || assistantBodyForToolCall(input.state, input.receipt.callId)
        || summary,
      arguments: pending.request.arguments,
      originalCallId: previous?.originalCallId ?? input.receipt.callId,
      evidenceCount: currentRunReferenceableEvidenceCount(input.progressed),
      retryCount,
      modelTurn: pending.modelTurn
    }
  };
}

export interface TerminalReceiptTransition {
  state: KernelState;
  progressed: KernelState;
  receipt: ToolReceipt;
  toolName: string;
  remainingTools: number;
  repairPending: boolean;
  terminalRepairPending: boolean;
  semanticLimitReached: boolean;
}

function completionReceiptTransition(input: TerminalReceiptTransition): KernelState | null {
  const summary = completionSummary(input.receipt);
  if (!summary) return null;
  const failure = terminalReceiptFailure(input.state, input.progressed, input.toolName, "complete");
  if (failure) return failure;
  if (input.toolName === "confirm_no_change"
    && input.state.completionRepair?.kind === "no_change_confirmation") {
    return proposedOutcomeState(input.progressed, {
      kind: "completed",
      message: input.state.completionRepair.answer,
      evidence: input.progressed.evidence
    });
  }
  const blockingReview = input.toolName === "runtime_finalize"
    ? actionableReview(input.progressed) : undefined;
  if (blockingReview) return reviewRepairState(input.state, input.progressed, blockingReview);
  const sameTurnAnswer = assistantBodyForToolCall(input.state, input.receipt.callId);
  const latestAnswer = ordinaryCompletionMessage(sameTurnAnswer, summary);
  return proposedOutcomeState(input.progressed, {
    kind: "completed",
    // A protected substantive answer is intentionally immutable during its
    // terminal repair. On an ordinary completion, retain both handoff
    // surfaces so a generic same-turn status cannot hide
    // the structured completion summary.
    message: `${ordinaryCompletionMessage(protectedCompletionAnswer(input.state), latestAnswer)}${advisoryReviewWarnings(input.progressed)}`,
    evidence: input.progressed.evidence
  });
}

export function terminalReceiptTransition(input: TerminalReceiptTransition): KernelState | null {
  const inputMessage = requestedInput(input.receipt);
  if (inputMessage) {
    const failure = terminalReceiptFailure(input.state, input.progressed, input.toolName, "request_input");
    if (failure) return failure;
    return proposedOutcomeState(input.progressed, {
      kind: "needs_input",
      requestId: input.receipt.callId,
      message: inputMessage
    });
  }
  const blocked = blockedReport(input.receipt);
  if (blocked) {
    const failure = terminalReceiptFailure(input.state, input.progressed, input.toolName, "report_blocked");
    if (failure) return failure;
    return proposedOutcomeState(input.progressed, {
      kind: "recoverable_failure",
      code: canonicalReportedBlockerCode(input.progressed),
      message: blocked.message
    });
  }
  const completion = completionReceiptTransition(input);
  if (completion) return completion;
  const prerequisiteRepair = completionPrerequisiteRepair(input);
  if (prerequisiteRepair) return prerequisiteRepair;
  const failedRepair = failedTerminalRepairState(
    input.progressed,
    input.repairPending,
    input.terminalRepairPending,
    input.receipt,
    input.remainingTools
  );
  if (failedRepair) return failedRepair;
  if (input.semanticLimitReached && input.remainingTools === 0 && input.progressed.semanticFailureCluster) {
    return proposedOutcomeState(input.progressed, {
      kind: "recoverable_failure",
      code: SEMANTIC_INFRASTRUCTURE_FAILURE_CODE,
      message: semanticInfrastructureFailureMessage(input.progressed.semanticFailureCluster)
    });
  }
  return null;
}
