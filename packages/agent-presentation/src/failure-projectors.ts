import type { AgentEventEnvelope, JsonValue } from "agent-protocol";
import type { ActivityItem, PresentationState, TranscriptItem } from "./view-state.js";

type EventData = Record<string, JsonValue>;

function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function activityId(event: AgentEventEnvelope, data: EventData): string {
  const turnId = typeof data.turnId === "string" || typeof data.turnId === "number"
    ? String(data.turnId) : "default";
  return `model:${event.runId}:${turnId}`;
}

function upsertActivity(items: ActivityItem[], item: ActivityItem): ActivityItem[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item].slice(-1_000);
  const next = [...items];
  next[index] = { ...items[index], ...item };
  return next;
}

function failureDetail(data: EventData, fallback: string): string {
  const message = text(data.message) || text(data.error);
  const code = text(data.code);
  if (!message) return code || fallback;
  return code && !message.includes(code) ? `${code}: ${message}` : message;
}

function closeStream(items: TranscriptItem[], event: AgentEventEnvelope, data: EventData): TranscriptItem[] {
  const id = `assistant:${activityId(event, data).slice("model:".length)}`;
  return items.map((item) => item.id === id && item.streaming ? { ...item, streaming: false } : item);
}

function withRunError(items: TranscriptItem[], event: AgentEventEnvelope, detail: string): TranscriptItem[] {
  const id = `error:${event.runId}`;
  if (items.some((item) => item.id === id)) return items;
  const failure: TranscriptItem = {
    id,
    role: "system",
    text: detail,
    streaming: false,
    occurredAt: event.occurredAt
  };
  return [...items, failure].slice(-2_000);
}

export function projectModelFailed(
  state: PresentationState,
  event: AgentEventEnvelope,
  data: EventData
): PresentationState {
  const id = activityId(event, data);
  const current = state.activity.find((item) => item.id === id);
  const detail = failureDetail(data, "Model request failed without an error message.");
  const transcript = closeStream(state.transcript, event, data);
  return {
    ...state,
    status: "failed",
    transcript: withRunError(transcript, event, detail),
    activity: upsertActivity(state.activity, {
      id,
      kind: "model",
      title: current?.title || text(data.model) || "model",
      detail,
      status: "failed",
      occurredAt: event.occurredAt
    })
  };
}

export function projectRunFailed(
  state: PresentationState,
  event: AgentEventEnvelope,
  data: EventData
): PresentationState {
  const detail = failureDetail(data, "Run failed without an error message.");
  const hasModelFailure = state.activity.some((item) =>
    item.id.startsWith(`model:${event.runId}:`) && item.status === "failed");
  const activity = hasModelFailure ? state.activity : upsertActivity(state.activity, {
    id: `run:${event.runId}`,
    kind: "diagnostic",
    title: text(data.code) || "run failed",
    detail,
    status: "failed",
    occurredAt: event.occurredAt
  });
  return { ...state, status: "failed", activity, transcript: withRunError(state.transcript, event, detail) };
}

export function projectDiagnostic(
  state: PresentationState,
  event: AgentEventEnvelope,
  data: EventData
): PresentationState {
  const values = [text(data.message), text(data.error), text(data.detail), ...strings(data.diagnostics), ...strings(data.failures)];
  const detail = [...new Set(values.filter(Boolean))].join("\n");
  if (!detail) return state;
  const kind = text(data.kind) || "diagnostic";
  const failed = Boolean(text(data.error)) || text(data.level) === "error" || kind.endsWith("failed") || strings(data.failures).length > 0;
  return {
    ...state,
    activity: upsertActivity(state.activity, {
      id: `diagnostic:${event.eventId}`,
      kind: "diagnostic",
      title: kind,
      detail,
      status: failed ? "failed" : "completed",
      occurredAt: event.occurredAt
    })
  };
}
