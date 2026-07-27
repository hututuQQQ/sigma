import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EvidenceRecord, ReviewEvidence } from "../packages/agent-protocol/src/index.js";
import {
  completionReviewBlocker,
  completionGateDecision,
  explicitReviewGateDecision
} from "../packages/agent-runtime/src/completion-evidence-gate.js";
import {
  currentFrontierReview,
  reviewBasisDigest
} from "../packages/agent-runtime/src/mutation-evidence.js";
import {
  postReviewReceiptSummaries
} from "../packages/agent-runtime/src/reviewer-post-repair-receipts.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

const NOW = "2026-07-23T00:00:00.000Z";
const STATE_DIGEST = "a".repeat(64);

function candidateSession(reviewMode: "off" | "advisory" | "required") {
  const session = runtimeSessionFixture({
    services: {
      profile: {
        profile: { mutationPolicy: { reviewMode } }
      } as never
    }
  });
  session.durable.state.mutationFrontier = {
    revision: 1,
    baselineManifestDigest: "0".repeat(64),
    currentStateDigest: STATE_DIGEST,
    changedPaths: ["README.md"],
    sourceCheckpointIds: ["checkpoint"]
  };
  session.durable.state.proposedOutcome = {
    kind: "completed",
    message: "The requested change is complete.",
    evidence: []
  };
  session.durable.state.phase = "outcome_pending";
  return session;
}

function validation(session: ReturnType<typeof candidateSession>, status: "passed" | "failed"): EvidenceRecord {
  return {
    evidenceId: `validation-${status}`,
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    kind: "validation",
    status,
    createdAt: NOW,
    producer: { authority: "runtime", id: "validate" },
    summary: `validation ${status}`,
    data: {
      validator: "command",
      command: "check",
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
      frontierRevision: 1,
      stateDigest: STATE_DIGEST,
      coveredPaths: ["README.md"],
      claim: {
        kind: "acceptance",
        commandDigest: createHash("sha256").update("check").digest("hex"),
        subject: {
          configPaths: [],
          selectedTests: [],
          exactFiles: ["README.md"]
        },
        status
      }
    }
  };
}

function review(
  session: ReturnType<typeof candidateSession>,
  id: string,
  verdict: "approved" | "changes_requested",
  actualCheck = false
): ReviewEvidence {
  const evidenceId = actualCheck ? `review-check:${id}` : `review-source:${id}`;
  if (actualCheck) {
    const requestId = `review-request:${id}`;
    session.durable.state.reviewReceipts.push({
      schemaVersion: 1,
      reviewRequestId: requestId,
      call: { id: `call:${id}`, name: "validate", arguments: { command: "check" } },
      plan: {
        exactEffects: ["process.spawn", "validation"],
        readPaths: ["."],
        writePaths: [],
        network: "none",
        processMode: "pipe",
        checkpointScope: [],
        idempotence: "replay_safe"
      },
      receipt: {
        callId: `call:${id}`,
        ok: true,
        output: "review check passed",
        outcome: {
          status: "succeeded",
          output: "review check passed",
          diagnosticCodes: []
        },
        observedEffects: ["process.spawn", "validation"],
        actualEffects: ["process.spawn", "validation"],
        artifacts: [],
        diagnostics: [],
        evidence: [{
          evidenceId,
          sessionId: session.identity.sessionId,
          runId: session.durable.runId,
          kind: "diagnostic",
          status: "passed",
          createdAt: NOW,
          producer: { authority: "tool", id: `call:${id}` },
          summary: "review check passed",
          data: { source: "reviewer:validate", diagnostic: { passed: true } }
        }],
        startedAt: NOW,
        completedAt: NOW
      }
    });
  } else if (verdict === "approved") {
    session.durable.state.evidence.push({
      evidenceId,
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      kind: "diagnostic",
      status: "passed",
      createdAt: NOW,
      producer: { authority: "runtime", id: "review-fixture" },
      summary: "durable review source",
      data: { source: "review-fixture", diagnostic: { passed: true } }
    });
  }
  return {
    evidenceId: id,
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    kind: "review",
    status: verdict === "approved" ? "passed" : "failed",
    createdAt: NOW,
    producer: { authority: "runtime", id: "reviewer" },
    summary: verdict,
    data: {
      schemaVersion: 1,
      reviewerId: "reviewer",
      ...(actualCheck ? { reviewRequestId: `review-request:${id}` } : {}),
      verdict,
      findings: verdict === "changes_requested"
        ? [{ actionable: true, severity: "error", summary: "Fix the defect." }]
        : [],
      criteria: [{
        criterion: "Satisfy the durable user request.",
        status: verdict === "approved" ? "satisfied" : "failed",
        evidence: verdict === "approved" ? [evidenceId] : []
      }],
      requiredValidations: [],
      frontierRevision: 1,
      stateDigest: STATE_DIGEST,
      reviewBasisDigest: reviewBasisDigest(session),
      validationEvidenceIds: [],
      durableEvidenceIds: verdict === "approved" ? [evidenceId] : [],
      actualChecks: actualCheck ? [{
        toolName: "validate",
        evidenceIds: [evidenceId],
        summary: "validate passed"
      }] : []
    }
  };
}

