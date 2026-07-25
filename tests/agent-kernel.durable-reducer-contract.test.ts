import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  type AgentEventEnvelope,
  type AgentEventType,
  type EvidenceRecord,
  type JsonValue
} from "../packages/agent-protocol/src/index.js";
import {
  assertKernelInvariants,
  createKernelState,
  evolve,
  type KernelState
} from "../packages/agent-kernel/src/index.js";

const NOW = "2026-07-23T00:00:00.000Z";

function initial(): KernelState {
  return createKernelState({
    sessionId: "session",
    runId: "run",
    mode: "change",
    startedAt: NOW,
    deadlineAt: "2026-07-23T01:00:00.000Z"
  });
}

function apply(
  state: KernelState,
  type: AgentEventType,
  payload: JsonValue,
  authority: AgentEventEnvelope["authority"] = "runtime",
  overrides: Partial<AgentEventEnvelope> = {}
): KernelState {
  return evolve(state, {
    schemaVersion: EVENT_SCHEMA_VERSION,
    seq: state.lastSeq + 1,
    eventId: `event-${state.lastSeq + 1}`,
    sessionId: state.sessionId,
    runId: state.runId,
    occurredAt: NOW,
    type,
    authority,
    payload,
    ...overrides
  });
}

function diagnostic(id: string, producer: "runtime" | "tool" = "runtime"): EvidenceRecord {
  return {
    evidenceId: id,
    sessionId: "session",
    runId: "run",
    kind: "diagnostic",
    status: "passed",
    createdAt: NOW,
    producer: { authority: producer },
    summary: "diagnostic",
    data: { source: "test", diagnostic: { ok: true } }
  };
}

describe("V6 durable reducer contract", () => {
  it("requires matching evidence authority, producer, session, and run", () => {
    let state = initial();
    state = apply(state, "evidence.recorded", diagnostic("runtime"), "runtime");
    state = apply(state, "evidence.recorded", diagnostic("tool-wrong", "tool"), "runtime");
    state = apply(state, "evidence.recorded", diagnostic("tool", "tool"), "tool");
    state = apply(state, "evidence.recorded", {
      ...diagnostic("other-run"),
      runId: "other"
    }, "runtime");
    expect(state.evidence.map((item) => item.evidenceId)).toEqual(["runtime", "tool"]);
    assertKernelInvariants(state);
  });

  it("deduplicates evidence and usage independently", () => {
    let state = initial();
    state = apply(state, "evidence.recorded", diagnostic("same"));
    state = apply(state, "evidence.recorded", diagnostic("same"));
    const usage = {
      usageId: "usage",
      requestId: "request",
      sessionId: "session",
      runId: "run",
      role: "orchestrator",
      routeId: "route",
      providerId: "provider",
      modelId: "model",
      tokenizerId: "tokenizer",
      tokenizerAccuracy: "exact",
      providerReported: true,
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicroUsd: 0,
      latencyMs: 1,
      attempt: 1,
      occurredAt: NOW
    } as const;
    state = apply(state, "usage.recorded", usage);
    state = apply(state, "usage.recorded", usage);
    expect(state.evidence).toHaveLength(1);
    expect(state.usage).toHaveLength(1);
    assertKernelInvariants(state);
  });

  it("keeps the formal plan optional and updates it only monotonically", () => {
    let state = initial();
    expect(state.plan).toEqual({ revision: 0, goal: "", nodes: [] });
    state = apply(state, "plan.updated", {
      previousRevision: 0,
      plan: { revision: 1, goal: "optional plan", nodes: [] }
    });
    expect(state.plan).toMatchObject({ revision: 1, goal: "optional plan" });
    state = apply(state, "plan.updated", {
      previousRevision: 0,
      plan: { revision: 2, goal: "stale", nodes: [] }
    });
    expect(state.plan).toMatchObject({ revision: 1, goal: "optional plan" });
  });

  it("tracks only runtime-owned active processes and settles them idempotently", () => {
    let state = initial();
    state = apply(state, "process.spawned", { processId: "process" }, "tool");
    expect(state.activeProcessIds).toEqual([]);
    state = apply(state, "process.spawned", { processId: "process" });
    state = apply(state, "process.spawned", { processId: "process" });
    expect(state.activeProcessIds).toEqual(["process"]);
    state = apply(state, "process.exited", { processId: "process" });
    state = apply(state, "process.exited", { processId: "process" });
    expect(state.activeProcessIds).toEqual([]);
  });

  it("persists one valid archive and rejects non-runtime or malformed replacements", () => {
    const digest = "a".repeat(64);
    let state = apply(initial(), "context.compacted", {
      item: {
        id: "archive",
        authority: "tool",
        provenance: "summary",
        content: "content",
        tokenCount: 2,
        priority: 10,
        cacheKey: digest
      },
      omittedHistoryTurns: 3
    });
    expect(state.contextArchive).toMatchObject({
      sourceDigest: digest,
      omittedHistoryTurns: 3
    });
    state = apply(state, "context.compacted", {
      item: { cacheKey: "bad" },
      omittedHistoryTurns: 4
    });
    expect(state.contextArchive).toMatchObject({ sourceDigest: digest });
    state = apply(state, "context.compacted", {
      item: { cacheKey: "b".repeat(64) },
      omittedHistoryTurns: 4
    }, "tool");
    expect(state.contextArchive).toMatchObject({ sourceDigest: digest });
    assertKernelInvariants(state);
  });
});
