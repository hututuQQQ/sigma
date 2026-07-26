import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  createBudgetLedger,
  type AgentEventEnvelope,
  type AgentEventType,
  type EvidenceRecord,
  type JsonValue
} from "../packages/agent-protocol/src/index.js";
import {
  acceptMutationFrontier,
  assertKernelInvariants,
  createKernelState,
  decide,
  emptyMutationFrontier,
  evolve,
  frontierAfterCheckpoint,
  isKernelState,
  isStaleEffect,
  isTerminal,
  type KernelState
} from "../packages/agent-kernel/src/index.js";
import {
  checkpointFixture,
  evidenceFixture,
  usageFixture
} from "./testkit/agent-event-fixtures.js";

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

function event(
  state: KernelState,
  type: AgentEventType,
  payload: JsonValue = {},
  authority: AgentEventEnvelope["authority"] = "runtime"
): AgentEventEnvelope {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    seq: state.lastSeq + 1,
    eventId: `event-${state.lastSeq + 1}`,
    sessionId: state.sessionId,
    runId: state.runId,
    occurredAt: NOW,
    type,
    authority,
    payload
  };
}

function apply(
  state: KernelState,
  type: AgentEventType,
  payload: JsonValue = {},
  authority?: AgentEventEnvelope["authority"]
): KernelState {
  return evolve(state, event(state, type, payload, authority));
}

function start(state: KernelState, turnId: number): KernelState {
  return apply(state, "model.started", { turnId, effectRevision: state.revision });
}

function complete(
  state: KernelState,
  payload: Record<string, JsonValue>
): KernelState {
  return apply(state, "model.completed", { ...payload, ...state.activeModelTurn! });
}

function toolTurn(
  state: KernelState,
  turnId: number,
  calls: Array<{ id: string; name: string; arguments: JsonValue }>
): KernelState {
  return complete(start(state, turnId), {
    message: { role: "assistant", content: "", toolCalls: calls },
    toolCalls: calls,
    finishReason: "tool_calls"
  });
}

function settle(
  state: KernelState,
  callId: string,
  ok = true,
  effects: JsonValue = ["filesystem.read"]
): KernelState {
  const pending = state.pendingTools.find((item) => item.request.callId === callId)!;
  const turn = pending.modelTurn;
  return apply(state, ok ? "tool.completed" : "tool.failed", {
    callId,
    name: pending.request.name,
    ...turn,
    ok,
    output: ok ? "observed" : "failed",
    outcome: {
      status: ok ? "succeeded" : "failed",
      output: ok ? "observed" : "failed",
      diagnosticCodes: ok ? [] : ["failed"]
    },
    observedEffects: effects,
    actualEffects: effects,
    artifacts: [],
    diagnostics: ok ? [] : ["failed"],
    evidence: [],
    startedAt: NOW,
    completedAt: NOW
  });
}

function pendingTool(callId = "call") {
  return {
    request: { callId, name: "read", arguments: {} },
    modelTurn: { turnId: 1, effectRevision: 0 },
    approval: "not_required" as const,
    started: false
  };
}

function workspaceEvidence(id = "workspace"): EvidenceRecord {
  return {
    evidenceId: id,
    sessionId: "session",
    runId: "run",
    kind: "workspace_delta",
    status: "passed",
    createdAt: NOW,
    producer: { authority: "runtime" },
    summary: "changed",
    data: {
      checkpointId: "checkpoint",
      delta: { added: ["a.ts"], modified: [], deleted: [] }
    }
  };
}

