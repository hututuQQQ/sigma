import { access } from "node:fs/promises";
import path from "node:path";
import {
  upcastAgentEventV2,
  type AgentEventEnvelope,
  type AgentEventType,
  type JsonValue,
  type RunStore,
  type SessionOverview
} from "agent-protocol";
import {
  legacySessionDirectoryV2,
  assertPromotedV2SourceUnchanged,
  promoteV2Session,
  sessionDirectory,
  V2ReadOnlySessionStore
} from "agent-store";
import { storedSessionOverview } from "./session-overview.js";
import { rebuildV3SnapshotFromEvents } from "./restore-session.js";

async function exists(target: string): Promise<boolean> {
  return await access(target).then(() => true, (error: unknown) => {
    if ((error as { code?: unknown }).code === "ENOENT") return false;
    throw error;
  });
}

export async function ensureSessionPromoted(rootDir: string, sessionId: string): Promise<void> {
  if (await exists(path.join(sessionDirectory(rootDir, sessionId), "meta.json"))) {
    await assertPromotedV2SourceUnchanged(rootDir, sessionId);
    return;
  }
  if (!await exists(path.join(legacySessionDirectoryV2(rootDir, sessionId), "meta.json"))) return;
  await promoteV2Session({ rootDir, sessionId, rebuildSnapshot: rebuildV3SnapshotFromEvents });
}

export async function* combinedSessionEvents(
  store: RunStore,
  rootDir: string,
  sessionId: string,
  afterSeq = 0
): AsyncIterable<AgentEventEnvelope> {
  let found = false;
  for await (const event of store.events(sessionId, afterSeq)) {
    found = true;
    yield event;
  }
  if (found) return;
  const legacy = new V2ReadOnlySessionStore(rootDir);
  for await (const event of legacy.events(sessionId, afterSeq)) yield upcastAgentEventV2(event);
}

function payload(event: AgentEventEnvelope): Record<string, JsonValue> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, JsonValue> : {};
}

interface LegacyOverviewProjection {
  workspacePath: string;
  mode: SessionOverview["mode"];
  status: SessionOverview["status"];
  lastMessage?: string;
}

const legacyStatusByEvent: Partial<Record<AgentEventType, SessionOverview["status"]>> = {
  "run.started": "running",
  "run.suspended": "needs_input",
  "run.completed": "completed",
  "run.cancelled": "cancelled",
  "run.failed": "failed"
};

const legacyMessageEvents = new Set<AgentEventType>([
  "user.message",
  "user.follow_up",
  "model.completed"
]);

function projectLegacyEvent(projection: LegacyOverviewProjection, event: AgentEventEnvelope): void {
  const value = payload(event);
  if (event.type === "session.created") {
    if (typeof value.workspacePath === "string") projection.workspacePath = value.workspacePath;
    if (value.mode === "analyze") projection.mode = "analyze";
  }
  projection.status = legacyStatusByEvent[event.type] ?? projection.status;
  if (legacyMessageEvents.has(event.type) && typeof value.text === "string") projection.lastMessage = value.text;
}

function projectedLegacyOverview(
  record: { sessionId: string; updatedAt: string; lastSeq: number },
  projection: LegacyOverviewProjection
): SessionOverview {
  const { lastMessage, ...metadata } = projection;
  return { ...record, ...metadata, ...(lastMessage ? { lastMessage } : {}) };
}

async function legacyOverview(
  legacy: V2ReadOnlySessionStore,
  record: { sessionId: string; updatedAt: string; lastSeq: number }
): Promise<SessionOverview> {
  const projection: LegacyOverviewProjection = {
    workspacePath: ".",
    mode: "change",
    status: "idle"
  };
  for await (const raw of legacy.events(record.sessionId)) {
    projectLegacyEvent(projection, upcastAgentEventV2(raw));
  }
  return projectedLegacyOverview(record, projection);
}

export async function listCombinedSessions(
  store: RunStore,
  rootDir: string,
  limit: number
): Promise<SessionOverview[]> {
  const currentRecords = await store.listSessions();
  const current = await Promise.all(currentRecords.map(async (item) => await storedSessionOverview(store, item)));
  const currentIds = new Set(current.map((item) => item.sessionId));
  const legacy = new V2ReadOnlySessionStore(rootDir);
  const legacyRecords = (await legacy.listSessions()).filter((item) => !currentIds.has(item.sessionId));
  const old = await Promise.all(legacyRecords.map(async (item) => await legacyOverview(legacy, item)));
  return [...current, ...old]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, Math.max(1, limit));
}
