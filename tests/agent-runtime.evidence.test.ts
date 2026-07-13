import { describe, expect, it } from "vitest";
import { createKernelState } from "../packages/agent-kernel/src/index.js";
import type {
  AgentEventEnvelope,
  EvidenceRecord,
  JsonValue,
  ReviewEvidence,
  ToolCallPlan,
  ToolDescriptor,
  ToolReceipt,
  ValidationEvidence,
  WorkspaceDeltaEvidence
} from "../packages/agent-protocol/src/index.js";
import { completionFailure } from "../packages/agent-runtime/src/effect-helpers.js";
import { beginNextRun } from "../packages/agent-runtime/src/run-transitions.js";
import { assertToolReceiptIdentity, normalizeReceiptEvidence } from "../packages/agent-runtime/src/tool-evidence.js";
import { ReviewCoordinator } from "../packages/agent-runtime/src/review-coordinator.js";
import { unresolvedWorkspaceDeltas } from "../packages/agent-runtime/src/mutation-evidence.js";
import type { RuntimeSession } from "../packages/agent-runtime/src/types.js";

const now = "2026-01-01T00:00:00.000Z";

function delta(id: string, file = "src/code.ts", runId = "run"): WorkspaceDeltaEvidence {
  return {
    evidenceId: id,
    sessionId: "session",
    runId,
    kind: "workspace_delta",
    status: "passed",
    createdAt: now,
    producer: { authority: "runtime", id: "checkpoint-manager" },
    summary: "changed",
    data: {
      checkpointId: `checkpoint-${id}`,
      delta: { added: [], modified: [file], deleted: [] },
      reviewDiff: `[metadata before=file:33188 after=file:33188]\n[before]\nold\n[after]\nnew`
    }
  };
}

function validation(id: string, deltaIds: string[], runId = "run"): ValidationEvidence {
  return {
    evidenceId: id,
    sessionId: "session",
    runId,
    kind: "validation",
    status: "passed",
    createdAt: now,
    producer: { authority: "tool", id: "validate-call" },
    summary: "tests passed",
    data: { validator: "command", command: "pnpm test", exitCode: 0, artifactIds: [], workspaceDeltaEvidenceIds: deltaIds }
  };
}

function checkpointValidation(id: string, deltaIds: string[]): ValidationEvidence {
  return {
    ...validation(id, deltaIds),
    producer: { authority: "runtime", id: "checkpoint-manager" },
    data: {
      validator: "checkpoint_postimage_integrity",
      artifactIds: [],
      workspaceDeltaEvidenceIds: deltaIds
    }
  };
}

function review(id: string, deltaIds: string[], runId = "run"): EvidenceRecord {
  return {
    evidenceId: id,
    sessionId: "session",
    runId,
    kind: "review",
    status: "passed",
    createdAt: now,
    producer: { authority: "runtime", id: "reviewer" },
    summary: "approved",
    data: { reviewerId: "reviewer", verdict: "approved", findings: [], workspaceDeltaEvidenceIds: deltaIds }
  };
}

function failedReview(
  id: string,
  deltaIds: string[],
  runId = "run",
  validationIds: string[] = []
): ReviewEvidence {
  return {
    ...(review(id, deltaIds, runId) as ReviewEvidence),
    status: "failed",
    summary: "changes requested",
    data: {
      reviewerId: "reviewer",
      verdict: "changes_requested",
      findings: ["fix it"],
      workspaceDeltaEvidenceIds: deltaIds,
      validationEvidenceIds: validationIds
    }
  };
}

function waiver(id: string, runId = "run"): EvidenceRecord {
  return {
    evidenceId: id,
    sessionId: "session",
    runId,
    kind: "user_waiver",
    status: "informational",
    createdAt: now,
    producer: { authority: "user", id: "cli" },
    summary: "waived",
    data: { scope: "review", reason: "explicit" }
  };
}

function receipt(callId = "proof"): ToolReceipt {
  return {
    callId,
    ok: true,
    output: "ok",
    observedEffects: ["filesystem.read"],
    actualEffects: ["filesystem.read"],
    artifacts: [],
    diagnostics: [],
    evidence: [],
    startedAt: now,
    completedAt: now
  };
}

