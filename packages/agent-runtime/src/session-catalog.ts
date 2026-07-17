import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { AgentEventEnvelope, JsonValue, RunStore, SessionOverview } from "agent-protocol";
import {
  legacySessionDirectoryV2,
  legacySessionDirectoryV3,
  legacySessionsDirectoryV3,
  sessionDirectory
} from "agent-store";
import { storedSessionOverview } from "./session-overview.js";

async function exists(target: string): Promise<boolean> {
  return await access(target).then(() => true, (error: unknown) => {
    if ((error as { code?: unknown }).code === "ENOENT") return false;
    throw error;
  });
}

export class SessionStorageVersionUnsupportedError extends Error {
  readonly code = "incompatible_session_schema";

  constructor(readonly sessionId: string, readonly preservedPath: string) {
    super(`Session '${sessionId}' uses an incompatible execution schema. V3 data remains read-only and replayable at '${preservedPath}', but it cannot resume under V4.`);
    this.name = "SessionStorageVersionUnsupportedError";
  }
}

async function legacySessionPath(rootDir: string, sessionId: string): Promise<string | undefined> {
  for (const directory of [
    legacySessionDirectoryV3(rootDir, sessionId),
    legacySessionDirectoryV2(rootDir, sessionId)
  ]) {
    if (await exists(path.join(directory, "meta.json"))) return directory;
  }
  return undefined;
}

export async function assertSessionStorageSupported(rootDir: string, sessionId: string): Promise<void> {
  if (await exists(path.join(sessionDirectory(rootDir, sessionId), "meta.json"))) return;
  const preservedPath = await legacySessionPath(rootDir, sessionId);
  if (preservedPath) throw new SessionStorageVersionUnsupportedError(sessionId, preservedPath);
}

export async function* currentSessionEvents(
  store: RunStore,
  rootDir: string,
  sessionId: string,
  afterSeq = 0
): AsyncIterable<AgentEventEnvelope> {
  const legacyV3 = legacySessionDirectoryV3(rootDir, sessionId);
  if (!await exists(path.join(sessionDirectory(rootDir, sessionId), "meta.json"))
    && await exists(path.join(legacyV3, "meta.json"))) {
    for await (const event of legacySessionEvents(legacyV3, sessionId, afterSeq)) yield event;
    return;
  }
  await assertSessionStorageSupported(rootDir, sessionId);
  for await (const event of store.events(sessionId, afterSeq)) yield event;
}

function legacyChecksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function readOnlyLegacyEvent(raw: string, sessionId: string): AgentEventEnvelope {
  const stored = JSON.parse(raw) as { checksum?: unknown; event?: unknown };
  if (typeof stored.checksum !== "string" || !stored.event || typeof stored.event !== "object"
    || Array.isArray(stored.event) || legacyChecksum(stored.event) !== stored.checksum) {
    throw new Error(`Legacy V3 session '${sessionId}' contains an invalid event record.`);
  }
  const event = stored.event as Record<string, unknown>;
  if (event.schemaVersion !== 3 || event.sessionId !== sessionId || !Number.isSafeInteger(event.seq)
    || typeof event.type !== "string" || typeof event.occurredAt !== "string") {
    throw new Error(`Legacy V3 session '${sessionId}' contains an invalid event envelope.`);
  }
  // This normalized envelope exists only on the read-only presentation path.
  // Runtime restoration still rejects the V3 storage root before reduction.
  return { ...event, schemaVersion: 4 } as unknown as AgentEventEnvelope;
}

async function* legacySessionEvents(
  directory: string,
  sessionId: string,
  afterSeq = 0
): AsyncIterable<AgentEventEnvelope> {
  const eventsDirectory = path.join(directory, "events");
  const files = (await readdir(eventsDirectory).catch(() => []))
    .filter((name) => /^\d{6}\.jsonl$/u.test(name)).sort();
  let expectedSeq = 1;
  for (const file of files) {
    const content = await readFile(path.join(eventsDirectory, file), "utf8");
    for (const line of content.split(/\r?\n/u).filter((item) => item.trim())) {
      const event = readOnlyLegacyEvent(line, sessionId);
      if (event.seq !== expectedSeq) throw new Error(`Legacy V3 session '${sessionId}' has a sequence discontinuity.`);
      expectedSeq += 1;
      if (event.seq > afterSeq) yield event;
    }
  }
}

function legacyMeta(value: unknown, sessionId: string): { updatedAt: string; lastSeq: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const meta = value as Record<string, unknown>;
  return meta.schemaVersion === 3 && meta.sessionId === sessionId
    && typeof meta.updatedAt === "string" && Number.isSafeInteger(meta.lastSeq)
    ? { updatedAt: meta.updatedAt, lastSeq: Number(meta.lastSeq) }
    : null;
}

interface LegacyOverviewState {
  workspacePath: string;
  mode: SessionOverview["mode"];
  status: SessionOverview["status"];
  lastMessage?: string;
}

function legacyEventData(event: AgentEventEnvelope): Record<string, JsonValue> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, JsonValue> : {};
}

function applyLegacyOverviewEvent(state: LegacyOverviewState, event: AgentEventEnvelope): void {
  const data = legacyEventData(event);
  if (event.type === "session.created") {
    if (typeof data.workspacePath === "string") state.workspacePath = data.workspacePath;
    if (data.mode === "analyze") state.mode = "analyze";
  }
  const terminalStatus: Partial<Record<AgentEventEnvelope["type"], SessionOverview["status"]>> = {
    "run.started": "running",
    "run.suspended": "needs_input",
    "run.completed": "completed",
    "run.cancelled": "cancelled",
    "run.failed": "failed"
  };
  if (terminalStatus[event.type]) state.status = terminalStatus[event.type]!;
  if (event.type === "model.completed" && typeof data.text === "string") state.lastMessage = data.text;
}

async function legacyOverview(rootDir: string, sessionId: string): Promise<SessionOverview | null> {
  const directory = legacySessionDirectoryV3(rootDir, sessionId);
  try {
    const meta = legacyMeta(JSON.parse(await readFile(path.join(directory, "meta.json"), "utf8")), sessionId);
    if (!meta) return null;
    const state: LegacyOverviewState = { workspacePath: "", mode: "change", status: "idle" };
    for await (const event of legacySessionEvents(directory, sessionId)) {
      applyLegacyOverviewEvent(state, event);
    }
    return {
      sessionId, workspacePath: state.workspacePath, mode: state.mode, status: state.status,
      updatedAt: meta.updatedAt, lastSeq: meta.lastSeq, ...(state.lastMessage ? { lastMessage: state.lastMessage } : {})
    };
  } catch { return null; }
}

export async function listCurrentSessions(
  store: RunStore,
  rootDir: string,
  limit: number
): Promise<SessionOverview[]> {
  const records = await store.listSessions();
  const current = await Promise.all(records.map(async (item) => await storedSessionOverview(store, item)));
  const currentIds = new Set(current.map((item) => item.sessionId));
  const legacyEntries = (await readdir(legacySessionsDirectoryV3(rootDir), { withFileTypes: true }).catch(() => []))
    .filter((item) => item.isDirectory() && !currentIds.has(item.name));
  const legacy = (await Promise.all(legacyEntries.map(async (item) => await legacyOverview(rootDir, item.name))))
    .filter((item): item is SessionOverview => item !== null);
  return [...current, ...legacy]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, Math.max(1, limit));
}
