import { isCompletionReferenceableEvidence, type JsonValue, type ModelMessage, type ModelToolCall, type RunOutcome, type ToolReceipt } from "agent-protocol";
import type { KernelState } from "./state.js";

const TERMINAL_PROTOCOL_FAILURE_CODES = new Set([
  "invalid_completion_proposal",
  "invalid_blocked_report",
  "invalid_user_input_request",
  "internal_tool_denied",
  "mode_denied",
  "profile_denied",
  "terminal_batch_conflict",
  "tool_arguments_invalid",
  "tool_unavailable_for_repair",
  "unknown_tool"
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
  return state.completionRepair?.kind === "protected_completion"
    || state.completionRepair?.kind === "protected_recovery"
    || state.completionRepair?.kind === "completion_prerequisite"
    ? state.completionRepair.answer
    : null;
}

export function hasCompletionRepair(state: KernelState): boolean {
  return state.completionRepair !== undefined || state.completionRepairAttempts > 0;
}

export function completionRepairRequiresTerminalAction(state: KernelState): boolean {
  if (state.completionRepair?.kind === "evidence_acquisition") return false;
  if (state.completionRepair?.kind === "protected_recovery") return false;
  if (state.completionRepair?.kind === "completion_prerequisite") {
    return state.pendingTools.some((item) => item.request.name === "runtime_finalize");
  }
  if (state.completionRepair?.kind === "terminal_action"
    || state.completionRepair?.kind === "protected_completion") return true;
  // Compatibility for snapshots written before the explicit repair intent was
  // introduced. Newly reduced states always carry completionRepair.
  return state.completionRepairAttempts > 0 && hasCurrentRunEvidence(state);
}

export function currentRunReferenceableEvidenceCount(state: KernelState): number {
  return state.evidence.filter((item) =>
    isCompletionReferenceableEvidence(item, state.sessionId, state.runId)).length;
}

export function completionRepairFailureMessage(state: KernelState, detail: string): string {
  const answer = protectedCompletionAnswer(state);
  if (!answer || detail.startsWith(answer)) return detail;
  return `${answer}\n\n[Completion protocol repair failed: ${detail}]`;
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
  } catch {
    return null;
  }
}

export function requestedInput(receipt: ToolReceipt): string | null {
  if (!receipt.ok || !receipt.observedEffects.includes("outcome.request_input")) return null;
  try {
    const value = JSON.parse(receipt.output) as unknown;
    return value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string"
      ? (value as { message: string }).message : null;
  } catch {
    return null;
  }
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
  if (!repairPending || remainingTools !== 0) return null;
  const protocolCodes = receipt.diagnostics.filter((code) => TERMINAL_PROTOCOL_FAILURE_CODES.has(code));
  if (protocolCodes.length === 0 && !receipt.ok) {
    if (!terminalRepairPending) return null;
    const answer = protectedCompletionAnswer(state);
    return {
      ...state,
      completionRepairAttempts: 0,
      completionRepair: answer ? { kind: "protected_recovery", answer } : undefined
    };
  }
  if (protocolCodes.length === 0 && !terminalRepairPending) return null;
  const detail = protocolCodes.length > 0 ? protocolCodes.join(", ") : "terminal_action_missing";
  if (state.completionRepairAttempts < 2) {
    return {
      ...state,
      phase: "ready_model",
      completionRepairAttempts: state.completionRepairAttempts + 1,
      messages: [...state.messages, {
        role: "developer",
        content: `The terminal action was invalid (${detail}). Correct the arguments or continue repairing the reported blocker; all normal tools remain available.`
      }]
    };
  }
  return propose(state, {
    kind: "recoverable_failure",
    code: "convergence_no_progress",
    message: completionRepairFailureMessage(
      state,
      `The terminal action remained invalid after two correction turns (${detail}).`
    )
  });
}

