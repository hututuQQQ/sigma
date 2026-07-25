import { describe, expect, it } from "vitest";
import type {
  CheckpointRef,
  EvidenceRecord,
  JsonValue,
  ModelToolCall,
  ToolReceipt
} from "../packages/agent-protocol/src/index.js";
import {
  createKernelState,
  decide,
  emptyMutationFrontier,
  frontierAfterCheckpoint,
  frontierAfterEvidence,
  isStaleEffect,
  mutationFrontierHasChanges,
  netChangedPaths,
  type KernelState,
  type PendingTool
} from "../packages/agent-kernel/src/index.js";
import {
  isCurrentModelTurn,
  modelMessage,
  modelToolCalls,
  modelTurn
} from "../packages/agent-kernel/src/model-event-parsing.js";
import {
  receiptContent,
  toolReceipt
} from "../packages/agent-kernel/src/receipt-parsing.js";
import {
  acceptsOutcomeRevision,
  isRecoverySuspension,
  nextPhase,
  objectPayload,
  pendingForEvent,
  pendingFromCalls,
  supersededToolMessages,
  terminalOutcome,
  text,
  withDuplicateActionAdvisory
} from "../packages/agent-kernel/src/reducer-helpers.js";
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

function pending(
  callId = "call",
  name = "read",
  args: JsonValue = {}
): PendingTool {
  return {
    request: { callId, name, arguments: args },
    modelTurn: { turnId: 1, effectRevision: 0 },
    approval: "not_required",
    started: false
  };
}

function receipt(
  callId = "call",
  effects: ToolReceipt["observedEffects"] = [],
  ok = true
): ToolReceipt {
  return {
    callId,
    ok,
    output: "output",
    outcome: {
      status: ok ? "succeeded" : "failed",
      output: "output",
      diagnosticCodes: []
    },
    observedEffects: effects,
    actualEffects: effects,
    artifacts: [],
    diagnostics: [],
    evidence: [],
    startedAt: NOW,
    completedAt: NOW
  };
}

function deltaEvidence(
  checkpointId: string,
  delta: { added: string[]; modified: string[]; deleted: string[] },
  status: "passed" | "failed" = "passed"
): EvidenceRecord {
  return {
    evidenceId: `delta-${checkpointId}-${status}`,
    sessionId: "session",
    runId: "run",
    kind: "workspace_delta",
    status,
    createdAt: NOW,
    producer: { authority: "runtime" },
    summary: "delta",
    data: { checkpointId, delta }
  };
}

function checkpoint(
  checkpointId: string,
  status: CheckpointRef["status"],
  delta?: CheckpointRef["delta"]
): CheckpointRef {
  return {
    checkpointId,
    sessionId: "session",
    runId: "run",
    status,
    createdAt: NOW,
    preManifestDigest: "a".repeat(64),
    ...(status !== "open" ? {
      postManifestDigest: "b".repeat(64),
      ...(status === "sealed" ? { sealedAt: NOW } : { restoredAt: NOW })
    } : {}),
    ...(delta ? { delta } : {})
  };
}