describe("agent-kernel protocol behavior", () => {
  it("records every call in a mixed batch without interpreting its semantics", () => {
    let state = apply(initial(), "user.message", { text: "Inspect or ask." });
    state = toolTurn(state, 1, [
      { id: "ask", name: "request_user_input", arguments: { message: "Which path?" } },
      { id: "read", name: "read", arguments: { path: "seed.txt" } }
    ]);
    expect(state).toMatchObject({ phase: "tool_pending" });
    expect(state.pendingTools.map((item) => item.request.callId)).toEqual(["ask", "read"]);
    expect(state).not.toHaveProperty("taskControl");
    assertKernelInvariants(state);
  });

  it("proposes natural text directly and bounds clean length recovery", () => {
    const prepared = apply(initial(), "user.message", { text: "Answer." });
    const natural = complete(start(prepared, 1), {
      message: { role: "assistant", content: "Done." },
      toolCalls: [],
      finishReason: "stop"
    });
    expect(natural).toMatchObject({
      phase: "outcome_pending",
      proposedOutcome: { kind: "completed", message: "Done." }
    });
    const empty = complete(start(prepared, 2), {
      message: { role: "assistant", content: "" },
      toolCalls: [],
      finishReason: "stop"
    });
    expect(empty.proposedOutcome).toMatchObject({
      kind: "recoverable_failure",
      code: "empty_assistant_response"
    });
    let length = complete(start(prepared, 3), {
      message: { role: "assistant", content: "partial" },
      toolCalls: [],
      finishReason: "length"
    });
    expect(length).toMatchObject({
      phase: "ready_model",
      consecutiveLengthFinishes: 1,
      consecutiveLengthNoAction: 1,
      lengthRecovery: { mode: "retry_with_headroom", attempts: 1 }
    });
    expect(length.messages.some((message) => message.content === "partial")).toBe(false);
    const recoveredStop = complete(start(length, 4), {
      message: { role: "assistant", content: "I stopped instead." },
      toolCalls: [],
      finishReason: "stop"
    });
    expect(recoveredStop.proposedOutcome).toMatchObject({
      kind: "completed",
      message: "I stopped instead."
    });
    length = complete(start(length, 5), {
      message: { role: "assistant", content: "still partial" },
      toolCalls: [],
      finishReason: "length"
    });
    expect(length.proposedOutcome).toMatchObject({
      kind: "recoverable_failure",
      code: "model_output_limit"
    });

    let bounded = start({
      ...prepared,
      lengthRecovery: { schemaVersion: 1, mode: "action_required", attempts: 1 }
    }, 7);
    bounded = apply(bounded, "model.prompt_materialized", {
      ...bounded.activeModelTurn!,
      messages: [],
      toolChoice: "none"
    });
    expect(bounded.lengthRecovery.mode).toBe("bounded_answer");
    bounded = complete(bounded, {
      message: { role: "assistant", content: "Small complete answer." },
      toolCalls: [],
      finishReason: "stop"
    });
    expect(bounded.proposedOutcome).toMatchObject({
      kind: "completed",
      message: "Small complete answer."
    });
  });

  it("preserves tool-call/result pairs across approval and failed receipts", () => {
    let state = apply(initial(), "user.message", { text: "Use a tool." });
    state = toolTurn(state, 1, [{ id: "write", name: "write", arguments: { path: "a" } }]);
    const turn = state.pendingTools[0]!.modelTurn;
    state = apply(state, "tool.approval_requested", { callId: "write", ...turn });
    expect(state.phase).toBe("needs_input");
    state = apply(state, "tool.approval_resolved", {
      callId: "write",
      ...turn,
      decision: "allow"
    });
    state = apply(state, "tool.started", { callId: "write", ...turn });
    state = settle(state, "write", false, ["filesystem.write"]);
    expect(state.phase).toBe("ready_model");
    expect(state.receipts).toHaveLength(1);
    expect(state.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "write" });
    expect(state.proposedOutcome).toBeUndefined();
    assertKernelInvariants(state);
  });

  it("recognizes explicit input/blocking only for a single successful terminal call", () => {
    let input = apply(initial(), "user.message", { text: "Ask if needed." });
    input = toolTurn(input, 1, [{
      id: "input",
      name: "request_user_input",
      arguments: { message: "Which target?" }
    }]);
    input = settle(input, "input", true, ["outcome.request_input"]);
    expect(input.proposedOutcome).toEqual({
      kind: "needs_input",
      requestId: "input",
      message: "Which target?"
    });

    let mixed = apply(initial(), "user.message", { text: "Mixed." });
    mixed = toolTurn(mixed, 1, [
      { id: "input", name: "request_user_input", arguments: { message: "Which target?" } },
      { id: "read", name: "read", arguments: { path: "a" } }
    ]);
    mixed = settle(mixed, "input", true, ["outcome.request_input"]);
    mixed = settle(mixed, "read");
    expect(mixed.proposedOutcome).toBeUndefined();
    expect(mixed.phase).toBe("ready_model");
  });

  it("adds one advisory for an exact triple without rejecting later calls", () => {
    let state = apply(initial(), "user.message", { text: "Inspect." });
    for (let turn = 1; turn <= 5; turn += 1) {
      state = toolTurn(state, turn, [{
        id: `read-${turn}`,
        name: "read",
        arguments: { path: "same.txt", options: { line: 1 } }
      }]);
      state = settle(state, `read-${turn}`);
    }
    expect(state.messages.filter((message) =>
      message.role === "developer" && message.content.includes("only an advisory")))
      .toHaveLength(1);
    expect(state.phase).toBe("ready_model");
    expect(state.proposedOutcome).toBeUndefined();
  });

  it("persists a context archive through the existing compacted event", () => {
    const digest = "a".repeat(64);
    const state = apply(initial(), "context.compacted", {
      item: {
        id: "archive",
        authority: "tool",
        provenance: "model-generated conversation archive",
        content: "summary",
        tokenCount: 2,
        priority: 600,
        cacheKey: digest
      },
      omittedHistoryTurns: 4
    });
    expect(state.contextArchive).toEqual({
      schemaVersion: 1,
      item: expect.objectContaining({ id: "archive", cacheKey: digest }),
      omittedHistoryTurns: 4,
      sourceDigest: digest
    });
    assertKernelInvariants(state);
  });

  it("decides phases and rejects stale effects", () => {
    const base = initial();
    expect(decide(base)).toEqual([]);
    const ready = {
      ...base,
      phase: "ready_model" as const,
      revision: 2,
      messages: [{ role: "user" as const, content: "x" }]
    };
    const request = decide(ready)[0]!;
    expect(request).toMatchObject({ type: "request_model", revision: 2 });
    expect(isStaleEffect(ready, request)).toBe(false);
    expect(isStaleEffect({ ...ready, revision: 3 }, request)).toBe(true);
    const terminal = {
      ...base,
      phase: "terminal" as const,
      outcome: { kind: "cancelled" as const, reason: "x" }
    };
    expect(isTerminal(terminal)).toBe(true);
    expect(decide(terminal)).toEqual([{ type: "publish_outcome", revision: 0 }]);
  });

  it("advances and accepts a mutation frontier independently of completion policy", () => {
    const frontier = frontierAfterCheckpoint(emptyMutationFrontier(), {
      checkpointId: "checkpoint",
      sessionId: "session",
      runId: "run",
      status: "sealed",
      preManifestDigest: "a".repeat(64),
      postManifestDigest: "b".repeat(64),
      delta: { added: ["new.ts"], modified: [], deleted: [] },
      createdAt: NOW
    }, [{
      evidenceId: "delta",
      sessionId: "session",
      runId: "run",
      kind: "workspace_delta",
      status: "passed",
      createdAt: NOW,
      producer: { authority: "runtime" },
      summary: "changed",
      data: {
        checkpointId: "checkpoint",
        delta: { added: ["new.ts"], modified: [], deleted: [] }
      }
    }]);
    expect(frontier).toMatchObject({ revision: 1, changedPaths: ["new.ts"] });
    expect(acceptMutationFrontier(frontier)).toMatchObject({
      revision: 1,
      changedPaths: [],
      baselineManifestDigest: frontier.currentStateDigest
    });
  });

  it("rejects invalid durable invariants", () => {
    const state = initial();
    expect(isKernelState(state)).toBe(true);
    expect(() => assertKernelInvariants({
      ...state,
      activeProcessIds: ["same", "same"]
    })).toThrow("Duplicate active process IDs");
  });

  it("rejects malformed and cross-scope durable ledgers", () => {
    const state = initial();
    expect(() => assertKernelInvariants({ ...state, schemaVersion: 999 } as KernelState))
      .toThrow("schema version");
    expect(() => assertKernelInvariants({ ...state, plan: {} } as KernelState))
      .toThrow("plan graph");
    expect(() => assertKernelInvariants({ ...state, budget: {} } as KernelState))
      .toThrow("budget ledger");
    expect(() => assertKernelInvariants({ ...state, checkpointHead: {} } as KernelState))
      .toThrow("checkpoint head");
    expect(() => assertKernelInvariants({
      ...state, checkpointHead: { ...checkpointFixture("sealed"), sessionId: "other" }
    })).toThrow("checkpoint head");
    expect(() => assertKernelInvariants({
      ...state, checkpointHead: { ...checkpointFixture("sealed"), runId: "other" }
    })).toThrow("checkpoint head");
    expect(() => assertKernelInvariants({ ...state, evidence: [{}] } as KernelState))
      .toThrow("evidence ledger");
    expect(() => assertKernelInvariants({ ...state, mutationEvidence: [{}] } as KernelState))
      .toThrow("mutation evidence ledger");
    expect(() => assertKernelInvariants({
      ...state, mutationEvidence: [{ ...workspaceEvidence(), sessionId: "other" }]
    })).toThrow("active session");
    expect(() => assertKernelInvariants({
      ...state, evidence: [{ ...evidenceFixture(), sessionId: "other" }]
    })).toThrow("active session and run");
    expect(() => assertKernelInvariants({
      ...state, evidence: [{ ...evidenceFixture(), runId: "other" }]
    })).toThrow("active session and run");
  });

  it("rejects duplicate durable evidence, usage, and reservations", () => {
    const state = initial();
    const waiver = evidenceFixture("user_waiver");
    expect(() => assertKernelInvariants({
      ...state,
      evidence: [waiver, { ...waiver, evidenceId: "second-waiver" }]
    })).toThrow("at most one user waiver");
    const diagnostic = evidenceFixture();
    expect(() => assertKernelInvariants({ ...state, evidence: [diagnostic, diagnostic] }))
      .toThrow("Duplicate kernel evidence");
    const mutation = workspaceEvidence();
    expect(() => assertKernelInvariants({
      ...state, mutationEvidence: [mutation, mutation]
    })).toThrow("Duplicate kernel mutation evidence");
    expect(() => assertKernelInvariants({ ...state, usage: [{}] } as KernelState))
      .toThrow("usage ledger");
    const usage = usageFixture();
    expect(() => assertKernelInvariants({ ...state, usage: [usage, usage] }))
      .toThrow("Duplicate kernel usage");
    const budget = createBudgetLedger();
    const zero = { inputTokens: 0, outputTokens: 0, costMicroUsd: 0, modelTurns: 0, toolCalls: 0, children: 0 };
    budget.reserved = { ...zero, inputTokens: 1 };
    budget.reservations = [{
      reservationId: "reservation",
      ownerId: "owner",
      status: "reserved",
      requested: { ...zero, inputTokens: 1 },
      consumed: zero,
      createdAt: NOW
    }];
    expect(() => assertKernelInvariants({ ...state, budget })).not.toThrow();
    expect(() => assertKernelInvariants({
      ...state, budget: { ...budget, reservations: [budget.reservations[0]!, budget.reservations[0]!] }
    })).toThrow("Duplicate budget reservation");
    expect(() => assertKernelInvariants({
      ...state, budget: { ...budget, reserved: zero }
    })).toThrow("does not match its active reservations");
    expect(() => assertKernelInvariants({ ...state, contextArchive: {} } as KernelState))
      .toThrow("context archive");
  });

  it("rejects malformed tool ledgers and contradictory phases", () => {
    const state = initial();
    const pending = pendingTool();
    expect(() => assertKernelInvariants({
      ...state, pendingTools: [pending, pending], toolCallIds: ["call"]
    })).toThrow("Duplicate pending");
    expect(() => assertKernelInvariants({
      ...state, toolCallIds: ["call", "call"]
    })).toThrow("Duplicate run tool");
    expect(() => assertKernelInvariants({
      ...state,
      pendingTools: [{ ...pending, modelTurn: { turnId: 1.5, effectRevision: 0 } }],
      toolCallIds: ["call"]
    })).toThrow("valid originating model turn");
    expect(() => assertKernelInvariants({
      ...state,
      pendingTools: [{ ...pending, modelTurn: { turnId: 1, effectRevision: 0.5 } }],
      toolCallIds: ["call"]
    })).toThrow("valid originating model turn");
    expect(() => assertKernelInvariants({ ...state, pendingTools: [pending] }))
      .toThrow("run tool-call ledger");
    expect(() => assertKernelInvariants({
      ...state, phase: "model_in_flight", activeModelTurn: undefined
    })).toThrow("active model turn");
    expect(() => assertKernelInvariants({
      ...state, activeModelTurn: { turnId: 1, effectRevision: 0 }
    })).toThrow("active model turn");
    expect(() => assertKernelInvariants({
      ...state, activeModelSemanticDelta: true
    })).toThrow("semantic delta");
  });

  it("rejects contradictory terminal and proposed outcomes", () => {
    const state = initial();
    expect(() => assertKernelInvariants({ ...state, phase: "terminal" }))
      .toThrow("requires an outcome");
    expect(() => assertKernelInvariants({
      ...state, outcome: { kind: "cancelled", reason: "no" }
    })).toThrow("cannot have a terminal outcome");
    expect(() => assertKernelInvariants({
      ...state,
      phase: "needs_input",
      outcome: { kind: "needs_input", requestId: "input", message: "choose" }
    })).not.toThrow();
    expect(() => assertKernelInvariants({
      ...state, phase: "outcome_pending", proposedOutcome: undefined
    })).toThrow("proposed outcome");
    expect(() => assertKernelInvariants({
      ...state, proposedOutcome: { kind: "completed", message: "done", evidence: [] }
    })).toThrow("proposed outcome");
  });

  it("validates optional deadline, recovery, prompt, and frozen state", () => {
    const state = initial();
    expect(isKernelState(null)).toBe(false);
    expect(isKernelState([])).toBe(false);
    expect(isKernelState({ ...state, deadlineRemainingMs: 1 })).toBe(true);
    expect(isKernelState({ ...state, deadlineRemainingMs: 0 })).toBe(false);
    expect(isKernelState({ ...state, lastModelFinishReason: "length" })).toBe(true);
    expect(isKernelState({ ...state, lastModelFinishReason: "unknown" })).toBe(false);
    expect(isKernelState({
      ...state,
      lengthRecovery: { schemaVersion: 1, mode: "action_required", attempts: 1 }
    })).toBe(true);
    expect(isKernelState({
      ...state,
      lengthRecovery: { schemaVersion: 1, mode: "retry_with_headroom", attempts: 1 }
    })).toBe(true);
    expect(isKernelState({ ...state, lengthRecovery: {} })).toBe(false);
    expect(isKernelState({
      ...state,
      toolResultPrune: { schemaVersion: 1, coveredBlocks: 2, sourceDigest: "a".repeat(64) },
      activeModelSemanticDelta: false
    })).toBe(true);
    expect(isKernelState({ ...state, toolResultPrune: {} })).toBe(false);
    expect(isKernelState({ ...state, activeModelSemanticDelta: "yes" })).toBe(false);
    const frozen = {
      artifactId: "artifact",
      digest: "digest",
      source: "workspace" as const,
      qualifiedName: "skill"
    };
    expect(isKernelState({
      ...state,
      frozenProfile: frozen,
      frozenCustomization: {
        artifactId: "d".repeat(64),
        digest: "e".repeat(64)
      },
      frozenSkills: [{
        ...frozen,
        executionManifestArtifactId: "b".repeat(64),
        executionManifestDigest: "c".repeat(64)
      }]
    })).toBe(true);
    expect(isKernelState({ ...state, frozenProfile: {} })).toBe(false);
    expect(isKernelState({ ...state, frozenCustomization: {} })).toBe(false);
    expect(isKernelState({ ...state, frozenSkills: [{}] })).toBe(false);
  });
});
