import { randomUUID } from "node:crypto";
import {
  EVENT_SCHEMA_VERSION,
  type AgentEventOf,
  type AgentEventEnvelope,
  type AgentEventPayloadMap,
  type AgentEventType,
  type ContextAuthority,
  type RunOutcome,
  type RunStore,
  type AnyTypedAgentEvent
} from "agent-protocol";
import { evolve } from "agent-kernel";
import { jsonValue } from "./json.js";
import { persistRuntimeSnapshot } from "./runtime-snapshot.js";
import type { RuntimeSession } from "./types.js";
import type { RuntimeEventEmission } from "./runtime-event-emitter.js";

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

  async emitBatch(
    session: RuntimeSession,
    emissions: readonly RuntimeEventEmission[]
  ): Promise<AgentEventEnvelope[]> {
    if (emissions.length === 0) return [];
    const previous = this.queues.get(session.identity.sessionId) ?? Promise.resolve();
    let emitted: AgentEventEnvelope[] = [];
    const current = previous.then(async () => {
      emitted = await this.emitBatchLocked(session, emissions);
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
    const [event] = await this.emitBatchLocked(session, [{
      type,
      authority,
      payload: value
    } as RuntimeEventEmission]);
    return event as AgentEventOf<TType>;
  }

  private async emitBatchLocked(
    session: RuntimeSession,
    emissions: readonly RuntimeEventEmission[]
  ): Promise<AgentEventEnvelope[]> {
    const expectedSeq = session.durable.seq;
    let projectedState = session.durable.state;
    const events = emissions.map((emission, index) => {
      const event = {
        schemaVersion: EVENT_SCHEMA_VERSION,
        seq: expectedSeq + index + 1,
        eventId: randomUUID(),
        sessionId: session.identity.sessionId,
        runId: session.durable.runId,
        occurredAt: new Date().toISOString(),
        type: emission.type,
        authority: emission.authority,
        payload: jsonValue(emission.payload)
      } as AnyTypedAgentEvent;
      projectedState = evolve(projectedState, event);
      return event;
    });
    let rotated = false;
    // Preserve the long-standing single-event append interception contract
    // used by fault injectors, adapters, and custom stores. Batch only when a
    // logical transaction actually contains multiple events.
    if (events.length > 1 && this.store.appendBatch) {
      ({ rotated } = await this.store.appendBatch(events, expectedSeq));
    } else {
      for (const [index, event] of events.entries()) {
        const result = await this.store.append(event, expectedSeq + index);
        rotated ||= result.rotated;
      }
    }
    const last = events.at(-1)!;
    session.durable.seq = last.seq;
    session.durable.state = projectedState;
    for (const event of events) {
      for (const subscriber of session.interaction.subscribers) subscriber.push(event);
    }
    if (rotated || events.some((event) => event.seq % 250 === 0)) {
      await this.writeSnapshot(session);
    }
    return events;
  }
}