describe("agent-kernel boundary branch contracts", () => {
  it("parses model calls, messages, and turn identities fail-closed", () => {
    expect(modelToolCalls(undefined)).toEqual([]);
    expect(modelToolCalls({})).toEqual([]);
    expect(modelToolCalls([null, [], {}, { id: 1, name: "read" }])).toEqual([]);
    expect(modelToolCalls([{ id: "call", name: "read" }])).toEqual([
      { id: "call", name: "read", arguments: null }
    ]);
    expect(modelToolCalls([{ id: "call", name: "read", arguments: { path: "a" } }]))
      .toEqual([{ id: "call", name: "read", arguments: { path: "a" } }]);
    expect(modelMessage(undefined)).toBeNull();
    expect(modelMessage([])).toBeNull();
    expect(modelMessage({ role: "invalid", content: "x" })).toBeNull();
    expect(modelMessage({
      role: "assistant",
      content: 1,
      reasoningContent: "reason",
      toolCallId: "result",
      toolCalls: [{ id: "call", name: "read" }]
    })).toEqual({
      role: "assistant",
      content: "",
      reasoningContent: "reason",
      toolCallId: "result",
      toolCalls: [{ id: "call", name: "read", arguments: null }]
    });
    expect(modelTurn({})).toBeNull();
    expect(modelTurn({ turnId: 1, effectRevision: 0 })).toEqual({ turnId: 1, effectRevision: 0 });
    const state = initial();
    expect(isCurrentModelTurn(state, { turnId: 1, effectRevision: 0 })).toBe(false);
    const active = { ...state, activeModelTurn: { turnId: 1, effectRevision: 0 } };
    expect(isCurrentModelTurn(active, {})).toBe(false);
    expect(isCurrentModelTurn(active, { turnId: 2, effectRevision: 0 })).toBe(false);
    expect(isCurrentModelTurn(active, { turnId: 1, effectRevision: 2 })).toBe(false);
    expect(isCurrentModelTurn(active, { turnId: 1, effectRevision: 0 })).toBe(true);
  });

  it("normalizes complete and malformed durable tool receipts", () => {
    expect(toolReceipt(null)).toBeNull();
    expect(toolReceipt([])).toBeNull();
    expect(toolReceipt({ ok: true })).toBeNull();
    expect(toolReceipt({ callId: "call" })).toBeNull();
    const malformed = toolReceipt({
      callId: "call",
      ok: true,
      output: 1,
      result: undefined,
      outcome: { status: "unknown", output: 1, diagnosticCodes: "bad" },
      observedEffects: ["filesystem.read", 1],
      actualEffects: "bad",
      workspaceDelta: { added: ["a"], modified: [1], deleted: [] },
      artifacts: "bad",
      artifactRefs: [null, [], {}, { artifactId: "a", name: 1, digest: "d" }],
      diagnostics: [1],
      evidence: [{}],
      startedAt: 1,
      completedAt: null
    });
    expect(malformed).toMatchObject({
      callId: "call",
      output: "",
      observedEffects: ["filesystem.read"],
      artifacts: [],
      diagnostics: [],
      evidence: [],
      startedAt: "",
      completedAt: ""
    });
    expect(malformed).not.toHaveProperty("outcome");
    expect(malformed).not.toHaveProperty("workspaceDelta");
    const parsed = toolReceipt({
      callId: "call",
      ok: false,
      output: "failed",
      result: { nested: true },
      outcome: { status: "failed", output: "failed", diagnosticCodes: ["x", 2] },
      observedEffects: ["filesystem.write"],
      actualEffects: ["filesystem.write"],
      workspaceDelta: { added: ["a"], modified: ["b"], deleted: ["c"] },
      artifacts: ["artifact", 1],
      artifactRefs: [{
        artifactId: "artifact",
        name: "log",
        digest: "d".repeat(64),
        mediaType: "text/plain",
        sizeBytes: 4
      }],
      diagnostics: ["x", 1],
      evidence: [evidenceFixture(), {}],
      startedAt: NOW,
      completedAt: NOW
    });
    expect(parsed).toMatchObject({
      ok: false,
      actualEffects: ["filesystem.write"],
      workspaceDelta: { added: ["a"], modified: ["b"], deleted: ["c"] },
      artifacts: ["artifact"],
      artifactRefs: [{ mediaType: "text/plain", sizeBytes: 4 }],
      evidence: [expect.objectContaining({ evidenceId: "evidence-diagnostic" })]
    });
  });

  it("bounds receipt projections and includes only populated summary fields", () => {
    const legacy = {
      ...receipt(),
      outcome: undefined,
      output: "x".repeat(13_000),
      artifactRefs: [{
        artifactId: "artifact",
        name: "log",
        digest: "d".repeat(64)
      }]
    };
    expect(receiptContent(legacy)).toContain("receipt output omitted");
    expect(receiptContent(legacy)).toContain("Artifacts (JSON)");
    const rich = {
      ...receipt("rich", ["filesystem.write"]),
      output: "ok",
      result: "r".repeat(13_000),
      workspaceDelta: { added: ["a"], modified: [], deleted: [] },
      artifacts: ["artifact"],
      artifactRefs: [{
        artifactId: "artifact",
        name: "log",
        digest: "d".repeat(64),
        mediaType: "text/plain",
        sizeBytes: 2
      }],
      diagnostics: ["same", "same"],
      evidence: [evidenceFixture()]
    };
    const content = receiptContent(rich);
    expect(content).toContain("Receipt summary (JSON)");
    expect(content).toContain("workspaceDelta");
    expect(content).toContain("artifactRefs");
    expect(receiptContent(receipt("minimal"))).not.toContain("workspaceDelta");
  });

  it("projects pending tools and optimistic outcome revisions", () => {
    const state = {
      ...initial(),
      pendingTools: [pending()],
      toolCallIds: ["call"]
    };
    expect(objectPayload(null)).toEqual({});
    expect(objectPayload([])).toEqual({});
    expect(objectPayload({ value: 1 })).toEqual({ value: 1 });
    expect(text(1)).toBe("");
    expect(text("value")).toBe("value");
    expect(nextPhase([{ ...pending(), approval: "pending" }])).toBe("needs_input");
    expect(nextPhase([{ ...pending(), started: true }])).toBe("tool_in_flight");
    expect(nextPhase([pending()])).toBe("tool_pending");
    expect(nextPhase([])).toBe("ready_model");
    expect(pendingForEvent(state, {})).toBeUndefined();
    expect(pendingForEvent(state, { turnId: 1, effectRevision: 0 })).toBeUndefined();
    expect(pendingForEvent(state, {
      callId: "other", turnId: 1, effectRevision: 0
    })).toBeUndefined();
    expect(pendingForEvent(state, {
      callId: "call", turnId: 1, effectRevision: 0
    })).toBe(state.pendingTools[0]);
    expect(acceptsOutcomeRevision(state, {})).toBe(true);
    expect(acceptsOutcomeRevision(state, { outcomeRevision: 0.5 })).toBe(false);
    expect(acceptsOutcomeRevision(state, { outcomeRevision: -1 })).toBe(false);
    const proposed = { ...state, phase: "outcome_pending" as const, revision: 2 };
    expect(acceptsOutcomeRevision(proposed, { outcomeRevision: 1 })).toBe(true);
  });

  it("recognizes only complete recovery suspension shapes", () => {
    const state = initial();
    expect(isRecoverySuspension(state, {
      checkpointId: "checkpoint", choices: ["restore", "keep"]
    })).toBe(true);
    expect(isRecoverySuspension(state, {
      checkpointId: "checkpoint", choices: ["keep", "restore"]
    })).toBe(false);
    expect(isRecoverySuspension(state, { processIds: ["one", "two"] })).toBe(true);
    expect(isRecoverySuspension(state, { processIds: [] })).toBe(false);
    expect(isRecoverySuspension(state, { processIds: ["one", ""] })).toBe(false);
    const active = {
      ...state,
      phase: "model_in_flight" as const,
      activeModelTurn: { turnId: 1, effectRevision: 0 }
    };
    expect(isRecoverySuspension(active, { turnId: 1, effectRevision: 0 })).toBe(true);
    expect(isRecoverySuspension(state, { turnId: 1, effectRevision: 0 })).toBe(false);
  });

  it("builds supersession receipts and emits one duplicate-call advisory", () => {
    const state = { ...initial(), pendingTools: [pending("one"), pending("two")] };
    expect(supersededToolMessages(state)).toHaveLength(2);
    const calls: ModelToolCall[] = [
      { id: "one", name: "read", arguments: { path: "a", line: 1 } },
      { id: "two", name: "read", arguments: { line: 1, path: "a" } }
    ];
    expect(pendingFromCalls(calls, { turnId: 2, effectRevision: 3 })).toHaveLength(2);
    const message = (call: ModelToolCall) => ({
      role: "assistant" as const, content: "", toolCalls: [call]
    });
    expect(withDuplicateActionAdvisory([message(calls[0]!), message(calls[1]!)]))
      .toHaveLength(2);
    const three = [
      message({ ...calls[0]!, id: "a" }),
      message({ ...calls[0]!, id: "b" }),
      message({ ...calls[0]!, id: "c" })
    ];
    expect(withDuplicateActionAdvisory(three).at(-1)?.role).toBe("developer");
    expect(withDuplicateActionAdvisory([
      message({ ...calls[0]!, id: "a" }),
      message({ ...calls[0]!, id: "b" }),
      message({ id: "different", name: "read", arguments: { path: "b" } })
    ])).toHaveLength(3);
    expect(withDuplicateActionAdvisory([
      message({ ...calls[0]!, id: "a" }),
      message({ ...calls[0]!, id: "b" }),
      message({ ...calls[0]!, id: "c" }),
      message({ ...calls[0]!, id: "d" })
    ])).toHaveLength(4);
  });

  it("derives terminal tool outcomes only from one successful typed call", () => {
    const input = pending("input", "request_user_input", { message: " Choose. " });
    expect(terminalOutcome(input, receipt("input", ["outcome.request_input"], false), [{
      id: "input", name: "request_user_input", arguments: {}
    }])).toBeNull();
    expect(terminalOutcome(input, receipt("input", ["outcome.request_input"]), [
      { id: "input", name: "request_user_input", arguments: {} },
      { id: "other", name: "read", arguments: {} }
    ])).toBeNull();
    expect(terminalOutcome({ ...input, request: { ...input.request, arguments: null } },
      receipt("input", ["outcome.request_input"]), [{
        id: "input", name: "request_user_input", arguments: {}
      }])).toBeNull();
    expect(terminalOutcome(input, receipt("input"), [{
      id: "input", name: "request_user_input", arguments: {}
    }])).toBeNull();
    expect(terminalOutcome(input, receipt("input", ["outcome.request_input"]), [{
      id: "input", name: "request_user_input", arguments: {}
    }])).toEqual({ kind: "needs_input", requestId: "input", message: "Choose." });
    const blocked = pending("blocked", "report_blocked", {
      code: "missing",
      summary: "Cannot continue.",
      recoveryAttempted: "Checked inputs."
    });
    expect(terminalOutcome(blocked, receipt("blocked", ["outcome.report_blocked"]), [{
      id: "blocked", name: "report_blocked", arguments: {}
    }])).toMatchObject({
      kind: "recoverable_failure",
      failureKind: "blocked",
      failureCode: "missing",
      message: "Cannot continue.\nRecovery attempted: Checked inputs."
    });
    expect(terminalOutcome({
      ...blocked, request: { ...blocked.request, arguments: { code: "", summary: "" } }
    }, receipt("blocked", ["outcome.report_blocked"]), [{
      id: "blocked", name: "report_blocked", arguments: {}
    }])).toBeNull();
    expect(terminalOutcome(pending("read"), receipt("read"), [{
      id: "read", name: "read", arguments: {}
    }])).toBeNull();
  });

  it("decides every kernel phase without executing denied or unsettled tools", () => {
    const state = initial();
    expect(decide({ ...state, phase: "terminal" })).toEqual([]);
    expect(decide({
      ...state,
      phase: "outcome_pending",
      proposedOutcome: { kind: "completed", message: "done", evidence: [] }
    })).toEqual([expect.objectContaining({ type: "finish_run" })]);
    expect(decide({ ...state, phase: "outcome_pending" })).toEqual([]);
    const tools = [
      { ...pending("started"), started: true },
      { ...pending("denied"), approval: "denied" as const },
      { ...pending("waiting"), approval: "pending" as const },
      pending("automatic"),
      { ...pending("allowed"), approval: "allowed" as const }
    ];
    const effects = decide({ ...state, phase: "tool_pending", pendingTools: tools });
    expect(effects.map((effect) => effect.type)).toEqual(["execute_tool", "execute_tool"]);
    expect(isStaleEffect({ ...state, phase: "terminal" }, {
      type: "publish_outcome", revision: state.revision
    })).toBe(true);
  });

  it("collapses sequential workspace deltas conservatively", () => {
    const evidence = [
      deltaEvidence("one", {
        added: ["added-then-deleted", "added-stays"],
        modified: ["modified-then-added"],
        deleted: ["deleted-then-added", "deleted-stays"]
      }),
      deltaEvidence("failed", { added: ["ignored"], modified: [], deleted: [] }, "failed"),
      evidenceFixture(),
      deltaEvidence("two", {
        added: ["deleted-then-added", "modified-then-added"],
        modified: ["added-stays", "plain-modified"],
        deleted: ["added-then-deleted"]
      })
    ];
    expect(netChangedPaths(evidence)).toEqual([
      "added-stays",
      "deleted-stays",
      "deleted-then-added",
      "modified-then-added",
      "plain-modified"
    ]);
  });

  it("advances checkpoints and every evidence frontier kind", () => {
    const empty = emptyMutationFrontier();
    const emptyDelta = { added: [], modified: [], deleted: [] };
    const unchanged = {
      ...checkpoint("empty", "sealed", emptyDelta),
      postManifestDigest: "a".repeat(64)
    };
    expect(frontierAfterCheckpoint(empty, unchanged, [])).toBe(empty);
    expect(() => frontierAfterCheckpoint(
      empty, checkpoint("corrupt", "sealed", emptyDelta), []
    )).toThrow("empty delta");
    const sealedEvidence = deltaEvidence("sealed", {
      added: ["a.ts"], modified: [], deleted: []
    });
    const sealed = frontierAfterCheckpoint(
      empty,
      checkpoint("sealed", "sealed", sealedEvidence.data.delta),
      [sealedEvidence]
    );
    expect(sealed).toMatchObject({
      revision: 1,
      baselineManifestDigest: "a".repeat(64),
      changedPaths: ["a.ts"],
      sourceCheckpointIds: ["sealed"]
    });
    const withRepository = { ...sealed, repositoryStateDigest: "r".repeat(64) };
    const opened = frontierAfterCheckpoint(
      withRepository, checkpoint("open", "open"), [sealedEvidence]
    );
    expect(opened.changedPaths).toContain(".git");
    const restored = frontierAfterCheckpoint(
      opened, checkpoint("sealed", "restored"), [sealedEvidence]
    );
    expect(restored.sourceCheckpointIds).not.toContain("sealed");

    const childCheckpoint: EvidenceRecord = {
      evidenceId: "child-checkpoint",
      sessionId: "session",
      runId: "run",
      kind: "checkpoint",
      status: "passed",
      createdAt: NOW,
      producer: { authority: "runtime" },
      summary: "child",
      data: {
        checkpointId: "child",
        sourceSessionId: "child-session",
        preManifestDigest: "c".repeat(64)
      }
    };
    const child = frontierAfterEvidence(empty, [], childCheckpoint);
    expect(child).toMatchObject({ revision: 1, sourceCheckpointIds: ["child"] });
    expect(frontierAfterEvidence(child, [], {
      ...childCheckpoint,
      evidenceId: "child-two",
      data: { ...childCheckpoint.data, checkpointId: "child-two", postManifestDigest: "d".repeat(64) }
    }).baselineManifestDigest).toBe(child.baselineManifestDigest);
    expect(frontierAfterEvidence(sealed, [sealedEvidence], sealedEvidence).changedPaths)
      .toEqual(["a.ts"]);
    expect(frontierAfterEvidence(sealed, [], evidenceFixture())).toBe(sealed);
    const environmentMutation: EvidenceRecord = {
      evidenceId: "environment",
      sessionId: "session",
      runId: "run",
      kind: "diagnostic",
      status: "passed",
      createdAt: NOW,
      producer: { authority: "tool", id: "external-write" },
      summary: "environment changed",
      data: {
        source: "enclosing_container_mutation",
        diagnostic: {
          schemaVersion: 1,
          scope: "enclosing_container",
          callId: "external-write",
          declaredPaths: ["/etc/example.conf"],
          resultDigest: "1".repeat(64),
          ok: true,
          effects: ["filesystem.write"]
        }
      }
    };
    const environment = frontierAfterEvidence(sealed, [], environmentMutation);
    expect(environment).toMatchObject({
      revision: sealed.revision + 1,
      changedPaths: sealed.changedPaths,
      environmentChangedPaths: ["/etc/example.conf"]
    });
    expect(mutationFrontierHasChanges(environment)).toBe(true);
    const repository: EvidenceRecord = {
      evidenceId: "repository",
      sessionId: "session",
      runId: "run",
      kind: "repository_delta",
      status: "passed",
      createdAt: NOW,
      producer: { authority: "runtime" },
      summary: "git changed",
      data: {
        beforeStateDigest: "e".repeat(64),
        afterStateDigest: "f".repeat(64),
        worktreeDelta: { added: ["new.ts"], modified: ["a.ts"], deleted: ["old.ts"] }
      }
    };
    const repositoryFrontier = frontierAfterEvidence(sealed, [], repository);
    expect(repositoryFrontier.changedPaths).toEqual([".git", "a.ts", "new.ts", "old.ts"]);
    expect(frontierAfterEvidence(repositoryFrontier, [], {
      ...repository,
      evidenceId: "repository-no-worktree",
      data: { beforeStateDigest: "f".repeat(64), afterStateDigest: "1".repeat(64) }
    }).changedPaths).toContain(".git");
  });
});
