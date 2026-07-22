import type { JsonValue, ModelToolCall, RunOutcome, ToolReceipt } from "agent-protocol";
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
  semanticInfrastructureFailureMessage
} from "./semantic-failures.js";
import { isCurrentModelTurn, modelTurn } from "./model-event-parsing.js";
import type { KernelState, PendingTool } from "./state.js";
import {
  completionEvidenceObligation,
  protectCompletionCandidate,
  recordToolPolicyViolation
} from "./task-control.js";

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
    taskControl: {
      ...state.taskControl,
      phase: "terminal",
      policyCorrection: undefined
    },
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
  if (!state.taskControl.completionCandidate || state.taskControl.phase !== "terminal") return null;
  const terminal = calls[0]?.name === "runtime_finalize" || calls[0]?.name === "report_blocked"
    || calls[0]?.name === "request_user_input";
  if (calls.length === 1 && terminal) return null;
  const terminalCount = calls.filter((call) =>
    call.name === "runtime_finalize" || call.name === "report_blocked" || call.name === "request_user_input").length;
  return calls.length > 1 && terminalCount > 0
    ? {
        code: "terminal_batch_conflict",
        message: "The protected terminal-intent repair mixed a terminal action with another call."
      }
    : {
        code: "terminal_protocol_invalid",
        message: "The protected terminal-intent repair did not produce exactly one runtime completion intent or request_user_input call."
      };
}

function terminalReceiptFailure(
  state: KernelState,
  progressed: KernelState,
  toolName: string,
  action: "complete" | "report_blocked" | "request_input"
): KernelState | null {
  const expectedTool = action === "complete" ? "runtime_finalize"
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

function advisoryReviewWarnings(state: KernelState): string {
  const frontier = state.mutationFrontier;
  const review = state.evidence.filter((item): item is Extract<typeof item, { kind: "review" }> => item.kind === "review"
    && item.data.frontierRevision === frontier.revision
    && item.data.stateDigest === frontier.currentStateDigest).at(-1);
  if (!review || (review.status === "passed" && review.data.findings.length === 0)) return "";
  const findings = review.data.findings.slice(0, 20).map((item) =>
    `- ${typeof item === "string" ? item : JSON.stringify(item)}`).join("\n");
  return `\n\nAdvisory review warnings:\n${findings || `- ${review.summary}`}`;
}

function hasCurrentFailedValidation(state: KernelState): boolean {
  return state.evidence.some((item) => item.kind === "validation"
    && item.status === "failed"
    && item.data.frontierRevision === state.mutationFrontier.revision
    && item.data.stateDigest === state.mutationFrontier.currentStateDigest);
}

function invalidBlockedReportState(state: KernelState, progressed: KernelState): KernelState | null {
  if (hasCurrentFailedValidation(progressed)) return null;
  const taskControl = recordToolPolicyViolation(
    progressed.taskControl,
    "invalid_blocked_report",
    progressed.revision
  );
  if (taskControl.phase === "terminal") {
    return proposedOutcomeState({ ...progressed, taskControl }, {
      kind: "recoverable_failure",
      code: "invalid_blocked_report",
      message: "report_blocked was repeated without a failed validation on the current workspace state."
    });
  }
  return {
    ...progressed,
    phase: "ready_model",
    taskControl,
    messages: [...progressed.messages, {
      role: "developer",
      content: "report_blocked requires a failed semantic validation on the current workspace state. Continue repair or validation, complete if the frontier is ready, or request user input only for a genuine user decision."
    }]
  };
}

const COMPLETION_PREREQUISITE_CODES = new Set([
  "validation_evidence_required",
  "validation_result_reporting_required",
  "review_evidence_required"
]);

function isCompletionPrerequisiteFailure(input: TerminalReceiptTransition): boolean {
  if (input.toolName !== "runtime_finalize" || input.receipt.ok || input.remainingTools !== 0) return false;
  return input.receipt.diagnostics.some((code) => COMPLETION_PREREQUISITE_CODES.has(code));
}

function completionPrerequisiteCode(input: TerminalReceiptTransition): string {
  return input.receipt.diagnostics.find((code) => COMPLETION_PREREQUISITE_CODES.has(code))
    ?? "completion_prerequisite_unresolved";
}

function completionPrerequisiteExhausted(input: TerminalReceiptTransition, retryCount: number): KernelState | null {
  if (retryCount < 2) return null;
  const failureCode = completionPrerequisiteCode(input);
  return proposedOutcomeState(input.progressed, {
    kind: "recoverable_failure",
    code: failureCode,
    message: completionRepairFailureMessage(
      input.state,
      `Completion prerequisite ${failureCode} remained unresolved after two correction turns.`
    )
  });
}

function completionCandidateForReceipt(input: TerminalReceiptTransition, summary: string): string {
  return protectedCompletionAnswer(input.state)
    || assistantBodyForToolCall(input.state, input.receipt.callId)
    || summary;
}

function withCompletionRepairAttempts(
  taskControl: KernelState["taskControl"],
  attempts: number
): KernelState["taskControl"] {
  return taskControl.obligation?.kind === "completion_evidence"
    ? { ...taskControl, obligation: { ...taskControl.obligation, attempts } }
    : taskControl;
}

function pendingCompletionTool(input: TerminalReceiptTransition): PendingTool | undefined {
  return input.state.pendingTools.find((item) => item.request.callId === input.receipt.callId);
}

function completionRepairSummary(pending: PendingTool): string {
  const raw = pending.request.arguments;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && typeof raw.summary === "string") {
    return raw.summary;
  }
  return "Task completion is awaiting required evidence.";
}