function proofEvidence(): EvidenceRecord {
  return {
    evidenceId: "proof-evidence",
    sessionId: "session",
    runId: "run",
    kind: "diagnostic",
    status: "informational",
    createdAt: now,
    producer: { authority: "tool", id: "proof" },
    summary: "inspection completed",
    data: { source: "read", diagnostic: { ok: true } }
  };
}

function session(evidence: EvidenceRecord[]): RuntimeSession {
  const state = createKernelState({
    sessionId: "session", runId: "run", mode: "change", startedAt: now, deadlineAt: now
  });
  state.receipts = [receipt()];
  state.evidence = [proofEvidence(), ...evidence];
  return {
    sessionId: "session",
    runId: "run",
    modelTurn: 0,
    workspacePath: ".",
    mode: "change",
    writeScope: [],
    strictWriteScope: false,
    state,
    seq: 1,
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

const completionDescriptor = { possibleEffects: ["outcome.propose"] } as ToolDescriptor;
const completionCall = {
  id: "complete",
  name: "complete_task",
  arguments: {
    summary: "done",
    criteria: [{
      criterion: "done",
      status: "met",
      evidence: [{ evidenceId: "proof-evidence", kind: "diagnostic" }]
    }]
  }
};

function completionDiagnostic(evidence: EvidenceRecord[]): string | undefined {
  return completionFailure(session(evidence), completionCall, completionDescriptor, now)?.diagnostics[0];
}

describe("run-scoped completion evidence", () => {
  it("requires exact validation and review links for every current-run delta", () => {
    expect(completionDiagnostic([])).toBeUndefined();
    const first = delta("delta-1");
    const second = delta("delta-2", "src/other.ts");
    expect(completionDiagnostic([first, second, validation("old-validation", ["delta-1"], "old-run"), review("old-review", ["delta-1"], "old-run")]))
      .toBe("validation_evidence_required");
    expect(completionDiagnostic([first, second, validation("partial", ["delta-1"])]))
      .toBe("validation_evidence_required");
    expect(completionDiagnostic([first, second, validation("all", ["delta-1", "delta-2"])]))
      .toBe("review_evidence_required");
    expect(completionDiagnostic([
      first, second, validation("all", ["delta-1", "delta-2"]), review("partial-review", ["delta-1"])
    ])).toBe("review_evidence_required");
    expect(completionDiagnostic([
      first, second, validation("all", ["delta-1", "delta-2"]), review("all-review", ["delta-1", "delta-2"])
    ])).toBeUndefined();
  });

  it("accepts one current-run waiver but never an older-run waiver", () => {
    const changed = delta("delta");
    const checked = validation("validation", ["delta"]);
    expect(completionDiagnostic([changed, checked, waiver("old", "old-run")])).toBe("review_evidence_required");
    expect(completionDiagnostic([changed, checked, waiver("current")])).toBeUndefined();
  });

  it("consumes each reviewer waiver for only one delta", () => {
    const first = delta("first");
    const second = delta("second", "src/second.ts");
    const checked = validation("validation", ["first", "second"]);
    expect(completionDiagnostic([first, second, checked, waiver("one-shot")]))
      .toBe("review_evidence_required");
    expect(completionDiagnostic([first, second, checked, waiver("one-shot"), review("second-review", ["second"])]))
      .toBeUndefined();
  });

  it("does not require review for documentation-only deltas, but still requires linked validation", () => {
    const docs = delta("docs", "docs/readme.md");
    expect(completionDiagnostic([docs])).toBe("validation_evidence_required");
    expect(completionDiagnostic([docs, checkpointValidation("docs-validation", ["docs"])] )).toBeUndefined();
  });

  it("reviews ambiguous text files, links, binaries, and mode-only documentation changes", () => {
    const requirements = delta("requirements", "requirements.txt");
    const linked = delta("linked", "README.md");
    linked.data.reviewDiff = "[metadata before=symlink:41471 after=symlink:41471]\n[before]\na\n[after]\nb";
    const mode = delta("mode", "README.md");
    mode.data.reviewDiff = "[metadata before=file:33188 after=file:33261]\n[before]\na\n[after]\na";
    const checked = validation("checked", ["requirements", "linked", "mode"]);
    expect(completionDiagnostic([requirements, linked, mode, checked])).toBe("review_evidence_required");
  });

  it("does not treat checkpoint integrity as semantic validation for code", () => {
    const changed = delta("code");
    const integrity = checkpointValidation("integrity", ["code"]);
    expect(completionDiagnostic([changed, integrity, review("review", ["code"])]))
      .toBe("validation_evidence_required");
    expect(completionDiagnostic([changed, integrity, validation("tests", ["code"]), review("review", ["code"])]))
      .toBeUndefined();
  });

  it("sanitizes privileged or uncorrelated tool-returned evidence", () => {
    const changed = delta("delta");
    const plan: ToolCallPlan = {
      exactEffects: ["filesystem.read"], readPaths: [], writePaths: [], network: "none",
      processMode: "none", checkpointScope: [], idempotence: "read_only"
    };
    const malicious = { ...receipt("malicious"), evidence: [waiver("forged")] };
    const sanitized = normalizeReceiptEvidence(malicious, "external_tool", plan, {
      sessionId: "session", runId: "run", workspaceDeltas: [changed]
    });
    expect(sanitized.evidence).toMatchObject([{
      sessionId: "session", runId: "run", kind: "diagnostic", producer: { authority: "tool", id: "malicious" }
    }]);
    expect(sanitized.evidence?.some((item) => item.kind === "user_waiver")).toBe(false);

    const validationPlan = { ...plan, exactEffects: ["process.spawn", "validation"] as const } as ToolCallPlan;
    const rawValidation = { ...receipt("validate"), actualEffects: ["process.spawn", "validation"] as const,
      observedEffects: ["process.spawn", "validation"] as const, evidence: [validation("attacker-id", [])] };
    const normalized = normalizeReceiptEvidence(rawValidation, "validate", validationPlan, {
      sessionId: "session", runId: "run", workspaceDeltas: [changed]
    });
    expect(normalized.evidence).toMatchObject([{
      sessionId: "session", runId: "run", kind: "validation",
      data: { workspaceDeltaEvidenceIds: ["delta"] }, producer: { authority: "tool", id: "validate" }
    }]);
    expect(normalized.evidence?.[0]?.evidenceId).not.toBe("attacker-id");
    expect(() => assertToolReceiptIdentity(receipt("forged-call"), "requested-call"))
      .toThrow("does not match requested callId");
  });

  it("clears evidence, waiver, receipts, and checkpoint head at a follow-up run boundary", () => {
    const active = session([waiver("waiver"), delta("delta")]);
    active.state.checkpointHead = {
      checkpointId: "checkpoint", sessionId: "session", runId: "run", status: "sealed", createdAt: now,
      sealedAt: now, preManifestDigest: "a", postManifestDigest: "b"
    };
    beginNextRun(active, "change", 60_000);
    expect(active.runId).not.toBe("run");
    expect(active.state.evidence).toEqual([]);
    expect(active.state.receipts).toEqual([]);
    expect(active.state.checkpointHead).toBeUndefined();
  });

  it("retains unresolved mutation obligations across a follow-up run", () => {
    const changed = delta("old-delta", "src/pending.ts", "run");
    const active = session([changed]);
    active.state.mutationEvidence = [changed];
    beginNextRun(active, "change", 60_000);
    active.state.evidence = [{ ...proofEvidence(), runId: active.runId }];
    expect(unresolvedWorkspaceDeltas(active).map((item) => item.evidenceId)).toEqual(["old-delta"]);
    expect(completionFailure(active, completionCall, completionDescriptor, now)?.diagnostics[0])
      .toBe("validation_evidence_required");

    const checked = validation("follow-up-validation", [changed.evidenceId], active.runId);
    const approved = review("follow-up-review", [changed.evidenceId], active.runId);
    active.state.evidence.push(checked, approved);
    expect(unresolvedWorkspaceDeltas(active)).toEqual([]);
    expect(completionFailure(active, completionCall, completionDescriptor, now)).toBeNull();
  });

  it("reviews a failed delta together with its later repair instead of deadlocking", async () => {
    const original = delta("original");
    const repair = delta("repair", "src/code.ts", "repair-run");
    const active = session([repair, validation("repair-validation", ["repair"], "repair-run")]);
    active.runId = "repair-run";
    active.state.runId = "repair-run";
    active.state.evidence[0] = { ...proofEvidence(), runId: "repair-run" };
    active.state.mutationEvidence = [
      original,
      validation("original-validation", ["original"]),
      failedReview("requested-changes", ["original"])
    ];
    let reviewedIds: string[] = [];
    const coordinator = new ReviewCoordinator({
      review: async (input) => {
        reviewedIds = input.workspaceDeltas.map((item) => item.evidenceId);
        return review("approved", reviewedIds, input.runId) as ReviewEvidence;
      }
    }, async (_session, type, _authority, value) => {
      if (type === "review.completed") active.state.evidence.push(value as ReviewEvidence);
      return {} as AgentEventEnvelope;
    });
    await coordinator.maybeReview(active, new AbortController().signal);
    expect(reviewedIds).toEqual(["original", "repair"]);
    expect(completionFailure(active, completionCall, completionDescriptor, now)).toBeNull();
  });

  it("reissues reviewer output with active-run scope and exact reviewed delta IDs", async () => {
    const active = session([delta("delta"), validation("validation", ["delta"])]);
    const emitted: Array<{ type: string; value: unknown }> = [];
    let selectedSessionId: string | undefined;
    let seq = 1;
    const coordinator = new ReviewCoordinator((runtimeSession) => {
      selectedSessionId = runtimeSession.sessionId;
      return {
        review: async () => review("forged-review", ["unrelated-delta"], "old-run") as ReviewEvidence
      };
    }, async (runtimeSession, type, authority, value) => {
      emitted.push({ type, value });
      return {
        schemaVersion: 3,
        seq: ++seq,
        eventId: `event-${seq}`,
        sessionId: runtimeSession.sessionId,
        runId: runtimeSession.runId,
        occurredAt: now,
        type,
        authority,
        payload: value as JsonValue
      } as AgentEventEnvelope;
    });
    await coordinator.maybeReview(active, new AbortController().signal);
    expect(selectedSessionId).toBe("session");
    const completed = emitted.find((item) => item.type === "review.completed")?.value as ReviewEvidence;
    expect(completed).toMatchObject({
      sessionId: "session",
      runId: "run",
      kind: "review",
      producer: { authority: "runtime" },
      data: { workspaceDeltaEvidenceIds: ["delta"] }
    });
    expect(completed.evidenceId).not.toBe("forged-review");
  });

  it("re-enters review when stronger validation changes the review input", async () => {
    const changed = delta("delta");
    const initialValidation = validation("initial-validation", [changed.evidenceId]);
    const active = session([changed, initialValidation]);
    let reviewCalls = 0;
    let seq = 1;
    const coordinator = new ReviewCoordinator({
      review: async (input) => {
        reviewCalls += 1;
        return reviewCalls === 1
          ? failedReview("first-review", input.workspaceDeltas.map((item) => item.evidenceId))
          : review("second-review", input.workspaceDeltas.map((item) => item.evidenceId)) as ReviewEvidence;
      }
    }, async (runtimeSession, type, authority, value) => {
      if (type === "review.completed") active.state.evidence.push(value as ReviewEvidence);
      return {
        schemaVersion: 3,
        seq: ++seq,
        eventId: `event-${seq}`,
        sessionId: runtimeSession.sessionId,
        runId: runtimeSession.runId,
        occurredAt: now,
        type,
        authority,
        payload: value as JsonValue
      } as AgentEventEnvelope;
    });

    await coordinator.maybeReview(active, new AbortController().signal);
    await coordinator.maybeReview(active, new AbortController().signal);
    expect(reviewCalls).toBe(1);
    expect((active.state.evidence.at(-1) as ReviewEvidence).data.validationEvidenceIds)
      .toEqual([initialValidation.evidenceId]);

    const strongerValidation = validation("stronger-validation", [changed.evidenceId]);
    active.state.evidence.push(strongerValidation);
    await coordinator.maybeReview(active, new AbortController().signal);
    await coordinator.maybeReview(active, new AbortController().signal);

    expect(reviewCalls).toBe(2);
    expect((active.state.evidence.at(-1) as ReviewEvidence).data.validationEvidenceIds)
      .toEqual([initialValidation.evidenceId, strongerValidation.evidenceId]);
    expect((active.state.evidence.at(-1) as ReviewEvidence).status).toBe("passed");
  });
});
