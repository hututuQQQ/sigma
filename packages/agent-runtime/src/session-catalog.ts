import { access } from "node:fs/promises";
import path from "node:path";
import type { AgentEventEnvelope, RunStore, SessionOverview } from "agent-protocol";
import { sessionDirectory } from "agent-store";
import { storedSessionOverview } from "./session-overview.js";

async function exists(target: string): Promise<boolean> {
  return await access(target).then(() => true, (error: unknown) => {
    if ((error as { code?: unknown }).code === "ENOENT") return false;
    throw error;
  });
}

export class SessionStorageVersionUnsupportedError extends Error {
  readonly code = "session_not_found";

  constructor(readonly sessionId: string) {
    super(`V5 session '${sessionId}' does not exist in the current store.`);
    this.name = "SessionStorageVersionUnsupportedError";
  }
}

/** V5 deliberately inspects only stores/v5. Older stores are neither probed
 * nor normalized into current envelopes; they remain the responsibility of
 * their original binary. */
export async function assertSessionStorageSupported(rootDir: string, sessionId: string): Promise<void> {
  if (!await exists(path.join(sessionDirectory(rootDir, sessionId), "meta.json"))) {
    throw new SessionStorageVersionUnsupportedError(sessionId);
  }
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
  const current = await Promise.all(records.map(async (item) => await storedSessionOverview(store, item)));
  return current
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, Math.max(1, limit));
}
