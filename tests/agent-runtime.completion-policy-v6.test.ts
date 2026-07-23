import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EvidenceRecord } from "../packages/agent-protocol/src/index.js";
import {
  completionCandidate,
  completionGateDecision
} from "../packages/agent-runtime/src/completion-evidence-gate.js";
import { reviewBasisDigest } from "../packages/agent-runtime/src/mutation-evidence.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

const NOW = "2026-07-23T00:00:00.000Z";
const STATE_DIGEST = "a".repeat(64);

function candidateSession(reviewMode: "advisory" | "required") {
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

describe("V6 Standard and Strict completion policy", () => {
  it("gives Standard one validation reminder and then completes honestly", () => {
    const session = candidateSession("advisory");
    const first = completionGateDecision(session);
    expect(first).toMatchObject({ action: "continue" });
    if (first.action !== "continue") throw new Error("Expected an advisory.");
    session.durable.state.messages.push({ role: "developer", content: first.message });
    expect(completionGateDecision(session)).toEqual({
      action: "complete",
      validationStatus: "unverified",
      statusNote: "Validation status: not run for the current mutation frontier."
    });
  });

  it("lets Standard report a recorded failed validation without a hidden repair mode", () => {
    const session = candidateSession("advisory");
    session.durable.state.evidence.push(validation(session, "failed"));
    expect(completionGateDecision(session)).toMatchObject({
      action: "complete",
      validationStatus: "failed",
      statusNote: expect.stringContaining("validation failed")
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
      code: "strict_policy_failure",
      message: expect.stringContaining("unchanged second stop")
    });
  });

  it("requires Strict validation and reviewer approval for the same candidate", () => {
    const session = candidateSession("required");
    const passed = validation(session, "passed");
    session.durable.state.evidence.push(passed);
    const candidate = completionCandidate(session)!;
    const basis = reviewBasisDigest(session, undefined, candidate.digest);
    session.durable.state.evidence.push({
      evidenceId: "review",
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      kind: "review",
      status: "passed",
      createdAt: NOW,
      producer: { authority: "runtime", id: "reviewer" },
      summary: "approved",
      data: {
        reviewerId: "reviewer",
        verdict: "approved",
        findings: [],
        frontierRevision: 1,
        stateDigest: STATE_DIGEST,
        reviewBasisDigest: basis,
        validationEvidenceIds: [passed.evidenceId]
      }
    });
    expect(completionGateDecision(session)).toMatchObject({
      action: "complete",
      validationStatus: "passed",
      statusNote: expect.stringContaining("approved")
    });
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
    const candidate = completionCandidate(session)!;
    session.durable.state.evidence.push({
      evidenceId: "structural-review",
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      kind: "review",
      status: "passed",
      createdAt: NOW,
      producer: { authority: "runtime", id: "reviewer" },
      summary: "approved",
      data: {
        reviewerId: "reviewer",
        verdict: "approved",
        findings: [],
        frontierRevision: 1,
        stateDigest: STATE_DIGEST,
        reviewBasisDigest: reviewBasisDigest(session, undefined, candidate.digest),
        validationEvidenceIds: [passed.evidenceId]
      }
    });
    expect(completionGateDecision(session)).toMatchObject({
      action: "complete",
      validationStatus: "passed"
    });
  });

  it("keeps active processes and open checkpoints as hard completion invariants", () => {
    const processSession = candidateSession("advisory");
    processSession.durable.state.activeProcessIds = ["process-1"];
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
