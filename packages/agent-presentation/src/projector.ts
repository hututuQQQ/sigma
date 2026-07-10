import type { AgentEventEnvelope, AgentEventType, JsonValue } from "agent-protocol";
import type { ActivityItem, ApprovalItem, PresentationState, TranscriptItem } from "./view-state.js";
import { projectDiagnostic, projectModelFailed, projectRunFailed } from "./failure-projectors.js";
import {
  boundedPresentationText, maximumActivityDetailCharacters, maximumApprovalPreviewCharacters,
  maximumTranscriptCharacters
} from "./bounds.js";

function payload(event: AgentEventEnvelope): Record<string, JsonValue> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, JsonValue>
    : {};
}

function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function strings(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function preview(value: JsonValue | undefined, maximum: number): { text: string; truncated: boolean } {
  if (value === undefined) return { text: "", truncated: false };
  const serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const source = serialized ?? String(value);
  return { text: boundedPresentationText(source, maximum), truncated: source.length > maximum };
}

function upsertActivity(items: ActivityItem[], item: ActivityItem): ActivityItem[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, item].slice(-1_000);
  const next = [...items];
  next[index] = { ...items[index], ...item };
  return next;
}

function itemId(event: AgentEventEnvelope, data: Record<string, JsonValue>): string {
  const turn = typeof data.turnId === "number" || typeof data.turnId === "string" ? String(data.turnId) : "default";
  return `${event.runId}:${turn}`;
}

function appendDelta(items: TranscriptItem[], event: AgentEventEnvelope, data: Record<string, JsonValue>, delta: string): TranscriptItem[] {
  const id = `assistant:${itemId(event, data)}`;
  const index = items.findIndex((item) => item.id === id && item.streaming);
  if (index === -1) {
    const item: TranscriptItem = {
      id, role: "assistant", text: boundedPresentationText(delta, maximumTranscriptCharacters),
      streaming: true, occurredAt: event.occurredAt
    };
    return [...items, item].slice(-2_000);
  }
  const next = [...items];
  next[index] = {
    ...items[index],
    text: boundedPresentationText(`${items[index].text}${delta}`, maximumTranscriptCharacters)
  };
  return next;
}

function boundedApprovals(items: ApprovalItem[]): ApprovalItem[] {
  const pending = items.filter((item) => item.status === "pending");
  const resolved = items.filter((item) => item.status !== "pending").slice(-256);
  return [...resolved, ...pending];
}

type EventProjector = (
  state: PresentationState,
  event: AgentEventEnvelope,
  data: Record<string, JsonValue>
) => PresentationState;

const withStatus = (status: PresentationState["status"]): EventProjector => (state) => ({ ...state, status });

const projectUserInput: EventProjector = (state, event, data) => {
  const item: TranscriptItem = {
    id: event.eventId,
    role: "user",
    delivery: event.type === "user.steer" ? "steer" : "submit",
    text: boundedPresentationText(text(data.text), maximumTranscriptCharacters),
    streaming: false,
    occurredAt: event.occurredAt
  };
  return { ...state, transcript: [...state.transcript, item].slice(-2_000) };
};

const projectFollowUp: EventProjector = (state, event, data) => {
  const queueId = text(data.queueId);
  if (!queueId) return projectUserInput(state, event, data);
  if (data.status === "queued") {
    if (state.queuedFollowUps.some((item) => item.queueId === queueId)) return state;
    return {
      ...state,
      queuedFollowUps: [...state.queuedFollowUps, {
        queueId,
        text: boundedPresentationText(text(data.text), maximumTranscriptCharacters),
        occurredAt: event.occurredAt
      }].slice(-256)
    };
  }
  const id = `follow-up:${queueId}`;
  const index = state.transcript.findIndex((item) => item.id === id);
  const queuedFollowUps = state.queuedFollowUps.filter((item) => item.queueId !== queueId);
  if (index >= 0) return { ...state, queuedFollowUps };
  const item: TranscriptItem = {
    id,
    role: "user",
    delivery: "follow_up",
    text: boundedPresentationText(text(data.text), maximumTranscriptCharacters),
    streaming: false,
    occurredAt: event.occurredAt
  };
  return { ...state, queuedFollowUps, transcript: [...state.transcript, item].slice(-2_000) };
};

