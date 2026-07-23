import {
  isCompletionReferenceableEvidence,
  type JsonValue,
  type ModelMessage,
  type ModelToolCall,
  type RunOutcome,
  type ToolReceipt
} from "agent-protocol";
import type { KernelState } from "./state.js";
import {
  protectCompletionCandidate,
  recordToolPolicyViolation,
  startActionBatch,
  taskControlAnswer,
  taskControlFailureMessage,
  terminalResolutionObligation
} from "./task-control.js";

const TERMINAL_PROTOCOL_FAILURE_CODES = new Set([
  "invalid_completion_proposal", "invalid_blocked_report", "invalid_user_input_request",
  "internal_tool_denied", "mode_denied", "profile_denied", "terminal_batch_conflict",
  "tool_arguments_invalid", "tool_unavailable_for_repair", "unknown_tool", "model_tool_policy_violation"
]);

function propose(state: KernelState, outcome: RunOutcome): KernelState {
  return {
    ...state,
    phase: "outcome_pending",
    activeModelTurn: undefined,
    activeModelSemanticDelta: undefined,
    proposedOutcome: outcome
  };
}

export function protectedCompletionAnswer(state: KernelState): string | null {
  return taskControlAnswer(state.taskControl);
}

export function hasCompletionRepair(state: KernelState): boolean {
  return Boolean(state.taskControl.obligation || state.taskControl.policyCorrection
    || state.taskControl.phase !== "normal");
}

export function completionRepairRequiresTerminalAction(state: KernelState): boolean {
  const obligation = state.taskControl.obligation;
  return state.taskControl.phase === "terminal"
    || obligation?.kind === "terminal_resolution"
    || obligation?.kind === "user_decision"
    || (obligation?.kind === "completion_evidence" && obligation.stage === "terminal");
}

export function currentRunReferenceableEvidenceCount(state: KernelState): number {
  return state.evidence.filter((item) =>
    isCompletionReferenceableEvidence(item, state.sessionId, state.runId)).length;
}

export function completionRepairFailureMessage(state: KernelState, detail: string): string {
  return taskControlFailureMessage(state.taskControl, detail);
}

export function completionSummary(receipt: ToolReceipt): string | null {
  if (!receipt.ok || !receipt.observedEffects.includes("outcome.propose")) return null;
  try {
    const value = JSON.parse(receipt.output) as unknown;
    if (!value || typeof value !== "object" || typeof (value as { summary?: unknown }).summary !== "string") return null;
    const proposal = value as { summary: string; warnings?: unknown };
    const warnings = Array.isArray(proposal.warnings)
      ? proposal.warnings.filter((item): item is string => typeof item === "string") : [];
    return warnings.length > 0
      ? `${proposal.summary}\n\nWarnings:\n${warnings.map((item) => `- ${item}`).join("\n")}`
      : proposal.summary;
  } catch { return null; }
}

export function requestedInput(receipt: ToolReceipt): string | null {
  if (!receipt.ok || !receipt.observedEffects.includes("outcome.request_input")) return null;
  try {
    const value = JSON.parse(receipt.output) as unknown;
    return value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string"
      ? (value as { message: string }).message : null;
  } catch { return null; }
}

export function blockedReport(receipt: ToolReceipt): { code: string; message: string } | null {
  if (!receipt.ok || !receipt.observedEffects.includes("outcome.report_blocked")) return null;
  try {
    const value = JSON.parse(receipt.output) as { code?: unknown; summary?: unknown; recoveryAttempted?: unknown };
    if (typeof value.code !== "string" || typeof value.summary !== "string") return null;
    const attempted = typeof value.recoveryAttempted === "string" && value.recoveryAttempted
      ? `\n\nRecovery attempted: ${value.recoveryAttempted}` : "";
    return { code: value.code, message: `${value.summary}${attempted}` };
  } catch { return null; }
}

