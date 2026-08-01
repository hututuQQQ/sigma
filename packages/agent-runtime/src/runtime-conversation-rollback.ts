import type { AgentEventOf, ThreadRollbackResult } from "agent-protocol";
import { waitForSessionIdleOutcome } from "./runtime-waiters.js";
import type { RuntimeSession } from "./types.js";

interface RuntimeRollbackOperations {
  waitForQuiescence(signal?: AbortSignal): Promise<void>;
  emit(numTurns: number): Promise<AgentEventOf<"session.history_rolled_back">>;
  writeSnapshot(): Promise<void>;
}

function rollbackError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

export async function rollbackRuntimeTurns(
  session: RuntimeSession,
  numTurns: number,
  operations: RuntimeRollbackOperations
): Promise<ThreadRollbackResult> {
  if (!Number.isInteger(numTurns) || numTurns < 1) {
    throw rollbackError("numTurns must be an integer >= 1.", "conversation_rollback_invalid");
  }
  if (session.durable.state.phase !== "terminal") {
    throw rollbackError(
      "Cannot rollback conversation history while a turn is active.",
      "conversation_rollback_busy"
    );
  }
  await waitForSessionIdleOutcome(session, operations.waitForQuiescence);
  if (
    session.execution.running
    || session.interaction.followUps.length > 0
    || session.durable.state.phase !== "terminal"
  ) {
    throw rollbackError(
      "Cannot rollback conversation history while a turn is active.",
      "conversation_rollback_busy"
    );
  }
  const availableTurns = session.durable.state.messages.filter((message) =>
    message.role === "user").length;
  if (availableTurns === 0) {
    throw rollbackError(
      "Conversation history has no user turns to rollback.",
      "conversation_rollback_empty"
    );
  }
  const removedTurns = Math.min(numTurns, availableTurns);
  const event = await operations.emit(removedTurns);
  await Promise.resolve(
    session.services.gateway.releaseSession?.(session.identity.sessionId)
  ).catch(() => undefined);
  await operations.writeSnapshot();
  return { removedTurns, lastSeq: event.seq };
}