const projectModelStarted: EventProjector = (state, event, data) => ({
  ...state,
  activity: upsertActivity(state.activity, {
    id: `model:${itemId(event, data)}`,
    kind: "model",
    title: text(data.model) || "model",
    detail: "Generating response",
    status: "running",
    occurredAt: event.occurredAt
  })
});

const projectModelCompleted: EventProjector = (state, event, data) => {
  const streamId = `assistant:${itemId(event, data)}`;
  const streamIndex = state.transcript.findIndex((item) => item.id === streamId && item.streaming);
  const transcript = [...state.transcript];
  if (streamIndex >= 0) transcript[streamIndex] = { ...transcript[streamIndex], streaming: false };
  else if (text(data.text)) {
    transcript.push({
      id: event.eventId,
      role: "assistant",
      text: boundedPresentationText(text(data.text), maximumTranscriptCharacters),
      streaming: false,
      occurredAt: event.occurredAt
    });
  }
  return {
    ...state,
    transcript: transcript.slice(-2_000),
    activity: upsertActivity(state.activity, {
      id: `model:${itemId(event, data)}`,
      kind: "model",
      title: text(data.model) || "model",
      detail: text(data.finishReason),
      status: "completed",
      occurredAt: event.occurredAt
    })
  };
};

function toolStatus(type: AgentEventType): ActivityItem["status"] {
  if (type === "tool.requested") return "queued";
  if (type === "tool.started") return "running";
  return type === "tool.completed" ? "completed" : "failed";
}

const projectToolActivity: EventProjector = (state, event, data) => {
  const callId = text(data.callId) || event.eventId;
  const current = state.activity.find((item) => item.id === `tool:${callId}`);
  const argumentsPreview = preview(data.arguments, maximumActivityDetailCharacters).text;
  const delta = data.workspaceDelta && typeof data.workspaceDelta === "object" && !Array.isArray(data.workspaceDelta)
    ? data.workspaceDelta as Record<string, JsonValue> : {};
  const changes = [
    ["added", strings(delta.added)], ["modified", strings(delta.modified)], ["deleted", strings(delta.deleted)]
  ].flatMap(([label, values]) => (values as string[]).map((value) => `${label} ${value}`));
  const detail = text(data.output) || text(data.message) || changes.join("\n") || argumentsPreview || current?.detail || "";
  return {
    ...state,
    activity: upsertActivity(state.activity, {
      id: `tool:${callId}`,
      kind: "tool",
      title: text(data.name) || "tool",
      detail: boundedPresentationText(detail, maximumActivityDetailCharacters),
      status: toolStatus(event.type),
      occurredAt: event.occurredAt
    })
  };
};

const projectToolProgress: EventProjector = (state, event, data) => {
  const callId = text(data.callId) || event.eventId;
  const current = state.activity.find((item) => item.id === `tool:${callId}`);
  const percent = typeof data.percent === "number" && Number.isFinite(data.percent)
    ? Math.max(0, Math.min(100, data.percent)) : undefined;
  return {
    ...state,
    activity: upsertActivity(state.activity, {
      id: `tool:${callId}`,
      kind: "tool",
      title: text(data.name) || current?.title || "tool",
      detail: boundedPresentationText(text(data.message) || current?.detail || "Running", maximumActivityDetailCharacters),
      status: "running",
      ...(percent === undefined ? {} : { progressPercent: percent }),
      occurredAt: event.occurredAt
    })
  };
};

const projectApprovalRequested: EventProjector = (state, _event, data) => {
  const argumentsPreview = preview(data.arguments, maximumApprovalPreviewCharacters);
  return {
    ...state,
    status: "needs_input",
    approvals: boundedApprovals([...state.approvals.filter((item) => item.requestId !== text(data.requestId)), {
      requestId: text(data.requestId),
      toolName: text(data.toolName),
      reason: text(data.reason),
      effects: strings(data.effects),
      argumentPreview: argumentsPreview.text,
      argumentPreviewTruncated: argumentsPreview.truncated,
      status: "pending"
    }])
  };
};