export function failedTerminalRepairState(
  state: KernelState,
  repairPending: boolean,
  terminalRepairPending: boolean,
  receipt: ToolReceipt,
  remainingTools: number
): KernelState | null {
  if (remainingTools !== 0) return null;
  const protocolCodes = receipt.diagnostics.filter((code) => TERMINAL_PROTOCOL_FAILURE_CODES.has(code));
  if (protocolCodes.length === 0 && (!repairPending || !terminalRepairPending)) return null;
  const detail = protocolCodes.length > 0 ? protocolCodes.join(", ") : "terminal_action_missing";
  const batchPolicyRecorded = protocolCodes.some((code) =>
    code === "model_tool_policy_violation" || code === "tool_unavailable_for_repair");
  const taskControl = batchPolicyRecorded && state.taskControl.policyCorrection
    ? state.taskControl
    : recordToolPolicyViolation(
        state.taskControl,
        detail,
        state.revision
      );
  if (taskControl.phase !== "terminal") {
    return {
      ...state,
      phase: "ready_model",
      taskControl,
      messages: [...state.messages, {
        role: "developer",
        content: `The task-control action was rejected (${detail}). Use exactly one currently offered action.`
      }]
    };
  }
  return propose({ ...state, taskControl }, {
    kind: "recoverable_failure",
    code: taskControl.obligation?.kind === "terminal_resolution"
      ? taskControl.obligation.failureCode : "action_convergence_no_progress",
    message: completionRepairFailureMessage(state, `Task-control correction was rejected twice (${detail}).`)
  });
}

export function conflictingTerminalBatch(calls: readonly ModelToolCall[], repairPending: boolean): boolean {
  const terminal = calls.filter((call) => [
    "runtime_finalize", "report_blocked", "request_user_input"
  ].includes(call.name)).length;
  return terminal > 0 && (calls.length > 1 || terminal > 1 || (repairPending && calls.length !== 1));
}

