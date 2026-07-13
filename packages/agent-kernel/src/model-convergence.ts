import type { JsonValue, ModelMessage, ModelToolCall, RunOutcome, ToolReceipt } from "agent-protocol";
import type { KernelState } from "./state.js";

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
  const hasCurrentRunReceipt = state.receipts.length > state.receiptCountAtLastUserInput;
  if (!hasCurrentRunReceipt) {
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
        content: "Your response did not use a current-run tool, so it cannot complete an actionable run. This repair turn requires a tool call: use an applicable non-completion tool to obtain successful durable evidence, or call request_user_input if a concrete user decision is required. Do not repeat the natural-language response and do not call complete_task before evidence exists."
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
      content: "Your response did not choose a terminal protocol action. This repair turn requires exactly one terminal tool call: complete_task with explicit criteria and exact evidence IDs, or request_user_input if a concrete user decision is required. Do not repeat the natural-language response."
    }],
    completionRepairAttempts: state.completionRepairAttempts + 1,
    phase: "ready_model"
  };
}
