import type { JsonValue, ModelMessage, ModelToolCall, RunOutcome, ToolReceipt } from "agent-protocol";
import type { KernelState } from "./state.js";

function propose(state: KernelState, outcome: RunOutcome): KernelState {
  return { ...state, phase: "outcome_pending", activeModelTurn: undefined, proposedOutcome: outcome };
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
  if (state.receipts.length <= state.receiptCountAtLastUserInput || state.completionRepairAttempts >= 1) {
    return propose({ ...state, messages }, {
      kind: "needs_input",
      requestId: `model-response-${Number(payload.turnId) || state.revision}`,
      message: response
    });
  }
  return {
    ...state,
    messages: [...messages, {
      role: "developer",
      content: "Your response did not choose a terminal protocol action. If the work is complete, call complete_task with explicit criteria and successful receipt IDs. If no actionable task was provided or user guidance is required, call request_user_input. Do not repeat the same natural-language response."
    }],
    completionRepairAttempts: state.completionRepairAttempts + 1,
    phase: "ready_model"
  };
}
