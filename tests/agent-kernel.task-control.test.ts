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
  advanceReviewRepair,
  assertKernelInvariants,
  beginGoalEpoch,
  completionEvidenceObligation,
  completeActionBatch,
  createKernelState,
  createTaskControlState,
  evolve,
  hasPublishedTaskControlLegacyFields,
  isKernelState,
  isTaskControlStateV1,
  openTaskObligation,
  protectCompletionCandidate,
  recordSemanticFact,
  recordSemanticToolResult,
  recordToolPolicyViolation,
  resolveTaskObligation,
  reviewRepairObligation,
  startActionBatch,
  taskControlAnswer,
  taskControlFailureMessage,
  terminalResolutionObligation,
  userDecisionObligation,
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
  options: { failureKind?: "protocol"; basis?: string; omitBasis?: boolean; findings?: JsonValue[] } = {}
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
      findings: options.findings ?? (options.failureKind ? [] : verdict === "approved" ? [] : [{
        actionable: true,
        severity: "error",
        summary: "Repair the current frontier."
      }]),
      frontierRevision: state.mutationFrontier.revision,
      stateDigest: state.mutationFrontier.currentStateDigest,
      ...(options.omitBasis ? {} : { reviewBasisDigest: options.basis ?? DIGEST_A }),
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
      obligation: { kind: "terminal_resolution", failureCode: "action_convergence_no_progress" }
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

  it("classifies an exhausted review-scope correction as review repair failure", () => {
    const repair = reviewRepairObligation(
      createTaskControlState(),
      1,
      DIGEST_A,
      ["src/target.ts"]
    );
    const first = recordToolPolicyViolation(repair, "tool_unavailable_for_repair", 2);
    const second = recordToolPolicyViolation(first, "tool_unavailable_for_repair", 3);
    expect(second).toMatchObject({
      phase: "terminal",
      obligation: { kind: "terminal_resolution", failureCode: "review_repair_exhausted" }
    });
  });

  it("clears repair and convergence state when current-epoch restoration is accepted", () => {
    let state = workspaceDelta(initial());
    state = {
      ...state,
      taskControl: terminalResolutionObligation(state.taskControl, state.revision, "review_repair_exhausted")
    };
    const frontier = state.mutationFrontier;
    const evidence: EvidenceRecord = {
      evidenceId: "restoration-current-epoch",
      sessionId: state.sessionId,
      runId: state.runId,
      kind: "restoration",
      status: "passed",
      createdAt: NOW,
      producer: { authority: "runtime", id: "workspace-restoration-v1" },
      summary: "restored",
      data: {
        schemaVersion: 1,
        goalEpoch: state.taskControl.goalEpoch,
        frontierRevision: frontier.revision,
        frontierStateDigest: frontier.currentStateDigest,
        baselineManifestDigest: DIGEST_B,
        currentManifestDigest: DIGEST_B,
        restoredCheckpointIds: ["checkpoint-current-run"],
        quiescence: {
          supersededExecutionStopped: true,
          noPendingMutations: true,
          noProcesses: true,
          noChildren: true,
          noOpenCheckpoint: true
        },
        repository: { status: "unchanged" }
      }
    };
    state = apply(state, "evidence.recorded", evidence);
    expect(state.mutationFrontier.changedPaths).toEqual([]);
    expect(state.taskControl).toMatchObject({ phase: "normal", obligation: undefined });
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

  it("drives one managed dependency recovery from runtime-authenticated facts", () => {
    const observed = {
      kind: "runtime.dependency_observed",
      protocolVersion: 1,
      callId: "probe-1",
      toolName: "exec",
      requestedExecutable: "new-tool",
      failureCode: "executable_not_found",
      runtimeClosureDigest: "sha256:before",
      opportunityId: "opportunity-1",
      recoveryAvailable: true
    } as const;
    expect(apply(initial(), "diagnostic", observed, "tool").taskControl.obligation).toBeUndefined();

    let state = apply(initial(), "diagnostic", observed);
    expect(state.taskControl.obligation).toMatchObject({
      kind: "capability_recovery",
      stage: "prepare",
      requestedExecutable: "new-tool",
      probeToolName: "exec"
    });
    state = apply(state, "diagnostic", {
      kind: "runtime.dependency_prepared",
      protocolVersion: 1,
      callId: "prepare-1",
      requestedExecutable: "new-tool",
      opportunityId: "opportunity-1",
      previousRuntimeClosureDigest: "sha256:before",
      runtimeClosureDigest: "sha256:after"
    });
    expect(state.taskControl.obligation).toMatchObject({
      kind: "capability_recovery",
      stage: "re_probe",
      runtimeClosureDigest: "sha256:after"
    });
    state = apply(state, "diagnostic", {
      kind: "runtime.dependency_reprobed",
      protocolVersion: 1,
      callId: "probe-2",
      toolName: "exec",
      requestedExecutable: "new-tool",
      opportunityId: "opportunity-1",
      runtimeClosureDigest: "sha256:after",
      ok: true
    });
    expect(state.taskControl.phase).toBe("normal");
    expect(state.taskControl.obligation).toBeUndefined();
    expect(state.taskControl.semanticFacts.entries.filter((item) =>
      item.kind === "runtime_environment")).toHaveLength(3);
  });

  it("stabilizes a failed managed dependency re-probe as capability exhaustion", () => {
    let state = apply(initial(), "diagnostic", {
      kind: "runtime.dependency_observed",
      protocolVersion: 1,
      callId: "probe-1",
      toolName: "validate",
      requestedExecutable: "new-tool",
      failureCode: "executable_unavailable",
      runtimeClosureDigest: "sha256:before",
      opportunityId: "opportunity-2",
      recoveryAvailable: true
    });
    state = apply(state, "diagnostic", {
      kind: "runtime.dependency_prepared",
      protocolVersion: 1,
      callId: "prepare-1",
      requestedExecutable: "new-tool",
      opportunityId: "opportunity-2",
      previousRuntimeClosureDigest: "sha256:before",
      runtimeClosureDigest: "sha256:after"
    });
    state = apply(state, "diagnostic", {
      kind: "runtime.dependency_reprobed",
      protocolVersion: 1,
      callId: "probe-2",
      toolName: "validate",
      requestedExecutable: "new-tool",
      opportunityId: "opportunity-2",
      runtimeClosureDigest: "sha256:after",
      ok: false,
      failureCode: "executable_not_found"
    });
    expect(state.taskControl).toMatchObject({
      phase: "terminal",
      obligation: {
        kind: "terminal_resolution",
        failureCode: "capability_recovery_exhausted"
      }
    });
  });

  it("rejects new snapshots that carry any legacy task-control authority", () => {
    const state = initial();
    expect(isKernelState(state)).toBe(true);
    expect(isKernelState({ ...state, completionRepairAttempts: 0 })).toBe(false);
    expect(isKernelState({ ...state, semanticFailureCluster: { attempts: 1 } })).toBe(false);
  });

  it("validates every obligation family and rejects malformed durable control state", () => {
    const base = createTaskControlState(3, 2);
    const header = { basisDigest: DIGEST_A, openedRevision: 3, attempts: 0 };
    const obligations = [
      { ...header, kind: "completion_evidence", stage: "acquire", evidenceCount: 0 },
      { ...header, kind: "completion_evidence", stage: "terminal", evidenceCount: 1, failureCode: "blocked" },
      { ...header, kind: "review_repair", stage: "mutate", scopePaths: ["src/index.ts"] },
      {
        ...header,
        kind: "capability_recovery",
        stage: "prepare",
        opportunityId: "opportunity",
        requestedExecutable: "tool",
        probeToolName: "exec",
        runtimeClosureDigest: DIGEST_A
      },
      { ...header, kind: "repository_recovery", stage: "select" },
      { ...header, kind: "restoration", stage: "confirm" },
      { ...header, kind: "process_settlement", stage: "settle", processIds: ["process"] },
      { ...header, kind: "user_decision", stage: "request", decisionCode: "choose" },
      { ...header, kind: "terminal_resolution", stage: "report", failureCode: "blocked" }
    ];
    for (const obligation of obligations) {
      expect(isTaskControlStateV1({ ...base, obligation })).toBe(true);
    }

    expect(isTaskControlStateV1(null)).toBe(false);
    expect(isTaskControlStateV1({ ...base, obligation: [] })).toBe(false);
    expect(isTaskControlStateV1({ ...base, obligation: { ...header, kind: "unknown", stage: "none" } })).toBe(false);
    expect(isTaskControlStateV1({
      ...base,
      obligation: { ...header, kind: "completion_evidence", stage: "acquire", evidenceCount: 0, failureCode: "" }
    })).toBe(false);
    expect(isTaskControlStateV1({ ...base, semanticFacts: { entries: [{ kind: "content" }] } })).toBe(false);
    expect(isTaskControlStateV1({
      ...base,
      semanticFacts: { entries: [
        { kind: "content", digest: DIGEST_A, revision: 1 },
        { kind: "content", digest: DIGEST_A, revision: 2 }
      ] }
    })).toBe(false);
    expect(isTaskControlStateV1({
      ...base,
      policyCorrection: { basisDigest: DIGEST_A, attempts: -1, failureCode: "blocked" }
    })).toBe(false);
    expect(isTaskControlStateV1({
      ...base,
      policyCorrection: { basisDigest: DIGEST_A, attempts: 1, failureCode: 1 }
    })).toBe(false);
    expect(isTaskControlStateV1({
      ...base,
      completionCandidate: { answer: " ", digest: DIGEST_A }
    })).toBe(false);
  });

  it("covers task-control helper boundaries without creating a second authority", () => {
    const base = createTaskControlState(1, 2);
    expect(protectCompletionCandidate(base, "   ")).toBe(base);
    expect(taskControlAnswer(base)).toBeNull();
    const protectedControl = protectCompletionCandidate(base, " final answer ");
    expect(taskControlAnswer(protectedControl)).toBe("final answer");
    const nextEpoch = beginGoalEpoch(protectedControl, 4, "steer");
    expect(nextEpoch).toMatchObject({
      goalEpoch: 3,
      goalEpochSource: "steer"
    });
    expect(taskControlAnswer(nextEpoch)).toBeNull();

    const reviewControl = reviewRepairObligation(base, 2, DIGEST_A, ["b.ts", "a.ts", "b.ts"]);
    expect(reviewControl.obligation).toMatchObject({ scopePaths: ["a.ts", "b.ts"] });
    expect(advanceReviewRepair(base, "validate", 3)).toBe(base);
    expect(advanceReviewRepair(reviewControl, "validate", 3)).toMatchObject({
      obligation: { kind: "review_repair", stage: "validate", attempts: 1 }
    });

    const decision = userDecisionObligation(base, 2, "select_candidate");
    expect(decision.phase).toBe("terminal");
    expect(resolveTaskObligation(decision)).toMatchObject({ phase: "normal", obligation: undefined });
    expect(terminalResolutionObligation(base, 2, "validation_failed")).toMatchObject({
      phase: "terminal",
      obligation: { failureCode: "validation_failed" }
    });
    expect(openTaskObligation(base, {
      kind: "restoration",
      stage: "restore",
      basisDigest: DIGEST_A,
      openedRevision: 2,
      attempts: 0
    }).phase).toBe("repair_only");

    expect(completeActionBatch(base, 2)).toBe(base);
    const started = startActionBatch(reviewControl);
    const withFact = recordSemanticFact(started, "review", { verdict: "approved" }, 3).control;
    expect(completeActionBatch(withFact, 4)).toMatchObject({
      phase: "repair_only",
      episode: { noProgressBatches: 0, factCountAtBatchStart: undefined }
    });
    const alreadyTerminal = terminalResolutionObligation(base, 1, "validation_failed");
    let exhausted = alreadyTerminal;
    for (let revision = 2; revision <= 8; revision += 1) exhausted = noProgress(exhausted, revision);
    expect(exhausted.obligation).toMatchObject({ failureCode: "validation_failed" });

    expect(taskControlFailureMessage(base, "detail")).toBe("detail");
    expect(taskControlFailureMessage(protectedControl, "detail")).toContain("final answer");
    expect(taskControlFailureMessage(protectedControl, "final answer already included")).toBe(
      "final answer already included"
    );
    expect(hasPublishedTaskControlLegacyFields([])).toBe(false);
    expect(hasPublishedTaskControlLegacyFields({ continuationAttempts: 1 })).toBe(true);

    const fallbackBasis = review(initial(), "fallback-basis", "changes_requested", { omitBasis: true });
    expect(fallbackBasis.taskControl.obligation).toMatchObject({
      kind: "review_repair",
      basisDigest: fallbackBasis.mutationFrontier.currentStateDigest
    });
    const advisoryOnly = review(initial(), "advisory", "changes_requested", {
      findings: [{ actionable: false, severity: "warning", summary: "Optional." }]
    });
    expect(advisoryOnly.taskControl.obligation).toBeUndefined();
  });
});
