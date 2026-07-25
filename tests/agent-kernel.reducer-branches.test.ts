import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  emptyLongHorizonState,
  type AgentEventEnvelope,
  type AgentEventType,
  type JsonValue
} from "../packages/agent-protocol/src/index.js";
import {
  createKernelState,
  evolve,
  type KernelState
} from "../packages/agent-kernel/src/index.js";
import { evidenceFixture } from "./testkit/agent-event-fixtures.js";

const NOW = "2026-07-24T00:00:00.000Z";

function initial(): KernelState {
  return createKernelState({
    sessionId: "session",
    runId: "run",
    mode: "change",
    startedAt: NOW,
    deadlineAt: "2026-07-24T01:00:00.000Z"
  });
}

function apply(
  state: KernelState,
  type: AgentEventType,
  payload: JsonValue = {},
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

function ready(): KernelState {
  return apply(initial(), "user.message", { text: "work" }, "user");
}

function start(state: KernelState, turnId = 1): KernelState {
  return apply(state, "model.started", {
    turnId,
    effectRevision: state.revision
  });
}

function complete(
  state: KernelState,
  payload: Record<string, JsonValue>
): KernelState {
  return apply(state, "model.completed", {
    ...payload,
    ...state.activeModelTurn!
  });
}

function oneTool(state: KernelState, id = "call", name = "read"): KernelState {
  const calls = [{ id, name, arguments: { path: "a" } }];
  return complete(start(state), {
    message: { role: "assistant", content: "", toolCalls: calls },
    toolCalls: calls,
    finishReason: "tool_calls"
  });
}

function toolReceiptPayload(state: KernelState, callId: string, ok = true): JsonValue {
  const modelTurn = state.pendingTools.find((item) =>
    item.request.callId === callId)?.modelTurn ?? { turnId: 1, effectRevision: 0 };
  return {
    callId,
    ...modelTurn,
    ok,
    output: ok ? "ok" : "failed",
    outcome: {
      status: ok ? "succeeded" : "failed",
      output: ok ? "ok" : "failed",
      diagnosticCodes: []
    },
    observedEffects: ["filesystem.read"],
    actualEffects: ["filesystem.read"],
    artifacts: [],
    diagnostics: [],
    evidence: [],
    startedAt: NOW,
    completedAt: NOW
  };
}

describe("agent-kernel reducer branch contracts", () => {
  it("materializes only current valid prompt frames and semantic deltas", () => {
    let state = ready();
    const unchanged = apply(state, "model.started", { turnId: "bad", effectRevision: state.revision });
    expect(unchanged.phase).toBe("ready_model");
    state = apply(unchanged, "model.started", { turnId: 1, effectRevision: -1 });
    expect(state.phase).toBe("ready_model");
    state = start(state);
    const active = state.activeModelTurn!;
    state = apply(state, "model.prompt_materialized", {
      ...active,
      messages: "bad"
    });
    expect(state.messages.at(-1)?.role).toBe("user");
    state = apply(state, "model.prompt_materialized", {
      ...active,
      messages: [{ role: "invalid", content: "bad" }]
    });
    expect(state.messages.at(-1)?.role).toBe("user");
    const promptState = {
      schemaVersion: 1 as const,
      sectionDigests: { plan: "a".repeat(64) },
      budgetBand: 100 as const
    };
    state = apply(state, "model.prompt_materialized", {
      ...active,
      messages: [{ role: "developer", content: "state" }],
      promptState
    });
    expect(state.messages.at(-1)).toEqual({ role: "developer", content: "state" });
    expect(state.promptState).toEqual(promptState);
    state = apply(state, "model.delta", { turnId: 99 });
    expect(state.activeModelSemanticDelta).toBe(false);
    state = apply(state, "model.reasoning_delta", active);
    expect(state.activeModelSemanticDelta).toBe(true);
  });

  it("types model protocol failures, duplicate IDs, and tool-call truncation", () => {
    const filtered = complete(start(ready()), {
      message: { role: "assistant", content: "" },
      toolCalls: [],
      finishReason: "content_filter"
    });
    expect(filtered.proposedOutcome).toMatchObject({
      kind: "recoverable_failure", code: "model_protocol_error"
    });
    const unknown = complete(start(ready()), {
      message: { role: "assistant", content: "" },
      toolCalls: [],
      finishReason: "unknown"
    });
    expect(unknown.lastModelFinishReason).toBeUndefined();
    const duplicateCalls = [
      { id: "same", name: "read", arguments: {} },
      { id: "same", name: "read", arguments: {} }
    ];
    const duplicate = complete(start(ready()), {
      message: { role: "assistant", content: "", toolCalls: duplicateCalls },
      toolCalls: duplicateCalls,
      finishReason: "tool_calls"
    });
    expect(duplicate.proposedOutcome).toMatchObject({ code: "protocol_error" });
    const reusedBase = { ...ready(), toolCallIds: ["used"] };
    const reusedCalls = [{ id: "used", name: "read", arguments: {} }];
    const reused = complete(start(reusedBase), {
      message: { role: "assistant", content: "", toolCalls: reusedCalls },
      toolCalls: reusedCalls,
      finishReason: "tool_calls"
    });
    expect(reused.proposedOutcome).toMatchObject({ code: "protocol_error" });
    const lengthCalls = [{ id: "length-call", name: "read", arguments: {} }];
    const length = complete(start(ready()), {
      message: { role: "assistant", content: "", toolCalls: lengthCalls },
      toolCalls: lengthCalls,
      finishReason: "length"
    });
    expect(length).toMatchObject({
      phase: "tool_pending",
      lastModelFinishReason: "length",
      lengthRecovery: { mode: "continue_after_tools", attempts: 1 }
    });
    const failed = apply(start(ready()), "model.failed", {
      turnId: 1,
      effectRevision: 1,
      code: "",
      message: ""
    });
    expect(failed.proposedOutcome).toMatchObject({ code: "model_error" });
  });

  it("handles run starts, follow-ups, approvals, and partially settled batches", () => {
    let state = apply(initial(), "run.started", { mode: "invalid", deadlineAt: 1 });
    expect(state).toMatchObject({ mode: "change", phase: "idle" });
    state = apply(ready(), "run.started", {
      mode: "analyze",
      deadlineAt: "2026-07-24T02:00:00.000Z"
    });
    expect(state).toMatchObject({ mode: "analyze", phase: "ready_model" });
    const queued = apply(state, "user.follow_up", { status: "queued", text: "later" }, "user");
    expect(queued.messages).toEqual(state.messages);
    state = apply(queued, "user.follow_up", { status: "applied", text: "now" }, "user");
    expect(state.messages.at(-1)?.content).toBe("now");
    state = oneTool(state);
    const turn = state.pendingTools[0]!.modelTurn;
    expect(apply(state, "tool.approval_requested", {
      callId: "missing", ...turn
    }).phase).toBe("tool_pending");
    state = apply(state, "tool.approval_requested", { callId: "call", ...turn });
    expect(state.phase).toBe("needs_input");
    state = apply(state, "tool.approval_resolved", {
      callId: "missing",
      ...turn,
      deadlineAt: "2026-07-24T03:00:00.000Z",
      decision: "deny"
    });
    expect(state.deadlineAt).toBe("2026-07-24T03:00:00.000Z");
    state = apply(state, "tool.approval_resolved", {
      callId: "call", ...turn, decision: "always_allow"
    });
    expect(state.pendingTools[0]?.approval).toBe("allowed");
    expect(apply(state, "tool.started", {
      callId: "missing", ...turn
    }).phase).toBe("tool_pending");

    const calls = [
      { id: "first", name: "read", arguments: {} },
      { id: "second", name: "read", arguments: {} }
    ];
    let batch = complete(start(ready()), {
      message: { role: "assistant", content: "", toolCalls: calls },
      toolCalls: calls,
      finishReason: "tool_calls"
    });
    batch = apply(batch, "tool.completed", toolReceiptPayload(batch, "first"));
    expect(batch).toMatchObject({ phase: "tool_pending", pendingTools: [expect.anything()] });
    expect(batch.pendingTools).toHaveLength(1);
    expect(apply(batch, "tool.completed", { callId: "bad" })).toEqual(
      expect.objectContaining({ receipts: batch.receipts })
    );
  });

  it("handles suspensions, failures, completion, and recovery diagnostics", () => {
    let state = ready();
    expect(apply(state, "run.suspended", { message: "invalid" }).phase).toBe("ready_model");
    state = apply(state, "run.suspended", {
      requestId: "runtime-request",
      message: "approve",
      remainingDeadlineMs: 10
    });
    expect(state).toMatchObject({
      phase: "needs_input",
      deadlineRemainingMs: 10,
      outcome: { kind: "needs_input", requestId: "runtime-request" }
    });
    let proposed = complete(start(ready()), {
      message: { role: "assistant", content: "done" },
      toolCalls: [],
      finishReason: "stop"
    });
    const outcomeRevision = proposed.revision;
    proposed = apply(proposed, "run.completed", {
      outcomeRevision,
      message: ""
    });
    expect(proposed).toMatchObject({ phase: "terminal", outcome: { kind: "completed" } });

    const fatal = apply(ready(), "run.failed", {
      kind: "fatal",
      code: "",
      message: "",
      outcomeRevision: undefined
    });
    expect(fatal.outcome).toMatchObject({ kind: "fatal", code: "runtime_error" });
    const recoverable = apply(ready(), "run.failed", {
      kind: "recoverable_failure",
      code: "blocked",
      message: "blocked",
      resumeToken: "resume",
      failureKind: "blocked",
      failureCode: "missing"
    });
    expect(recoverable.outcome).toMatchObject({
      kind: "recoverable_failure",
      resumeToken: "resume",
      failureKind: "blocked",
      failureCode: "missing"
    });
    state = ready();
    const messagesBeforeRetry = state.messages;
    state = apply(state, "diagnostic", {
      kind: "recovery.retry_model", message: "retry"
    });
    expect(state.messages).toBe(messagesBeforeRetry);
    for (let index = 0; index < 100_000; index += 1) {
      state = apply(state, "diagnostic", {
        kind: "recovery.retry_model", message: `retry-${index}`
      });
    }
    expect(state.messages).toBe(messagesBeforeRetry);
    state = apply(state, "diagnostic", {
      kind: "completion.advisory", message: "repair"
    });
    expect(state.messages.at(-1)?.content).toBe("repair");
    state = apply(state, "diagnostic", {
      kind: "child.join_failed", failures: ["child", 1]
    });
    expect(state.messages.at(-1)?.content).toContain("child");
    expect(apply(state, "diagnostic", { kind: "other" })).toMatchObject({
      phase: "ready_model"
    });
  });

  it("persists only monotonic pruning and correctly authorized review evidence", () => {
    const pruning = {
      schemaVersion: 1 as const,
      coveredBlocks: 3,
      sourceDigest: "a".repeat(64),
      archiveSourceDigest: "b".repeat(64)
    };
    let state = apply(initial(), "context.tool_results_pruned", { state: pruning });
    expect(state.toolResultPrune).toEqual(pruning);
    state = apply(state, "context.tool_results_pruned", {
      state: { ...pruning, coveredBlocks: 2 }
    });
    expect(state.toolResultPrune?.coveredBlocks).toBe(3);
    state = apply(state, "context.tool_results_pruned", { state: {} });
    expect(state.toolResultPrune?.coveredBlocks).toBe(3);
    state = apply(state, "context.tool_results_pruned", {
      state: { ...pruning, coveredBlocks: 4 }
    }, "tool");
    expect(state.toolResultPrune?.coveredBlocks).toBe(3);

    const longHorizon = { ...emptyLongHorizonState(), goalEpoch: 1 };
    state = apply(state, "long_horizon.updated", { state: {} });
    expect(state.longHorizon.goalEpoch).toBe(0);
    state = apply(state, "long_horizon.updated", { state: longHorizon }, "tool");
    expect(state.longHorizon.goalEpoch).toBe(0);
    state = apply(state, "long_horizon.updated", { state: longHorizon });
    expect(state.longHorizon.goalEpoch).toBe(1);

    const review = evidenceFixture("review");
    state = apply(state, "review.completed", review);
    expect(state.evidence).toContainEqual(review);
    const waiver = evidenceFixture("user_waiver");
    state = apply(state, "review.waived", waiver, "runtime");
    expect(state.evidence).not.toContainEqual(waiver);
    state = apply(state, "review.waived", waiver, "user");
    expect(state.evidence).toContainEqual(waiver);
  });

  it("ignores malformed compaction and process events while retaining restoration evidence", () => {
    let state = initial();
    state = apply(state, "context.compacted", {
      item: null,
      omittedHistoryTurns: 0
    });
    expect(state.contextArchive).toBeUndefined();
    state = apply(state, "process.exited", { processId: "process" }, "tool");
    expect(state.activeProcessIds).toEqual([]);
    const restoration = {
      evidenceId: "restoration",
      sessionId: "session",
      runId: "run",
      kind: "restoration" as const,
      status: "failed" as const,
      createdAt: NOW,
      producer: { authority: "runtime" as const },
      summary: "restoration was attempted",
      data: {
        schemaVersion: 1 as const,
        goalEpoch: 0,
        frontierRevision: 0,
        frontierStateDigest: "0".repeat(64),
        baselineManifestDigest: "0".repeat(64),
        currentManifestDigest: "0".repeat(64),
        restoredCheckpointIds: [],
        quiescence: {
          supersededExecutionStopped: true as const,
          noPendingMutations: true as const,
          noProcesses: true as const,
          noChildren: true as const,
          noOpenCheckpoint: true as const
        },
        repository: { status: "unchanged" as const }
      }
    };
    state = apply(state, "evidence.recorded", restoration);
    expect(state.evidence).toContainEqual(restoration);
    expect(state.mutationFrontier.revision).toBe(0);

    const passedRestoration = {
      ...restoration,
      evidenceId: "restoration-passed",
      status: "passed" as const,
      summary: "workspace restored"
    };
    const restored = apply(initial(), "evidence.recorded", passedRestoration);
    expect(restored.mutationFrontier).toMatchObject({
      revision: 1,
      baselineManifestDigest: "0".repeat(64),
      currentStateDigest: "0".repeat(64),
      changedPaths: []
    });

    const environmentMutated = initial();
    environmentMutated.mutationFrontier = {
      ...environmentMutated.mutationFrontier,
      environmentChangedPaths: ["/etc/runtime.conf"]
    };
    const retained = apply(environmentMutated, "evidence.recorded", passedRestoration);
    expect(retained.mutationFrontier).toEqual(environmentMutated.mutationFrontier);
  });
});
