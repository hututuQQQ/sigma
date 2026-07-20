import { randomUUID } from "node:crypto";
import {
  EVENT_SCHEMA_VERSION,
  type AgentEventOf,
  type AgentEventEnvelope,
  type AgentEventPayloadMap,
  type AgentEventType,
  type ContextAuthority,
  type RunOutcome,
  type RunStore
} from "agent-protocol";
import { evolve } from "agent-kernel";
import { jsonValue } from "./json.js";
import { persistRuntimeSnapshot } from "./runtime-snapshot.js";
import type { RuntimeSession } from "./types.js";

type OutcomeEventType = "run.completed" | "run.cancelled" | "run.suspended" | "run.failed";

export class RuntimeEventLog {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly store: RunStore) {}

  async emitOutcomeIfCurrent(
    session: RuntimeSession,
    type: OutcomeEventType,
    outcome: RunOutcome,
    outcomeRevision: number
  ): Promise<AgentEventEnvelope | undefined> {
    const previous = this.queues.get(session.identity.sessionId) ?? Promise.resolve();
    let emitted: AgentEventEnvelope | undefined;
    const current = previous.then(async () => {
      if (session.durable.state.phase !== "outcome_pending" || session.durable.state.revision !== outcomeRevision) return;
      emitted = await this.emitLocked(session, type, "runtime", { ...outcome, outcomeRevision });
    });
    this.queues.set(session.identity.sessionId, current.catch(() => undefined));
    await current;
    return emitted;
  }

  async emit<TType extends AgentEventType>(
    session: RuntimeSession,
    type: TType,
    authority: Exclude<ContextAuthority, "external_verifier">,
    value: AgentEventPayloadMap[NoInfer<TType>]
  ): Promise<AgentEventOf<TType>> {
    const previous = this.queues.get(session.identity.sessionId) ?? Promise.resolve();
    let emitted!: AgentEventOf<TType>;
    const current = previous.then(async () => {
      emitted = await this.emitLocked(session, type, authority, value);
    });
    this.queues.set(session.identity.sessionId, current.catch(() => undefined));
    await current;
    return emitted;
  }

  async writeSnapshot(session: RuntimeSession): Promise<void> {
    await persistRuntimeSnapshot(this.store, session);
  }

  forget(sessionId: string): void {
    this.queues.delete(sessionId);
  }

  private async emitLocked<TType extends AgentEventType>(
    session: RuntimeSession,
    type: TType,
    authority: Exclude<ContextAuthority, "external_verifier">,
    value: AgentEventPayloadMap[NoInfer<TType>]
  ): Promise<AgentEventOf<TType>> {
    const expectedSeq = session.durable.seq;
    const event = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      seq: expectedSeq + 1,
      eventId: randomUUID(),
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      occurredAt: new Date().toISOString(),
      type,
      authority,
      payload: jsonValue(value)
    } as AgentEventOf<TType>;
    // TypeScript cannot distribute a generic indexed access over the mapped
    // event union, but `emit` has already bound TType to its payload above.
    // Preflight semantic reducers before the event becomes durable. A malformed
    // accounting transition must not be appended and then leave seq/state split.
    const nextState = evolve(session.durable.state, event);
    const append = await this.store.append(event as import("agent-protocol").AnyTypedAgentEvent, expectedSeq);
    session.durable.seq = event.seq;
    session.durable.state = nextState;
    for (const subscriber of session.interaction.subscribers) subscriber.push(event);
    if (append.rotated || event.seq % 250 === 0) await this.writeSnapshot(session);
    return event;
  }
}
