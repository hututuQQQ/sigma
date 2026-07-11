import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createKernelState, evolve } from "../packages/agent-kernel/src/index.js";
import {
  EVENT_SCHEMA_VERSION,
  emptyBudgetAmounts,
  type AgentEventEnvelope,
  type AgentEventType,
  type ContextAuthority,
  type JsonValue,
  type ModelCapabilities,
  type ModelGateway,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ModelToolDefinition
} from "../packages/agent-protocol/src/index.js";
import { recoverInterruptedSession } from "../packages/agent-runtime/src/session-recovery.js";
import type { RuntimeSession } from "../packages/agent-runtime/src/types.js";

class RecoveryGateway implements ModelGateway {
  readonly provider = "test-provider";
  readonly model = "test-model";
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 8_000,
    maxOutputTokens: 1_000,
    tools: true,
    parallelTools: false,
    reasoning: true,
    structuredOutput: false,
    promptCache: false,
    tokenizer: "approximate"
  };

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("not used");
  }

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield await Promise.reject(new Error("not used"));
  }

  async countTokens(messages: ModelMessage[], tools: ModelToolDefinition[] = []): Promise<number> {
    return JSON.stringify({ messages, tools }).length;
  }
}

function event(
  session: RuntimeSession,
  type: AgentEventType,
  authority: Exclude<ContextAuthority, "external_verifier">,
  payload: JsonValue
): AgentEventEnvelope {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    seq: session.seq + 1,
    eventId: randomUUID(),
    sessionId: session.sessionId,
    runId: session.runId,
    occurredAt: new Date().toISOString(),
    type,
    authority,
    payload
  };
}

function interruptedSession(semanticDelta: boolean, activeProcess = false): RuntimeSession {
  let state = createKernelState({
    sessionId: "model-recovery-session",
    runId: "model-recovery-run",
    mode: "change",
    startedAt: "2026-01-01T00:00:00.000Z",
    deadlineAt: "2026-01-01T01:00:00.000Z"
  });
  const user = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    seq: 1,
    eventId: "user-event",
    sessionId: state.sessionId,
    runId: state.runId,
    occurredAt: "2026-01-01T00:00:01.000Z",
    type: "user.message" as const,
    authority: "user" as const,
    payload: { text: "continue safely" }
  };
  state = evolve(state, user);
  state = evolve(state, {
    ...user,
    seq: 2,
    eventId: "model-started",
    type: "model.started",
    authority: "runtime",
    payload: { turnId: 1, effectRevision: 1 }
  });
  if (semanticDelta) {
    state = evolve(state, {
      ...user,
      seq: 3,
      eventId: "model-delta",
      type: "model.delta",
      authority: "runtime",
      payload: { turnId: 1, delta: "partial provider output" }
    });
  }
  if (activeProcess) {
    state = evolve(state, {
      ...user,
      seq: state.lastSeq + 1,
      eventId: "process-spawned",
      type: "process.spawned",
      authority: "runtime",
      payload: { processId: "background-1", executionId: "spawn-call", mode: "background" }
    });
  }
  return {
    sessionId: state.sessionId,
    runId: state.runId,
    modelTurn: 1,
    workspacePath: ".",
    mode: "change",
    writeScope: [],
    strictWriteScope: false,
    gateway: new RecoveryGateway(),
    modelRole: "orchestrator",
    state,
    seq: state.lastSeq,
    controller: null,
    turnController: null,
    deadlineTimer: null,
    running: null,
    subscribers: new Set(),
    approvals: new Map(),
    alwaysAllowedEffects: new Set(),
    steeringPending: 0,
    followUps: [],
    contextItems: [],
    loadedContextIds: new Set(),
    outcomeWaiters: [],
    idleWaiters: []
  };
}

async function recover(semanticDelta: boolean, activeProcess = false): Promise<{
  session: RuntimeSession;
  types: AgentEventType[];
  starts: number;
}> {
  const session = interruptedSession(semanticDelta, activeProcess);
  const types: AgentEventType[] = [];
  let starts = 0;
  await recoverInterruptedSession(session, {
    descriptors: [],
    settleToolBudget: async () => undefined,
    settleEligibleToolBudgets: async () => undefined,
    settleModelBudget: async (requestId) => {
      expect(requestId).toBe("model-recovery-run:1");
      return { ...emptyBudgetAmounts(), inputTokens: 100, outputTokens: 20, costMicroUsd: 25, modelTurns: 1 };
    },
    emit: async (type, authority, payload) => {
      const envelope = event(session, type, authority, payload as JsonValue);
      session.seq = envelope.seq;
      session.state = evolve(session.state, envelope);
      types.push(type);
      return envelope;
    },
    start: () => { starts += 1; }
  });
  return { session, types, starts };
}

describe("interrupted model recovery", () => {
  it("conservatively accounts and retries only when no semantic delta is durable", async () => {
    const result = await recover(false);
    expect(result.types).toEqual(["usage.recorded", "diagnostic"]);
    expect(result.session.state.phase).toBe("ready_model");
    expect(result.session.state.usage).toHaveLength(1);
    expect(result.session.state.usage[0]).toMatchObject({
      requestId: "model-recovery-run:1",
      providerReported: false,
      inputTokens: 100,
      outputTokens: 20,
      costMicroUsd: 25
    });
    expect(result.starts).toBe(1);
  });

  it("suspends instead of replaying after durable content or reasoning", async () => {
    const result = await recover(true);
    expect(result.types).toEqual(["usage.recorded", "run.suspended"]);
    expect(result.session.state).toMatchObject({
      phase: "needs_input",
      outcome: {
        kind: "needs_input",
        requestId: "model-recovery:model-recovery-run:1"
      }
    });
    expect(result.starts).toBe(0);
  });

  it("marks background handles lost and suspends instead of replaying them", async () => {
    const result = await recover(false, true);
    expect(result.types).toEqual([
      "process.lost",
      "usage.recorded",
      "diagnostic",
      "run.suspended"
    ]);
    expect(result.session.state.activeProcessIds).toEqual([]);
    expect(result.session.state).toMatchObject({
      phase: "needs_input",
      outcome: {
        kind: "needs_input",
        requestId: "process-recovery:background-1"
      }
    });
    expect(result.starts).toBe(0);
  });
});