const projectContextCompacted: EventProjector = (state, event, data) => ({
  ...state,
  activity: upsertActivity(state.activity, {
    id: `context:${event.eventId}`,
    kind: "diagnostic",
    title: "context compacted",
    detail: typeof data.omittedHistoryTurns === "number"
      ? `${data.omittedHistoryTurns} earlier history turns summarized` : "Earlier history summarized",
    status: "completed",
    occurredAt: event.occurredAt
  })
});

const projectApprovalResolved: EventProjector = (state, _event, data) => {
  const approvals: ApprovalItem[] = state.approvals.map((item) => item.requestId === text(data.requestId)
    ? { ...item, status: data.decision === "allow" || data.decision === "always_allow" ? "allowed" as const : "denied" as const }
    : item);
  return {
    ...state,
    status: approvals.some((item) => item.status === "pending") ? "needs_input" : "running",
    approvals: boundedApprovals(approvals)
  };
};

const projectChild: EventProjector = (state, event, data) => {
  const childId = text(data.childId) || event.eventId;
  const detail = data.payload && typeof data.payload === "object" && !Array.isArray(data.payload)
    ? data.payload as Record<string, JsonValue> : {};
  const status: ActivityItem["status"] = event.type === "child.completed"
    ? detail.status === "completed" ? "completed" : detail.status === "cancelled" ? "cancelled" : "failed"
    : event.type === "child.spawned" ? "queued" : "running";
  return {
    ...state,
    activity: upsertActivity(state.activity, {
      id: `child:${childId}`,
      kind: "child",
      title: `agent ${childId.slice(0, 8)}`,
      detail: text(detail.kind) || text(detail.error) || text(detail.intent) || status,
      status,
      occurredAt: event.occurredAt
    })
  };
};

const projectSuspended: EventProjector = (state, event, data) => {
  const message = text(data.message).trim();
  if (!message || state.transcript.at(-1)?.text.trim() === message) return { ...state, status: "needs_input" };
  const item: TranscriptItem = {
    id: `input:${event.runId}:${text(data.requestId) || event.eventId}`,
    role: "assistant",
    text: boundedPresentationText(message, maximumTranscriptCharacters),
    streaming: false,
    occurredAt: event.occurredAt
  };
  return {
    ...state,
    status: "needs_input",
    transcript: [...state.transcript, item].slice(-2_000)
  };
};

const projectors: Partial<Record<AgentEventType, EventProjector>> = {
  "run.started": withStatus("running"),
  "user.message": projectUserInput,
  "user.steer": projectUserInput,
  "user.follow_up": projectFollowUp,
  "model.started": projectModelStarted,
  "model.delta": (state, event, data) => ({
    ...state,
    transcript: appendDelta(state.transcript, event, data, text(data.delta))
  }),
  "model.completed": projectModelCompleted,
  "model.failed": projectModelFailed,
  "tool.requested": projectToolActivity,
  "tool.started": projectToolActivity,
  "tool.progress": projectToolProgress,
  "tool.completed": projectToolActivity,
  "tool.failed": projectToolActivity,
  "tool.approval_requested": projectApprovalRequested,
  "tool.approval_resolved": projectApprovalResolved,
  "child.spawned": projectChild,
  "child.message": projectChild,
  "child.completed": projectChild,
  "context.compacted": projectContextCompacted,
  "run.suspended": projectSuspended,
  "run.completed": withStatus("completed"),
  "run.cancelled": withStatus("cancelled"),
  "run.failed": projectRunFailed,
  "diagnostic": projectDiagnostic
};

export function projectEvent(previous: PresentationState, event: AgentEventEnvelope): PresentationState {
  if (event.seq <= previous.lastSeq) return previous;
  const state: PresentationState = {
    ...previous,
    sessionId: event.sessionId,
    runId: event.runId,
    lastSeq: event.seq
  };
  const projector = projectors[event.type];
  return projector ? projector(state, event, payload(event)) : state;
}

export function replayPresentation(events: Iterable<AgentEventEnvelope>, initial: PresentationState): PresentationState {
  let state = initial;
  for (const event of events) state = projectEvent(state, event);
  return state;
}