describe("Standard and Strict completion policy", () => {
  it("gives Standard one validation reminder and then completes honestly", () => {
    const session = candidateSession("off");
    const first = completionGateDecision(session);
    expect(first).toMatchObject({ action: "continue" });
    if (first.action !== "continue") throw new Error("Expected an advisory.");
    session.durable.state.messages.push({ role: "developer", content: first.message });
    expect(completionGateDecision(session)).toEqual({
      action: "complete",
      authority: "user_policy",
      validationStatus: "unverified",
      statusNote: "Validation status: not run for the current mutation frontier."
    });
  });

  it("reports unresolved Standard advisory status when no model turn remains", () => {
    const session = candidateSession("advisory");
    session.durable.state.budget.consumed.modelTurns =
      session.durable.state.budget.limits.modelTurns;

    expect(completionGateDecision(session)).toMatchObject({
      action: "complete",
      authority: "user_policy",
      validationStatus: "unverified",
      statusNote: expect.stringContaining(
        "reported without an impossible repair turn"
      )
    });
  });

  it("gives a failed validation one repair opportunity and then reports it honestly", () => {
    const session = candidateSession("off");
    session.durable.state.evidence.push(validation(session, "failed"));
    const first = completionGateDecision(session);
    expect(first).toMatchObject({ action: "continue" });
    if (first.action !== "continue") throw new Error("Expected a failed-validation advisory.");
    session.durable.state.messages.push({ role: "developer", content: first.message });
    expect(completionGateDecision(session)).toMatchObject({
      action: "complete",
      validationStatus: "failed",
      statusNote: expect.stringContaining("Validation status: failed")
    });
  });

  it("fails Strict explicitly after an unchanged second stop", () => {
    const session = candidateSession("required");
    const first = completionGateDecision(session);
    expect(first).toMatchObject({ action: "continue" });
    if (first.action !== "continue") throw new Error("Expected a strict requirement.");
    session.durable.state.messages.push({ role: "developer", content: first.message });
    expect(completionGateDecision(session)).toMatchObject({
      action: "fail",
      code: "verification_failed",
      message: expect.stringContaining("unchanged second stop")
    });
  });

  it("requires Strict reviewer approval backed by a reviewer-executed check", () => {
    const session = candidateSession("required");
    session.durable.state.evidence.push(review(session, "strict-review", "approved", true));
    expect(completionGateDecision(session)).toMatchObject({
      action: "complete",
      validationStatus: "passed",
      statusNote: expect.stringContaining("reviewer-executed check")
    });
  });

  it("keeps Standard independent review explicit and relies on plan and validation evidence", () => {
    const session = candidateSession("advisory");
    const first = completionGateDecision(session);
    expect(first).toMatchObject({
      action: "continue",
      message: expect.stringContaining("has not been validated")
    });
    if (first.action !== "continue") throw new Error("Expected a validation advisory.");
    session.durable.state.messages.push({ role: "developer", content: first.message });
    expect(completionGateDecision(session)).toMatchObject({
      action: "complete",
      authority: "user_policy",
      validationStatus: "unverified"
    });

    const validated = candidateSession("advisory");
    validated.durable.state.evidence.push(validation(validated, "passed"));
    expect(completionGateDecision(validated)).toMatchObject({
      action: "complete",
      authority: "user_policy",
      validationStatus: "passed"
    });
  });

  it("keeps explicit review advisory in Standard and binding in Strict", () => {
    const session = candidateSession("advisory");
    session.durable.state.evidence.push(
      review(session, "explicit-first", "changes_requested")
    );
    const first = explicitReviewGateDecision(session);
    expect(first).toMatchObject({
      action: "continue",
      authority: "verification_verdict"
    });
    if (first?.action !== "continue") throw new Error("Expected one repair opportunity.");
    session.durable.state.messages.push({
      role: "developer",
      content: first.message
    });
    const unresolved = explicitReviewGateDecision(session);
    expect(unresolved).toMatchObject({
      action: "continue",
      authority: "verification_verdict"
    });
    if (unresolved?.action !== "continue") throw new Error("Expected an unresolved-review advisory.");
    expect(unresolved.message).toContain("does not convert an advisory review into a runtime failure");
    session.durable.state.messages.push({
      role: "developer",
      content: unresolved.message
    });
    expect(explicitReviewGateDecision(session)).toBeUndefined();

    const rereviewed = candidateSession("advisory");
    rereviewed.durable.state.evidence.push(
      review(rereviewed, "explicit-first", "changes_requested")
    );
    rereviewed.durable.state.plan = {
      revision: 1,
      goal: "Repair the reviewed change.",
      activeNodeId: "repair",
      nodes: [{
        id: "repair",
        title: "Repair",
        dependencies: [],
        status: "in_progress",
        owner: { kind: "root" },
        acceptanceCriteria: ["Satisfy the durable user request."],
        evidence: []
      }]
    };
    rereviewed.durable.state.evidence.push(
      review(rereviewed, "explicit-second", "changes_requested")
    );
    expect(explicitReviewGateDecision(rereviewed)).toMatchObject({
      action: "continue",
      message: expect.stringContaining("unresolved")
    });

    const strict = candidateSession("required");
    strict.durable.state.evidence.push(
      review(strict, "strict-first", "changes_requested")
    );
    const strictFirst = explicitReviewGateDecision(strict);
    if (strictFirst?.action !== "continue") throw new Error("Expected one Strict repair opportunity.");
    strict.durable.state.messages.push({
      role: "developer",
      content: strictFirst.message
    });
    expect(explicitReviewGateDecision(strict)).toMatchObject({
      action: "fail",
      code: "verification_failed",
      authority: "verification_verdict"
    });
  });

  it("reports unresolved Standard review findings on natural completion", () => {
    const session = candidateSession("advisory");
    session.durable.state.evidence.push(validation(session, "passed"));
    session.durable.state.evidence.push(
      review(session, "advisory-review", "changes_requested")
    );
    expect(completionGateDecision(session)).toMatchObject({
      action: "complete",
      authority: "user_policy",
      validationStatus: "passed",
      statusNote: expect.stringContaining(
        "Independent advisory review status: changes_requested; unresolved findings remain."
      )
    });
  });

  it("treats read-only process receipts as new post-review evidence", () => {
    const session = candidateSession("advisory");
    const rejected = review(session, "first-review", "changes_requested");
    session.durable.state.evidence.push(rejected);
    expect(currentFrontierReview(session)?.evidenceId).toBe(rejected.evidenceId);
    session.durable.state.messages.push({
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "repair-probe",
        name: "shell",
        arguments: { command: "run-current-check" }
      }]
    });

    session.durable.state.receipts.push({
      callId: "repair-probe",
      ok: true,
      output: "new objective evidence",
      outcome: {
        status: "succeeded",
        output: "new objective evidence",
        diagnosticCodes: []
      },
      observedEffects: ["process.spawn.readonly"],
      actualEffects: ["process.spawn.readonly"],
      artifacts: [],
      diagnostics: ["exit_code=0"],
      startedAt: NOW,
      completedAt: "2026-07-23T00:00:01.000Z"
    });

    expect(reviewBasisDigest(session)).not.toBe(rejected.data.reviewBasisDigest);
    expect(currentFrontierReview(session)).toBeUndefined();
    expect(postReviewReceiptSummaries(session)).toEqual([expect.objectContaining({
      callId: "repair-probe",
      toolName: "shell",
      ok: true,
      argumentsPreview: "{\"command\":\"run-current-check\"}",
      outputPreview: "new objective evidence",
      effects: ["process.spawn.readonly"],
      diagnostics: ["exit_code=0"]
    })]);
  });

  it("does not let a Standard review waiver bypass Strict review", () => {
    const standard = candidateSession("advisory");
    standard.durable.state.evidence.push({
      evidenceId: "delta",
      sessionId: standard.identity.sessionId,
      runId: standard.durable.runId,
      kind: "workspace_delta",
      status: "passed",
      createdAt: NOW,
      producer: { authority: "runtime", id: "checkpoint" },
      summary: "changed",
      data: {
        checkpointId: "checkpoint",
        delta: { added: [], modified: ["README.md"], deleted: [] }
      }
    }, {
      evidenceId: "waiver",
      sessionId: standard.identity.sessionId,
      runId: standard.durable.runId,
      kind: "user_waiver",
      status: "informational",
      createdAt: NOW,
      producer: { authority: "user" },
      summary: "waived",
      data: { scope: "review", reason: "User explicitly waived independent review." }
    });
    expect(completionGateDecision(standard)).toMatchObject({ action: "continue" });

    const strict = candidateSession("required");
    strict.durable.state.evidence.push(...standard.durable.state.evidence.map((item) => ({
      ...item,
      sessionId: strict.identity.sessionId,
      runId: strict.durable.runId
    })));
    expect(completionGateDecision(strict)).toMatchObject({ action: "continue" });
  });

  it("uses structural frontier binding rather than command-name classification as completion authority", () => {
    const session = candidateSession("required");
    const passed = validation(session, "passed");
    if (passed.kind !== "validation") throw new Error("Expected validation evidence.");
    passed.data.validator = "custom-project-check";
    passed.data.command = "project-specific-command";
    passed.data.coveredPaths = [];
    passed.data.claim = {
      kind: "probe",
      commandDigest: createHash("sha256").update("project-specific-command").digest("hex"),
      subject: { configPaths: [], selectedTests: [], exactFiles: [] },
      status: "passed"
    };
    session.durable.state.evidence.push(passed);
    session.durable.state.evidence.push(
      review(session, "structural-review", "approved", true)
    );
    expect(completionGateDecision(session)).toMatchObject({
      action: "complete",
      validationStatus: "passed"
    });
  });

  it("keeps active processes and open checkpoints as hard completion invariants", () => {
    const processSession = candidateSession("advisory");
    processSession.durable.state.activeProcessIds = ["process-1"];
    expect(completionReviewBlocker(processSession)).toContain(
      "processes remain active"
    );
    expect(completionGateDecision(processSession)).toMatchObject({
      action: "continue",
      message: expect.stringContaining("processes remain active")
    });

    const checkpointSession = candidateSession("advisory");
    checkpointSession.durable.state.checkpointHead = {
      checkpointId: "checkpoint",
      sessionId: checkpointSession.identity.sessionId,
      runId: checkpointSession.durable.runId,
      status: "open",
      preManifestDigest: "0".repeat(64),
      createdAt: NOW
    };
    expect(completionGateDecision(checkpointSession)).toMatchObject({
      action: "continue",
      message: expect.stringContaining("open checkpoint")
    });

    const missingDeltaSession = candidateSession("advisory");
    missingDeltaSession.durable.state.checkpointHead = {
      checkpointId: "checkpoint",
      sessionId: missingDeltaSession.identity.sessionId,
      runId: missingDeltaSession.durable.runId,
      status: "sealed",
      preManifestDigest: "0".repeat(64),
      postManifestDigest: "1".repeat(64),
      createdAt: NOW,
      sealedAt: NOW,
      delta: { added: [], modified: ["README.md"], deleted: [] }
    };
    expect(completionGateDecision(missingDeltaSession)).toMatchObject({
      action: "continue",
      message: expect.stringContaining("no durable workspace-delta evidence")
    });
  });

  it("keeps approvals, repository transactions, and cancellation as hard completion invariants", () => {
    const approvalSession = candidateSession("advisory");
    approvalSession.durable.state.pendingTools = [{
      request: { callId: "pending", name: "write", arguments: { path: "README.md", content: "x" } },
      modelTurn: { turnId: 1, effectRevision: 0 },
      approval: "pending",
      started: false
    }];
    expect(completionGateDecision(approvalSession)).toMatchObject({
      action: "continue",
      message: expect.stringContaining("approval decision is unsettled")
    });

    const transactionSession = candidateSession("advisory");
    transactionSession.durable.state.receipts.push({
      callId: "transaction",
      ok: false,
      output: "conflict",
      result: { status: "conflicts_pending", transactionHandle: "transaction-1" },
      observedEffects: ["repository.write"],
      actualEffects: ["repository.write"],
      artifacts: [],
      diagnostics: ["conflicts_pending"],
      startedAt: NOW,
      completedAt: NOW
    });
    expect(completionGateDecision(transactionSession)).toMatchObject({
      action: "continue",
      message: expect.stringContaining("uncommitted repository transaction")
    });

    const cancellationSession = candidateSession("advisory");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    cancellationSession.execution.controller = controller;
    expect(completionGateDecision(cancellationSession)).toMatchObject({
      action: "continue",
      message: expect.stringContaining("cancellation has been requested")
    });
  });
});
