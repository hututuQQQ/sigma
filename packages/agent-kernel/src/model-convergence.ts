import { isCompletionEligibleEvidence, type JsonValue, type ModelMessage, type ModelToolCall, type RunOutcome, type ToolReceipt } from "agent-protocol";
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
    return terminalRepairPending ? { ...state, completionRepairAttempts: 0 } : null;
  }
  if (protocolCodes.length === 0 && !terminalRepairPending) return null;
  const detail = protocolCodes.length > 0 ? protocolCodes.join(", ") : "terminal_action_missing";
  return propose(state, {
    kind: "recoverable_failure",
    code: "terminal_protocol_missing",
    message: `The model's protocol-repair action failed (${detail}).`
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
      message: "The model repeatedly mixed a terminal protocol action with other tool calls."
    });
  }
  return {
    ...state,
    messages: [...messages, {
      role: "developer",
      content: "A terminal protocol action must be the only call in its tool batch. On this repair turn, either call exactly one allowed terminal action, or issue only non-terminal calls and decide the outcome on a later turn."
    }],
    completionRepairAttempts: state.completionRepairAttempts + 1,
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
  return state.evidence.some((item) => isCompletionEligibleEvidence(item, state.sessionId, state.runId));
}

export function incompleteModelCompletion(
  state: KernelState,
  payload: Record<string, JsonValue>,
  messages: ModelMessage[]
): KernelState {
  if (payload.finishReason === "length") {
    if (state.continuationAttempts >= 2) {
      return propose({ ...state, messages }, {
        kind: "recoverable_failure",
        code: "model_output_limit",
        message: "The model reached its output limit repeatedly without producing a protocol action."
      });
    }
    return { ...state, messages, continuationAttempts: state.continuationAttempts + 1, phase: "ready_model" };
  }
  if (payload.finishReason === "content_filter") {
    return propose({ ...state, messages }, {
      kind: "fatal",
      code: "content_filter",
      message: "Provider blocked the response."
    });
  }
  const response = [...messages].reverse().find((message) => message.role === "assistant")?.content.trim() ?? "";
  if (!response) {
    return propose({ ...state, messages }, {
      kind: "recoverable_failure",
      code: "model_no_action",
      message: "The model stopped without a response or tool call."
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
        content: "Your response did not obtain current-run durable evidence, so it cannot complete an actionable run. This repair turn requires a tool call: use an applicable non-completion tool to obtain successful durable evidence, or call request_user_input if a concrete user decision is required. Do not repeat the natural-language response and do not call complete_task before evidence exists."
      }],
      completionRepairAttempts: state.completionRepairAttempts + 1,
      phase: "ready_model"
    };
  }
  if (state.completionRepairAttempts >= 1) {
    return propose({ ...state, messages }, {
      kind: "recoverable_failure",
      code: "terminal_protocol_missing",
      message: "The model repeatedly stopped without choosing complete_task or request_user_input."
    });
  }
  return {
    ...state,
    messages: [...messages, {
      role: "developer",
      content: "Your response stopped after obtaining current-run evidence but did not choose a terminal action. This repair turn requires exactly one terminal tool call. Use complete_task with explicit criteria and exact evidence IDs when the prior response already provides a substantive result. Use request_user_input only when that prior response identifies a specific blocking decision or missing fact without which the task cannot be completed; never use it for optional follow-up, confirmation, or an offer of more help. Do not repeat the natural-language response or call any non-terminal tool."
    }],
    completionRepairAttempts: state.completionRepairAttempts + 1,
    phase: "ready_model"
  };
}