function completionPrerequisiteRepair(input: TerminalReceiptTransition): KernelState | null {
  if (!isCompletionPrerequisiteFailure(input)) return null;
  if (input.progressed.taskControl.obligation?.kind === "review_repair") {
    return { ...input.progressed, phase: "ready_model" };
  }
  const pending = pendingCompletionTool(input);
  if (!pending) return null;
  const previous = input.state.taskControl.obligation?.kind === "completion_evidence"
    ? input.state.taskControl.obligation : undefined;
  const retryCount = previous ? previous.attempts + 1 : 0;
  const exhausted = completionPrerequisiteExhausted(input, retryCount);
  if (exhausted) return exhausted;
  const summary = completionRepairSummary(pending);
  const protectedControl = protectCompletionCandidate(
    input.progressed.taskControl,
    completionCandidateForReceipt(input, summary)
  );
  const taskControl = completionEvidenceObligation(
    protectedControl,
    input.progressed.revision,
    "acquire",
    currentRunReferenceableEvidenceCount(input.progressed),
    {
      failureCode: previous?.failureCode ?? completionPrerequisiteCode(input),
      originalCallId: previous?.originalCallId ?? input.receipt.callId,
      arguments: pending.request.arguments
    }
  );
  return {
    ...input.progressed,
    phase: "ready_model",
    taskControl: withCompletionRepairAttempts(taskControl, retryCount)
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

function explicitTerminalFailure(input: TerminalReceiptTransition): KernelState | null {
  if (input.toolName !== "runtime_finalize" || input.receipt.ok || input.remainingTools !== 0) return null;
  const failureCode = input.receipt.diagnostics.find((code) =>
    code === "validation_failed" || code === "review_unavailable");
  if (!failureCode) return null;
  return proposedOutcomeState(input.progressed, {
    kind: "recoverable_failure",
    code: failureCode,
    message: completionRepairFailureMessage(input.state, input.receipt.output)
  });
}

function requestedInputTransition(input: TerminalReceiptTransition): KernelState | null {
  const message = requestedInput(input.receipt);
  if (!message) return null;
  return terminalReceiptFailure(input.state, input.progressed, input.toolName, "request_input")
    ?? proposedOutcomeState(input.progressed, {
      kind: "needs_input",
      requestId: input.receipt.callId,
      message
    });
}

function blockedReportTransition(input: TerminalReceiptTransition): KernelState | null {
  const report = blockedReport(input.receipt);
  if (!report) return null;
  return terminalReceiptFailure(input.state, input.progressed, input.toolName, "report_blocked")
    ?? invalidBlockedReportState(input.state, input.progressed)
    ?? proposedOutcomeState(input.progressed, {
      kind: "recoverable_failure",
      code: report.code,
      message: report.message
    });
}

function completionTransition(input: TerminalReceiptTransition): KernelState | null {
  const summary = completionSummary(input.receipt);
  if (!summary) return null;
  const failure = terminalReceiptFailure(input.state, input.progressed, input.toolName, "complete");
  if (failure) return failure;
  const sameTurnAnswer = assistantBodyForToolCall(input.state, input.receipt.callId);
  return proposedOutcomeState(input.progressed, {
    kind: "completed",
    message: `${ordinaryCompletionMessage(
      protectedCompletionAnswer(input.state) || sameTurnAnswer,
      summary
    )}${advisoryReviewWarnings(input.progressed)}`,
    evidence: input.progressed.evidence
  });
}

export function terminalReceiptTransition(input: TerminalReceiptTransition): KernelState | null {
  const terminalOutcome = requestedInputTransition(input)
    ?? blockedReportTransition(input)
    ?? completionTransition(input);
  if (terminalOutcome) return terminalOutcome;
  const explicitFailure = explicitTerminalFailure(input);
  if (explicitFailure) return explicitFailure;
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
  const terminalResolution = input.progressed.taskControl.obligation;
  if (input.semanticLimitReached && input.remainingTools === 0
    && terminalResolution?.kind === "terminal_resolution") {
    return proposedOutcomeState(input.progressed, {
      kind: "recoverable_failure",
      code: terminalResolution.failureCode,
      message: semanticInfrastructureFailureMessage(input.progressed)
    });
  }
  return null;
}