export function repairConflictingTerminalBatch(state: KernelState, messages: ModelMessage[]): KernelState {
  const taskControl = recordToolPolicyViolation(
    state.taskControl,
    "terminal_batch_conflict",
    state.revision
  );
  return taskControl.phase === "terminal"
    ? propose({ ...state, messages, taskControl }, {
        kind: "recoverable_failure",
        code: taskControl.obligation?.kind === "terminal_resolution"
          ? taskControl.obligation.failureCode : "action_convergence_no_progress",
        message: completionRepairFailureMessage(state, "A terminal action was repeatedly mixed with another call.")
      })
    : {
        ...state,
        messages: [...messages, {
          role: "developer",
          content: "A terminal action must be the only call in its batch. Use exactly one currently offered action."
        }],
        taskControl,
        phase: "ready_model"
      };
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Diagnostic identity only; task progress never uses arguments or this signature. */
export function toolBatchSignature(calls: ModelToolCall[]): string {
  return calls.map((call) => `${call.name}:${canonicalJson(call.arguments)}`).sort().join("\n");
}

export function hasCurrentRunEvidence(state: KernelState): boolean {
  return state.evidence.some((item) => isCompletionReferenceableEvidence(item, state.sessionId, state.runId));
}

function earlyFinishReasonState(
  state: KernelState,
  payload: Record<string, JsonValue>,
  messages: ModelMessage[]
): KernelState | null {
  if (payload.finishReason === "length") {
    if (state.taskControl.modelContinuationAttempts >= 2) {
      return propose({ ...state, messages }, {
        kind: "recoverable_failure",
        code: "model_output_limit",
        message: completionRepairFailureMessage(state, "The model reached its output limit twice without an action.")
      });
    }
    return {
      ...state,
      messages,
      taskControl: {
        ...state.taskControl,
        modelContinuationAttempts: state.taskControl.modelContinuationAttempts + 1
      },
      phase: "ready_model"
    };
  }
  if (payload.finishReason === "content_filter") {
    return propose({ ...state, messages }, {
      kind: "fatal", code: "content_filter",
      message: completionRepairFailureMessage(state, "Provider blocked the response.")
    });
  }
  if (payload.finishReason !== "protocol_error") return null;
  return propose({ ...state, messages }, {
    kind: "recoverable_failure", code: "model_protocol_error",
    message: completionRepairFailureMessage(state, "The provider ended at an invalid protocol boundary.")
  });
}

function userDecisionResponseCorrection(
  state: KernelState,
  messages: ModelMessage[]
): KernelState | null {
  if (state.taskControl.obligation?.kind !== "user_decision") return null;
  const taskControl = recordToolPolicyViolation(
    state.taskControl,
    "user_decision_action_required",
    state.revision
  );
  if (taskControl.obligation?.kind === "terminal_resolution") {
    return propose({ ...state, messages, taskControl }, {
      kind: "recoverable_failure",
      code: "user_decision_action_required",
      message: "The task requires a concrete user decision, but no valid input request was produced."
    });
  }
  return {
    ...state,
    messages: [...messages, {
      role: "developer",
      content: "A runtime-authenticated user decision is pending. Use exactly the offered request_user_input action."
    }],
    taskControl,
    phase: "ready_model"
  };
}

function naturalStopRequestsInput(state: KernelState, response: string): boolean {
  return state.mode === "change"
    && state.mutationFrontier.changedPaths.length === 0
    && state.taskControl.obligation === undefined
    && hasCurrentRunEvidence(state)
    && /[?？]\s*$/u.test(response);
}

export function incompleteModelCompletion(
  state: KernelState,
  payload: Record<string, JsonValue>,
  messages: ModelMessage[]
): KernelState {
  const early = earlyFinishReasonState(state, payload, messages);
  if (early) return early;
  const decisionCorrection = userDecisionResponseCorrection(state, messages);
  if (decisionCorrection) return decisionCorrection;
  const response = [...messages].reverse().find((message) => message.role === "assistant")?.content.trim() ?? "";
  if (!response) {
    const prior = state.taskControl.obligation;
    if (prior?.kind === "terminal_resolution" && prior.failureCode === "empty_visible_response") {
      return propose({ ...state, messages }, {
        kind: "recoverable_failure", code: "model_no_action",
        message: "The model stopped twice without a visible response or tool call."
      });
    }
    return {
      ...state,
      messages: [...messages, {
        role: "developer",
        content: "Your previous turn had no visible response or tool call. Provide one concise visible result or exactly one offered terminal action."
      }],
      taskControl: terminalResolutionObligation(state.taskControl, state.revision, "empty_visible_response"),
      phase: "ready_model"
    };
  }
  const turnId = typeof payload.turnId === "number" ? payload.turnId : 0;
  const effectRevision = typeof payload.effectRevision === "number" ? payload.effectRevision : state.revision;
  const requestsInput = naturalStopRequestsInput(state, response);
  // A visible final question after workspace inspection is a waiting intent,
  // not a claim that the requested change is complete. Providers do not
  // always select the typed input tool even when their text clearly asks the
  // user, so normalize that protocol boundary just as we normalize ordinary
  // natural stops into runtime completion intents.
  const call: ModelToolCall = requestsInput ? {
    id: `runtime_input_intent_${turnId}_${effectRevision}`,
    name: "request_user_input",
    arguments: { message: response }
  } : {
    id: `runtime_completion_intent_${turnId}_${effectRevision}`,
    name: "runtime_finalize",
    arguments: { summary: response }
  };
  const projectedMessages = messages.map((message, index) => index === messages.length - 1
    && message.role === "assistant" ? { ...message, toolCalls: [call] } : message);
  const taskControl = startActionBatch(requestsInput
    ? state.taskControl
    : protectCompletionCandidate(state.taskControl, response));
  return {
    ...state,
    messages: projectedMessages,
    pendingTools: [{
      request: { callId: call.id, name: call.name, arguments: call.arguments },
      modelTurn: { turnId, effectRevision }, approval: "not_required", started: false
    }],
    toolCallIds: [...state.toolCallIds, call.id],
    taskControl,
    phase: "tool_pending"
  };
}
