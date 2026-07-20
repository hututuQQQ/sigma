import { describe, expect, it } from "vitest";
import type { ReviewEvidence, ValidationEvidence } from "../packages/agent-protocol/src/index.js";
import { reviewBasisDigest } from "../packages/agent-runtime/src/mutation-evidence.js";
import { modelWorkingState } from "../packages/agent-runtime/src/model-working-state.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

describe("runtime-owned working-state capsule", () => {
  it("keeps bounded current obligations while excluding raw arguments and output", () => {
    const session = runtimeSessionFixture();
    const state = session.durable.state;
    state.plan = {
      revision: 1,
      goal: "deliver the requested change",
      activeNodeId: "repair",
      nodes: [{
        id: "repair",
        title: "repair the current failure",
        dependencies: [],
        status: "in_progress",
        owner: { kind: "root" },
        acceptanceCriteria: ["validation passes"],
        evidence: []
      }]
    };
    state.mutationFrontier = {
      ...state.mutationFrontier,
      revision: 2,
      currentStateDigest: "a".repeat(64),
      changedPaths: ["src/current.ts"]
    };
    state.activeProcessIds = ["process-1"];
    state.checkpointHead = {
      checkpointId: "checkpoint-1",
      sessionId: state.sessionId,
      runId: state.runId,
      status: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
      preManifestDigest: "baseline"
    };
    state.receipts.push({
      callId: "failed-command",
      ok: false,
      output: "raw-secret-output-must-not-appear",
      outcome: {
        status: "failed",
        output: "raw-secret-output-must-not-appear",
        diagnosticCodes: ["execution_capability_unavailable"]
      },
      observedEffects: [],
      artifacts: ["volatile-artifact-id"],
      diagnostics: ["execution_capability_unavailable"],
      evidence: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z"
    });

    const capsule = modelWorkingState(session);

    expect(capsule).toMatchObject({ authority: "runtime", provenance: "working_state" });
    expect(capsule.content).toContain("repair:in_progress:repair the current failure");
    expect(capsule.content).toContain("src/current.ts");
    expect(capsule.content).toContain("process-1");
    expect(capsule.content).toContain("checkpoint-1:open");
    expect(capsule.content).toContain("execution_capability_unavailable");
    expect(capsule.content).not.toContain("raw-secret-output-must-not-appear");
    expect(capsule.content).not.toContain("volatile-artifact-id");
    expect(capsule.tokenCount).toBeLessThan(1_000);
  });

  it("reports only validation and review evidence bound to the current frontier", () => {
    const session = runtimeSessionFixture();
    const state = session.durable.state;
    state.mutationFrontier = {
      ...state.mutationFrontier,
      revision: 2,
      currentStateDigest: "a".repeat(64),
      changedPaths: ["src/current.ts"]
    };
    const staleValidation: ValidationEvidence = {
      evidenceId: "stale-validation",
      sessionId: state.sessionId,
      runId: state.runId,
      kind: "validation",
      status: "passed",
      createdAt: "2026-01-01T00:00:00.000Z",
      producer: { authority: "tool", id: "validate" },
      summary: "old frontier passed",
      data: {
        validator: "command",
        command: "pnpm test",
        exitCode: 0,
        frontierRevision: 1,
        stateDigest: "b".repeat(64),
        coveredPaths: ["src/current.ts"],
        claim: {
          kind: "unit",
          commandDigest: "c".repeat(64),
          status: "passed",
          strength: "behavioral",
          independence: "cross_method",
          assertionMode: "explicit",
          subject: { projectId: ".", configPaths: [], selectedTests: [], exactFiles: [] }
        }
      }
    };
    const staleReview: ReviewEvidence = {
      evidenceId: "stale-review",
      sessionId: state.sessionId,
      runId: state.runId,
      kind: "review",
      status: "passed",
      createdAt: "2026-01-01T00:00:01.000Z",
      producer: { authority: "runtime", id: "reviewer" },
      summary: "old review approved",
      data: {
        reviewerId: "reviewer",
        verdict: "approved",
        findings: [],
        frontierRevision: 1,
        stateDigest: "b".repeat(64),
        reviewBasisVersion: 3,
        reviewBasisDigest: "d".repeat(64)
      }
    };
    state.evidence.push(staleValidation, staleReview);

    const staleCapsule = modelWorkingState(session).content;
    expect(staleCapsule).toContain("latest validation: none");
    expect(staleCapsule).toContain("latest review: none");

    const currentValidation: ValidationEvidence = {
      ...staleValidation,
      evidenceId: "current-validation",
      data: {
        ...staleValidation.data,
        frontierRevision: 2,
        stateDigest: "a".repeat(64)
      }
    };
    state.evidence.push(currentValidation);
    const currentReview: ReviewEvidence = {
      ...staleReview,
      evidenceId: "current-review",
      data: {
        ...staleReview.data,
        frontierRevision: 2,
        stateDigest: "a".repeat(64),
        reviewBasisDigest: reviewBasisDigest(session)
      }
    };
    state.evidence.push(currentReview);

    const currentCapsule = modelWorkingState(session).content;
    expect(currentCapsule).toContain("latest validation: passed; claim=unit; frontier=2");
    expect(currentCapsule).toContain("latest review: passed; verdict=approved; frontier=2");
  });
});
