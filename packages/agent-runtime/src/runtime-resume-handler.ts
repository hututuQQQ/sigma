import { assertSessionStorageSupported } from "./session-catalog.js";
import type { SessionCommandBus } from "./session-command-bus.js";
import type { ManagedSessionLifecycle } from "./managed-session-lifecycle.js";
import type { RuntimeSession } from "./types.js";

interface ResumeOperations {
  readonly sessions: Map<string, RuntimeSession>;
  readonly commandBus: SessionCommandBus;
  readonly managedSessions: ManagedSessionLifecycle;
  recoverExisting(session: RuntimeSession): Promise<void>;
  resume(sessionId: string): Promise<void>;
}

export async function handleRuntimeResume(
  storeRootDir: string,
  sessionId: string,
  operations: ResumeOperations
): Promise<void> {
  await assertSessionStorageSupported(storeRootDir, sessionId);
  const existing = operations.sessions.get(sessionId);
  if (existing) {
    // A checkpoint decision is intentionally two-phase. The runtime that owns
    // the hydrated session may resume after the durable decision without
    // trying to reacquire its own command-bus lease.
    if (existing.recovery.openCheckpointRecovery || existing.execution.running) return;
    await operations.recoverExisting(existing);
    return;
  }
  await operations.commandBus.claim(sessionId);
  try {
    await operations.resume(sessionId);
    if (operations.sessions.get(sessionId)?.durable.state.phase === "terminal") {
      await operations.commandBus.release(sessionId);
    }
  } catch (error) {
    operations.sessions.delete(sessionId);
    await operations.managedSessions.release(sessionId);
    await operations.commandBus.release(sessionId);
    throw error;
  }
}