export function conflictingTerminalBatch(
  calls: readonly ModelToolCall[],
  repairPending: boolean
): boolean {
  const completionCount = calls.filter((call) => call.name === "runtime_finalize").length;
  const blockedCount = calls.filter((call) => call.name === "report_blocked").length;
  const inputRequestCount = calls.filter((call) => call.name === "request_user_input").length;
  const terminalCount = completionCount + blockedCount + inputRequestCount;
  if (terminalCount === 0) return false;
  if (repairPending) return calls.length > 1 || terminalCount > 1;
  return inputRequestCount > 0 ? calls.length > 1 : terminalCount > 1;
}

export function repairConflictingTerminalBatch(
  state: KernelState,
  messages: ModelMessage[]
): KernelState {
  if (state.completionRepairAttempts >= 1) {
    return propose({ ...state, messages }, {
      kind: "recoverable_failure",
      code: "terminal_batch_conflict",
      message: completionRepairFailureMessage(
        state,
        "The model repeatedly mixed a terminal protocol action with other tool calls."
      )
    });
  }
  return {
    ...state,
    messages: [...messages, {
      role: "developer",
      content: "A terminal protocol action must be the only call in its tool batch. Correct the call or continue ordinary repair work; all tools remain available."
    }],
    completionRepairAttempts: state.completionRepairAttempts + 1,
    completionRepair: { kind: "terminal_action" },
    continuationAttempts: 0,
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
    if (state.continuationAttempts >= 2) {
      return propose({ ...state, messages }, {
        kind: "recoverable_failure",
        code: "model_output_limit",
        message: completionRepairFailureMessage(
          state,
          "The model reached its output limit repeatedly without producing a protocol action."
        )
      });
    }
    return { ...state, messages, continuationAttempts: state.continuationAttempts + 1, phase: "ready_model" };
  }
  if (payload.finishReason === "content_filter") {
    return propose({ ...state, messages }, {
      kind: "fatal",
      code: "content_filter",
      message: completionRepairFailureMessage(state, "Provider blocked the response.")
    });
  }
  if (payload.finishReason !== "protocol_error") return null;
  return propose({ ...state, messages }, {
    kind: "recoverable_failure",
    code: "model_protocol_error",
    message: completionRepairFailureMessage(
      state,
      "The provider ended the model response at an invalid protocol boundary."
    )
  });
}

export function incompleteModelCompletion(
  state: KernelState,
  payload: Record<string, JsonValue>,
  messages: ModelMessage[]
): KernelState {
  const earlyState = earlyFinishReasonState(state, payload, messages);
  if (earlyState) return earlyState;
  const response = [...messages].reverse().find((message) => message.role === "assistant")?.content.trim() ?? "";
  if (!response) {
    return propose({ ...state, messages }, {
      kind: "recoverable_failure",
      code: hasCompletionRepair(state) ? "terminal_protocol_missing" : "model_no_action",
      message: completionRepairFailureMessage(
        state,
        hasCompletionRepair(state)
          ? "The model's protocol-repair turn stopped without choosing a terminal action."
          : "The model stopped without a response or tool call."
      )
    });
  }
  const turnId = typeof payload.turnId === "number" ? payload.turnId : 0;
  const effectRevision = typeof payload.effectRevision === "number" ? payload.effectRevision : state.revision;
  const call = {
    id: `runtime_completion_intent_${turnId}_${effectRevision}`,
    name: "runtime_finalize",
    arguments: { summary: response }
  };
  const projectedMessages = messages.map((message, index) => index === messages.length - 1
    && message.role === "assistant" ? { ...message, toolCalls: [call] } : message);
  return {
    ...state,
    messages: projectedMessages,
    pendingTools: [{
      request: { callId: call.id, name: call.name, arguments: call.arguments },
      modelTurn: { turnId, effectRevision },
      approval: "not_required",
      started: false
    }],
    toolCallIds: [...state.toolCallIds, call.id],
    phase: "tool_pending"
  };
}
