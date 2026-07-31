import type {
  JsonValue,
  ModelMessage,
  ModelProviderState,
  ModelToolCall
} from "agent-protocol";
import type { ActiveModelTurn, KernelState } from "./state.js";

function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

export function modelToolCalls(value: JsonValue | undefined): ModelToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): ModelToolCall[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const call = raw as Record<string, JsonValue>;
    return typeof call.id === "string" && typeof call.name === "string"
      ? [{ id: call.id, name: call.name, arguments: call.arguments ?? null }]
      : [];
  });
}

function modelProviderState(value: JsonValue | undefined): ModelProviderState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const state = value as Record<string, JsonValue>;
  return typeof state.provider === "string"
    && state.provider.length > 0
    && state.version === 1
    && state.data !== undefined
    ? { provider: state.provider, version: 1, data: state.data }
    : undefined;
}

export function modelMessage(value: JsonValue | undefined): ModelMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, JsonValue>;
  const role = item.role;
  if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant" && role !== "tool") return null;
  const toolCalls = modelToolCalls(item.toolCalls);
  const providerState = modelProviderState(item.providerState);
  return {
    role,
    content: text(item.content),
    ...(typeof item.reasoningContent === "string" ? { reasoningContent: item.reasoningContent } : {}),
    ...(typeof item.toolCallId === "string" ? { toolCallId: item.toolCallId } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(providerState ? { providerState } : {})
  };
}

export function modelTurn(payload: Record<string, JsonValue>): ActiveModelTurn | null {
  return Number.isInteger(payload.turnId) && Number.isInteger(payload.effectRevision)
    ? { turnId: Number(payload.turnId), effectRevision: Number(payload.effectRevision) }
    : null;
}

export function isCurrentModelTurn(state: KernelState, payload: Record<string, JsonValue>): boolean {
  const turn = modelTurn(payload);
  return Boolean(turn && state.activeModelTurn
    && turn.turnId === state.activeModelTurn.turnId
    && turn.effectRevision === state.activeModelTurn.effectRevision);
}
