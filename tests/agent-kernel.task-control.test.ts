import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  type AgentEventEnvelope,
  type AgentEventType,
  type EvidenceRecord,
  type JsonValue,
  type ToolReceipt
} from "../packages/agent-protocol/src/index.js";
import {
  assertKernelInvariants,
  completionEvidenceObligation,
  completeActionBatch,
  createKernelState,
  createTaskControlState,
  evolve,
  isKernelState,
  recordSemanticFact,
  recordSemanticToolResult,
  recordToolPolicyViolation,
  startActionBatch,
  type KernelState,
  type TaskControlStateV1
} from "../packages/agent-kernel/src/index.js";

const NOW = "2026-07-22T00:00:00.000Z";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function initial(): KernelState {
  return createKernelState({
    sessionId: "task-control-session",
    runId: "task-control-run",
    mode: "change",
    startedAt: NOW,
    deadlineAt: "2026-07-22T01:00:00.000Z"
  });
}

function noProgress(control: TaskControlStateV1, revision: number): TaskControlStateV1 {
  return completeActionBatch(startActionBatch(control), revision);
}

function envelope(
  state: KernelState,
  type: AgentEventType,
  payload: JsonValue,
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
  payload: JsonValue,
  authority?: AgentEventEnvelope["authority"]
): KernelState {
  return evolve(state, envelope(state, type, payload, authority));
}

function review(
  state: KernelState,
  id: string,
  verdict: "approved" | "changes_requested",
  options: { failureKind?: "protocol"; basis?: string } = {}
): KernelState {
  const evidence: EvidenceRecord = {
    evidenceId: id,
    sessionId: state.sessionId,
    runId: state.runId,
    kind: "review",
    status: verdict === "approved" ? "passed" : "failed",
    createdAt: NOW,
    producer: { authority: "runtime", id: "reviewer" },
    summary: verdict,
    data: {
      reviewerId: "reviewer",
      verdict,
      findings: options.failureKind ? [] : verdict === "approved" ? [] : [{
        actionable: true,
        severity: "error",
        summary: "Repair the current frontier."
      }],
      frontierRevision: state.mutationFrontier.revision,
      stateDigest: state.mutationFrontier.currentStateDigest,
      reviewBasisDigest: options.basis ?? DIGEST_A,
      validationEvidenceIds: [],
      ...(options.failureKind
        ? { failureKind: options.failureKind, failureCode: "review_protocol_invalid" }
        : {})
    }
  };
  return apply(state, "review.completed", evidence);
}

function workspaceDelta(state: KernelState): KernelState {
  const evidence: EvidenceRecord = {
    evidenceId: `delta-${state.revision}`,
    sessionId: state.sessionId,
    runId: state.runId,
    kind: "workspace_delta",
    status: "passed",
    createdAt: NOW,
    producer: { authority: "runtime" },
    summary: "repair delta",
    data: {
      checkpointId: `checkpoint-${state.revision}`,
      delta: { added: [], modified: ["src/index.ts"], deleted: [] },
      reviewDiff: "diff --git a/src/index.ts b/src/index.ts\n",
      reviewDiffPaths: ["src/index.ts"]
    }
  };
  return apply(state, "evidence.recorded", evidence);
}

function validation(state: KernelState, status: "passed" | "failed"): KernelState {
  const evidence: EvidenceRecord = {
    evidenceId: `validation-${status}-${state.revision}`,
    sessionId: state.sessionId,
    runId: state.runId,
    kind: "validation",
    status,
    createdAt: NOW,
    producer: { authority: "runtime" },
    summary: `validation ${status}`,
    data: {
      validator: "command",
      command: "pnpm test",
      exitCode: status === "passed" ? 0 : 1,
      termination: {
        processStarted: true,
        state: "exited",
        exitCode: status === "passed" ? 0 : 1,
        signal: null,
        timedOut: false,
        idleTimedOut: false,
        cancelled: false
      },
      artifactIds: [],
      frontierRevision: state.mutationFrontier.revision,
      stateDigest: state.mutationFrontier.currentStateDigest,
      coveredPaths: ["src/index.ts"]
    }
  };
  return apply(state, "evidence.recorded", evidence);
}

function receipt(output: string): ToolReceipt {
  return {
    callId: "exec-call",
    ok: true,
    output,
    outcome: { status: "succeeded", output, diagnosticCodes: [] },
    observedEffects: ["process.spawn.readonly"],
    artifacts: [],
    diagnostics: [],
    startedAt: NOW,
    completedAt: NOW
  };
}

