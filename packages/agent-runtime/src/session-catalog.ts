import { access } from "node:fs/promises";
import path from "node:path";
import type { AgentEventEnvelope, RunStore, SessionOverview } from "agent-protocol";
import {
  legacySessionDirectoryV2,
  legacySessionDirectoryV3,
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
  readonly code = "session_storage_version_unsupported";

  constructor(readonly sessionId: string, readonly preservedPath: string) {
    super(`Session '${sessionId}' uses an unsupported storage version. Its original data remains preserved at '${preservedPath}'.`);
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
  await assertSessionStorageSupported(rootDir, sessionId);
  for await (const event of store.events(sessionId, afterSeq)) yield event;
}

export async function listCurrentSessions(
  store: RunStore,
  _rootDir: string,
  limit: number
): Promise<SessionOverview[]> {
  const records = await store.listSessions();
  const sessions = await Promise.all(records.map(async (item) => await storedSessionOverview(store, item)));
  return sessions
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, Math.max(1, limit));
}
