import type {
  JsonValue,
  ModelMessage,
  ModelToolCall,
  RunOutcome,
  ToolReceipt
} from "agent-protocol";
import { isCurrentModelTurn, modelTurn } from "./model-event-parsing.js";
import type { ActiveModelTurn, KernelState, PendingTool } from "./state.js";

export function objectPayload(value: unknown): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

export function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

export function terminalState(state: KernelState, outcome: RunOutcome): KernelState {
  return {
    ...state,
    phase: "terminal",
    activeModelTurn: undefined,
    activeModelSemanticDelta: undefined,
    pendingTools: [],
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
  const callId = text(payload.callId);
  if (!turn || !callId) return undefined;
  return state.pendingTools.find((item) => item.request.callId === callId
    && item.modelTurn.turnId === turn.turnId
    && item.modelTurn.effectRevision === turn.effectRevision);
}

export function acceptsOutcomeRevision(
  state: KernelState,
  payload: Record<string, JsonValue>
): boolean {
  if (payload.outcomeRevision === undefined) return true;
  return Number.isInteger(payload.outcomeRevision)
    && payload.outcomeRevision === state.revision - 1
    && state.phase === "outcome_pending";
}

export function isRecoverySuspension(
  state: KernelState,
  payload: Record<string, JsonValue>
): boolean {
  const checkpointRecovery = typeof payload.checkpointId === "string"
    && Array.isArray(payload.choices)
    && payload.choices.length === 2
    && payload.choices[0] === "restore"
    && payload.choices[1] === "keep";
  const processRecovery = Array.isArray(payload.processIds)
    && payload.processIds.length > 0
    && payload.processIds.every((item) => typeof item === "string" && item.length > 0);
  return checkpointRecovery || processRecovery
    || (state.phase === "model_in_flight" && isCurrentModelTurn(state, payload));
}

export function supersededToolMessages(state: KernelState): ModelMessage[] {
  return state.pendingTools.map((pending) => ({
    role: "tool",
    toolCallId: pending.request.callId,
    content: `Failed tool receipt ID: ${pending.request.callId}\n`
      + "Superseded by a newer user instruction; no successful receipt or side effect may be inferred."
  }));
}

export function pendingFromCalls(
  calls: ModelToolCall[],
  turn: ActiveModelTurn
): PendingTool[] {
  return calls.map((call): PendingTool => ({
    request: { callId: call.id, name: call.name, arguments: call.arguments },
    modelTurn: turn,
    approval: "not_required",
    started: false
  }));
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function callSignature(call: ModelToolCall): string {
  return `${call.name}\n${canonicalJson(call.arguments)}`;
}

const DUPLICATE_ACTION_ADVISORY =
  "You have issued the same tool call with the same normalized arguments three times in a row. "
  + "This is only an advisory: reassess the latest receipts and choose whether to continue, change approach, "
  + "ask for input, report a blocker, or finish. All permitted tools remain available.";

export function withDuplicateActionAdvisory(messages: ModelMessage[]): ModelMessage[] {
  const calls = messages.flatMap((message) =>
    message.role === "assistant" ? message.toolCalls ?? [] : []);
  if (calls.length < 3) return messages;
  const signatures = calls.slice(-4).map(callSignature);
  const last = signatures.at(-1);
  if (!last || signatures.slice(-3).some((value) => value !== last)
    || (signatures.length === 4 && signatures[0] === last)) return messages;
  return [...messages, { role: "developer", content: DUPLICATE_ACTION_ADVISORY }];
}

function inputRequestOutcome(
  pending: PendingTool,
  receipt: ToolReceipt,
  args: Record<string, JsonValue>
): RunOutcome | null {
  if (!receipt.observedEffects.includes("outcome.request_input")) return null;
  const message = typeof args.message === "string" ? args.message.trim() : "";
  return message
    ? { kind: "needs_input", requestId: pending.request.callId, message }
    : null;
}

function blockedReportOutcome(
  receipt: ToolReceipt,
  args: Record<string, JsonValue>
): RunOutcome | null {
  if (!receipt.observedEffects.includes("outcome.report_blocked")) return null;
  const code = typeof args.code === "string" ? args.code.trim() : "";
  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  const recovery = typeof args.recoveryAttempted === "string"
    ? args.recoveryAttempted.trim()
    : "";
  if (!code || !summary) return null;
  return {
    kind: "recoverable_failure",
    code: "reported_blocked",
    message: recovery ? `${summary}\nRecovery attempted: ${recovery}` : summary,
    failureKind: "blocked",
    failureCode: code
  };
}

export function terminalOutcome(
  pending: PendingTool,
  receipt: ToolReceipt,
  originalBatchCalls: readonly ModelToolCall[]
): RunOutcome | null {
  if (!receipt.ok || originalBatchCalls.length !== 1) return null;
  const args = pending.request.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  if (pending.request.name === "request_user_input") {
    return inputRequestOutcome(pending, receipt, args);
  }
  if (pending.request.name === "report_blocked") {
    return blockedReportOutcome(receipt, args);
  }
  return null;
}
