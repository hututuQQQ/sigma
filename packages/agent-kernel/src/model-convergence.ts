import { isCompletionReferenceableEvidence, type JsonValue, type ModelMessage, type ModelToolCall, type RunOutcome, type ToolReceipt } from "agent-protocol";
import type { KernelState } from "./state.js";

const TERMINAL_PROTOCOL_FAILURE_CODES = new Set([
  "invalid_completion_proposal",
  "invalid_user_input_request",
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
    ? state.completionRepair.answer
    : null;
}

export function hasCompletionRepair(state: KernelState): boolean {
  return state.completionRepair !== undefined || state.completionRepairAttempts > 0;
}

export function completionRepairRequiresTerminalAction(state: KernelState): boolean {
  if (state.completionRepair?.kind === "evidence_acquisition") return false;
  if (state.completionRepair?.kind === "protected_recovery") return false;
  if (state.completionRepair?.kind === "terminal_action"
    || state.completionRepair?.kind === "protected_completion") return true;
  // Compatibility for snapshots written before the explicit repair intent was
  // introduced. Newly reduced states always carry completionRepair.
  return state.completionRepairAttempts > 0 && hasCurrentRunEvidence(state);
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
    return value && typeof value === "object" && typeof (value as { summary?: unknown }).summary === "string"
      ? (value as { summary: string }).summary : null;
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
  return propose(state, {
    kind: "recoverable_failure",
    code: "terminal_protocol_invalid",
    message: completionRepairFailureMessage(
      state,
      `The model's protocol-repair action failed (${detail}).`
    )
  });
}

export function conflictingTerminalBatch(
  calls: readonly ModelToolCall[],
  repairPending: boolean
): boolean {
  const completionCount = calls.filter((call) => call.name === "complete_task").length;
  const inputRequestCount = calls.filter((call) => call.name === "request_user_input").length;
  const terminalCount = completionCount + inputRequestCount;
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
  const evidenceAvailable = hasCurrentRunEvidence(state);
  return {
    ...state,
    messages: [...messages, {
      role: "developer",
      content: evidenceAvailable
        ? "A terminal protocol action must be the only call in its tool batch. On this repair turn, call exactly one allowed terminal action."
        : "A terminal protocol action must be the only call in its tool batch. Completion is unavailable until current-run evidence exists; use only non-terminal evidence tools, or request user input alone when a concrete decision is required."
    }],
    completionRepairAttempts: state.completionRepairAttempts + 1,
    completionRepair: evidenceAvailable
      ? { kind: "terminal_action" }
      : { kind: "evidence_acquisition" },
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
  if (!hasCurrentRunEvidence(state)) {
    if (state.completionRepairAttempts >= 1) {
      return propose({ ...state, messages }, {
        kind: "recoverable_failure",
        code: "terminal_protocol_missing",
        message: "The model repeatedly stopped without obtaining current-run evidence or requesting user input."
      });
    }
    return {
      ...state,
      messages: [...messages, {
        role: "developer",
        content: "Your response did not obtain current-run durable evidence, so it cannot complete an actionable run. This repair turn requires a tool call: use an applicable non-completion tool to obtain referenceable durable evidence, or call request_user_input if a concrete user decision with a supported follow-up operation is required. If validation executes and fails, the next terminal action must report it with complete_task and validation_executed; no validation-waiver input exists. Do not repeat the natural-language response and do not call complete_task before evidence exists."
      }],
      completionRepairAttempts: state.completionRepairAttempts + 1,
      completionRepair: { kind: "evidence_acquisition" },
      phase: "ready_model"
    };
  }
  if (state.completionRepairAttempts >= 1) {
    return propose({ ...state, messages }, {
      kind: "recoverable_failure",
      code: "terminal_protocol_missing",
      message: completionRepairFailureMessage(
        state,
        "The model repeatedly stopped without choosing the required terminal protocol action."
      )
    });
  }
  return {
    ...state,
    messages: [...messages, {
      role: "developer",
      content: "Your evidence-backed response stopped without choosing its terminal protocol. The substantive response is now protected. This bounded repair turn requires exactly one terminal action: call complete_task with explicit criteria and exact evidenceId/kind/claim references when the task is finished, or call request_user_input with one concrete question only when a supported user decision would materially change the result. Evidence references within one criterion may use different claims. An exited failed validation must be reported as validation_executed and never as validation_passed or acceptance_met; no validation waiver exists. Non-terminal tools are unavailable. Do not repeat or revise the natural-language response."
    }],
    completionRepairAttempts: state.completionRepairAttempts + 1,
    completionRepair: {
      kind: "protected_completion",
      answer: protectedCompletionAnswer(state) ?? response
    },
    phase: "ready_model"
  };
}
