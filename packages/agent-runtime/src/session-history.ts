import { isAgentEventOf, type AgentEventEnvelope } from "agent-protocol";

function startsUserTurn(event: AgentEventEnvelope): boolean {
  return isAgentEventOf(event, "user.message")
    || isAgentEventOf(event, "user.steer")
    || (isAgentEventOf(event, "user.follow_up") && event.payload.status === "delivered");
}

/**
 * Materialize the conversation-visible event history after applying append-only
 * rollback markers. Accounting and checkpoint data stay durable in the store;
 * consumers only stop seeing events belonging to removed user turns.
 */
export async function* effectiveSessionEvents(
  source: AsyncIterable<AgentEventEnvelope>,
  afterSeq = 0
): AsyncIterable<AgentEventEnvelope> {
  const visible: AgentEventEnvelope[] = [];
  const userTurnPositions: number[] = [];

  for await (const event of source) {
    if (isAgentEventOf(event, "session.history_rolled_back")) {
      if (userTurnPositions.length > 0) {
        const firstRemovedTurn = Math.max(0, userTurnPositions.length - event.payload.numTurns);
        const firstRemovedPosition = userTurnPositions[firstRemovedTurn];
        if (firstRemovedPosition !== undefined) visible.splice(firstRemovedPosition);
        userTurnPositions.splice(firstRemovedTurn);
      }
      visible.push(event);
      continue;
    }
    if (startsUserTurn(event)) userTurnPositions.push(visible.length);
    visible.push(event);
  }

  for (const event of visible) {
    if (event.seq > afterSeq) yield event;
  }
}