describe("TaskControlStateV1", () => {
  it("moves monotonically through focused and repair-only to terminal in seven no-progress batches", () => {
    let control = createTaskControlState();
    const phases: string[] = [];
    for (let revision = 1; revision <= 7; revision += 1) {
      control = noProgress(control, revision);
      phases.push(control.phase);
    }
    expect(phases).toEqual([
      "normal", "focused", "focused", "focused", "focused", "repair_only", "terminal"
    ]);
    expect(control.obligation).toMatchObject({
      kind: "terminal_resolution",
      failureCode: "action_convergence_no_progress"
    });
  });

  it("resets an episode only for a new runtime fact and not for a duplicate fact", () => {
    const control = noProgress(noProgress(createTaskControlState(), 1), 2);
    expect(control.phase).toBe("focused");
    const first = recordSemanticFact(control, "content", { path: "README.md", digest: DIGEST_A }, 3);
    expect(first.trustedProgress).toBe(true);
    expect(first.control).toMatchObject({ phase: "normal", episode: { noProgressBatches: 0 } });
    const duplicate = recordSemanticFact(first.control, "content", { path: "README.md", digest: DIGEST_A }, 4);
    expect(duplicate.trustedProgress).toBe(false);
    expect(duplicate.control).toBe(first.control);
  });

  it("does not treat argv or stdout variants from process tools as progress", () => {
    fc.assert(fc.property(fc.string(), fc.string(), (left, right) => {
      const state = initial();
      const first = recordSemanticToolResult(state, receipt(left), "exec").state;
      const second = recordSemanticToolResult(first, { ...receipt(right), callId: "other-call" }, "shell").state;
      expect(second.taskControl.semanticFacts.entries).toEqual([]);
    }));
  });

  it("allows one policy correction per episode regardless of call or error variation", () => {
    const first = recordToolPolicyViolation(createTaskControlState(), "unknown_tool", 1);
    expect(first).toMatchObject({ phase: "focused", policyCorrection: { attempts: 1 } });
    const second = recordToolPolicyViolation(first, "tool_unavailable_for_repair", 2);
    expect(second).toMatchObject({
      phase: "terminal",
      obligation: { kind: "terminal_resolution", failureCode: "tool_unavailable_for_repair" }
    });
  });

  it("preserves the unresolved completion prerequisite when correction is exhausted", () => {
    const evidenceRequired = completionEvidenceObligation(
      createTaskControlState(),
      1,
      "acquire",
      0,
      { failureCode: "validation_evidence_required" }
    );
    const first = recordToolPolicyViolation(evidenceRequired, "unknown_tool", 2);
    const second = recordToolPolicyViolation(first, "model_tool_policy_violation", 3);
    expect(second).toMatchObject({
      phase: "terminal",
      obligation: { kind: "terminal_resolution", failureCode: "validation_evidence_required" }
    });
  });

  it("runs one review repair cycle and resolves only after validation and approval", () => {
    let state = review(initial(), "review-one", "changes_requested");
    expect(state.taskControl.obligation).toMatchObject({ kind: "review_repair", stage: "mutate" });
    state = workspaceDelta(state);
    expect(state.taskControl.obligation).toMatchObject({ kind: "review_repair", stage: "validate" });
    state = validation(state, "passed");
    expect(state.taskControl.obligation).toMatchObject({ kind: "review_repair", stage: "re_review" });
    state = review(state, "review-two", "approved", { basis: DIGEST_B });
    expect(state.taskControl).toMatchObject({ phase: "normal", obligation: undefined });
    assertKernelInvariants(state);
  });

  it("exhausts repair after failed validation, a no-delta mutation, or a second rejection", () => {
    let failedValidation = workspaceDelta(review(initial(), "review-a", "changes_requested"));
    failedValidation = validation(failedValidation, "failed");
    expect(failedValidation.taskControl.obligation).toMatchObject({
      kind: "terminal_resolution", failureCode: "validation_failed"
    });

    let noDelta = review(initial(), "review-b", "changes_requested");
    noDelta = apply(noDelta, "diagnostic", {
      kind: "tool.batch_settled",
      callId: "repair-call",
      ok: true,
      evidenceIds: [],
      diagnosticCodes: []
    });
    expect(noDelta.taskControl.obligation).toMatchObject({
      kind: "terminal_resolution", failureCode: "review_repair_no_delta"
    });

    let rejected = workspaceDelta(review(initial(), "review-c", "changes_requested"));
    rejected = validation(rejected, "passed");
    rejected = review(rejected, "review-d", "changes_requested", { basis: DIGEST_B });
    expect(rejected.taskControl.obligation).toMatchObject({
      kind: "terminal_resolution", failureCode: "review_repair_exhausted"
    });
  });

  it("classifies two malformed re-reviews as review unavailable", () => {
    let state = workspaceDelta(review(initial(), "review-one", "changes_requested"));
    state = validation(state, "passed");
    state = review(state, "protocol-one", "changes_requested", { failureKind: "protocol", basis: DIGEST_B });
    expect(state.taskControl.obligation).toMatchObject({ kind: "review_repair", stage: "re_review" });
    state = review(state, "protocol-two", "changes_requested", { failureKind: "protocol", basis: DIGEST_B });
    expect(state.taskControl.obligation).toMatchObject({
      kind: "terminal_resolution", failureCode: "review_unavailable"
    });
  });

  it("rejects new snapshots that carry any legacy task-control authority", () => {
    const state = initial();
    expect(isKernelState(state)).toBe(true);
    expect(isKernelState({ ...state, completionRepairAttempts: 0 })).toBe(false);
    expect(isKernelState({ ...state, semanticFailureCluster: { attempts: 1 } })).toBe(false);
  });
});
