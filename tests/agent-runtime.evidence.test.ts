import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createKernelState, reviewRepairObligation } from "../packages/agent-kernel/src/index.js";
import type {
  AgentEventEnvelope,
  EvidenceRecord,
  JsonValue,
  ModelToolCall,
  RepositoryDeltaEvidence,
  ReviewEvidence,
  ToolCallPlan,
  ToolDescriptor,
  ToolReceipt,
  ValidationEvidence,
  WorkspaceDeltaEvidence
} from "../packages/agent-protocol/src/index.js";
import { completionFailure } from "../packages/agent-runtime/src/effect-helpers.js";
import { assuranceRequirement, validationClaimSatisfies } from "../packages/agent-runtime/src/assurance-engine.js";
import { evidenceLedger } from "../packages/agent-runtime/src/model-evidence-ledger.js";
import { beginNextRun } from "../packages/agent-runtime/src/run-transitions.js";
import { RuntimeControlService } from "../packages/agent-runtime/src/runtime-control.js";
import type { RuntimeControlServiceOptions } from "../packages/agent-runtime/src/runtime-control-contracts.js";
import { assertToolReceiptIdentity, normalizeReceiptEvidence } from "../packages/agent-runtime/src/tool-evidence.js";
import {
  assertTaskControlPlanAllowed,
  assertReceiptWithinPlan,
  validationScope
} from "../packages/agent-runtime/src/tool-plan-enforcement.js";
import { ReviewCoordinator, reviewReadiness } from "../packages/agent-runtime/src/review-coordinator.js";
import { frontierValidationReadiness, unresolvedWorkspaceDeltas } from "../packages/agent-runtime/src/mutation-evidence.js";
import type { RuntimeSession } from "../packages/agent-runtime/src/types.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

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

function failedValidation(id: string, deltaIds: string[], runId = "run"): ValidationEvidence {
  return {
    ...validation(id, deltaIds, runId),
    status: "failed",
    summary: "tests exited 1",
    data: {
      validator: "command",
      command: "pnpm test",
      exitCode: 1,
      termination: {
        processStarted: true,
        state: "exited",
        exitCode: 1,
        signal: null,
        timedOut: false,
        idleTimedOut: false,
        cancelled: false
      },
      artifactIds: [],
      workspaceDeltaEvidenceIds: deltaIds,
      checkpointIds: deltaIds.map((deltaId) => `checkpoint-${deltaId}`)
    }
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

function review(
  id: string,
  deltaIds: string[],
  runId = "run",
  validationIds?: string[]
): EvidenceRecord {
  return {
    evidenceId: id,
    sessionId: "session",
    runId,
    kind: "review",
    status: "passed",
    createdAt: now,
    producer: { authority: "runtime", id: "reviewer" },
    summary: "approved",
    data: {
      reviewerId: "reviewer",
      verdict: "approved",
      findings: [],
      workspaceDeltaEvidenceIds: deltaIds,
      ...(validationIds ? { validationEvidenceIds: validationIds } : {})
    }
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

function repositoryDelta(target = "1".repeat(40)): RepositoryDeltaEvidence {
  const digest = "a".repeat(64);
  return {
    evidenceId: "repository-delta",
    sessionId: "session",
    runId: "run",
    kind: "repository_delta",
    status: "passed",
    createdAt: now,
    producer: { authority: "tool", id: "git-call" },
    summary: "repository recovered",
    data: {
      repositoryRoot: ".",
      operationCount: 1,
      operations: ["reset"],
      beforeStateDigest: "b".repeat(64),
      afterStateDigest: digest,
      headBefore: "2".repeat(40),
      headAfter: target,
      refsBeforeDigest: "c".repeat(64),
      refsAfterDigest: digest,
      indexBeforeDigest: "d".repeat(64),
      indexAfterDigest: digest,
      reachableObjectsBefore: 1,
      reachableObjectsAfter: 2,
      transactionHandle: "transaction",
      selectionEvidenceId: "selection",
      candidateId: "e".repeat(64),
      selectedObject: target,
      semanticAssertions: {
        schemaVersion: 3,
        head: target,
        symbolicRef: "refs/heads/main",
        refsDigest: digest,
        reachabilityDigest: digest,
        reachableObjectCount: 2,
        indexDigest: digest,
        conflictsDigest: digest,
        conflictCount: 0,
        trackedDigest: digest,
        trackedCount: 1,
        untrackedDigest: digest,
        untrackedCount: 0,
        targetAssertions: {
          schemaVersion: 3,
          selectedHead: target,
          selectedSymbolicRef: "refs/heads/main",
          requiredReachableObjects: [target],
          satisfied: true
        }
      }
    }
  };
}

function session(evidence: EvidenceRecord[]): RuntimeSession {
  const state = createKernelState({
    sessionId: "session", runId: "run", mode: "change", startedAt: now, deadlineAt: now
  });
  state.receipts = [receipt()];
  state.evidence = [proofEvidence(), ...evidence];
  return runtimeSessionFixture({ state, seq: 1 });
}

const validationPlan: ToolCallPlan = {
  exactEffects: ["validation"],
  readPaths: [],
  writePaths: [],
  network: "none",
  processMode: "pipe",
  checkpointScope: [],
  idempotence: "read_only"
};

const validationTargetIds = (): never => {
  throw new Error("V3 evidence-ID validation scope remains removed in V5.");
};

describe.skip("V3 validation workspace-delta scope", () => {
  it("infers the only unresolved delta for the built-in validator", () => {
    expect(validationTargetIds(session([delta("delta-one")]), {
      id: "validate", name: "validate", arguments: {}
    }, validationPlan)).toEqual(["delta-one"]);
  });

  it("requires an explicit scope when multiple unresolved deltas exist", () => {
    expect(() => validationTargetIds(session([
      delta("delta-one", "src/one.ts"),
      delta("delta-two", "src/two.ts")
    ]), {
      id: "validate", name: "validate", arguments: {}
    }, validationPlan)).toThrow(expect.objectContaining({ code: "validation_scope_ambiguous" }));
  });

  it("preserves implicit runtime binding for purpose-built validators", () => {
    expect(validationTargetIds(session([
      delta("delta-one", "src/one.ts"),
      delta("delta-two", "src/two.ts")
    ]), {
      id: "fixture", name: "verify_fixture_files", arguments: {}
    }, validationPlan)).toBeUndefined();
  });
});

describe("V5 assurance-coordinated mutation completion", () => {
  it("does not let a generic acceptance claim replace explicit semantic claims", () => {
    expect(validationClaimSatisfies("acceptance", "acceptance")).toBe(true);
    expect(validationClaimSatisfies("acceptance", "typecheck")).toBe(false);
    expect(validationClaimSatisfies("acceptance", "lint")).toBe(false);
    expect(validationClaimSatisfies("acceptance", "unit")).toBe(false);
    expect(validationClaimSatisfies("integration", "unit")).toBe(true);
  });

  function frontierSession(): RuntimeSession {
    const active = session([]);
    active.durable.state.mutationFrontier = {
      revision: 4,
      baselineManifestDigest: "0".repeat(64),
      currentStateDigest: "a".repeat(64),
      changedPaths: ["src/code.ts", "docs/readme.md"],
      sourceCheckpointIds: ["checkpoint-final"]
    };
    return active;
  }

  function frontierValidation(id: string, coveredPaths: string[]): ValidationEvidence {
    return {
      evidenceId: id, sessionId: "session", runId: "run", kind: "validation",
      status: "passed", createdAt: now, producer: { authority: "tool", id },
      summary: "passed", data: {
        validator: "command", command: "pnpm test", exitCode: 0,
        frontierRevision: 4, stateDigest: "a".repeat(64), coveredPaths,
        claim: {
          kind: "typecheck", commandDigest: "f".repeat(64), status: "passed",
          subject: { projectId: ".", configPaths: [], selectedTests: [], exactFiles: [] }
        }
      }
    };
  }

  it("derives coverage from semantic command subjects, not read roots", () => {
    const active = frontierSession();
    const scope = validationScope(active, {
      id: "validate", name: "validate", arguments: { executable: "tsc", args: ["--noEmit"] }
    }, { ...validationPlan, readPaths: ["docs"] });
    expect(scope).toMatchObject({
      frontierRevision: 4,
      stateDigest: "a".repeat(64),
      coveredPaths: ["src/code.ts"],
      claim: { kind: "typecheck", subject: { projectId: "." } }
    });
    expect(scope?.claim.commandDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("recognizes Cargo validation subcommands and covers Rust changes", () => {
    const active = frontierSession();
    active.durable.state.mutationFrontier.changedPaths = [
      "native/sigma-exec/src/main.rs", "docs/readme.md"
    ];
    const unit = validationScope(active, {
      id: "cargo-test", name: "validate",
      arguments: { executable: "cargo", args: ["+stable", "test", "--locked"] }
    }, validationPlan);
    expect(unit).toMatchObject({
      coveredPaths: ["native/sigma-exec/src/main.rs"],
      claim: { kind: "unit" }
    });
    const acceptance = validationScope(active, {
      id: "cargo-build", name: "validate",
      arguments: { executable: "cargo", args: ["build", "--locked"] }
    }, validationPlan);
    expect(acceptance).toMatchObject({
      coveredPaths: ["native/sigma-exec/src/main.rs", "docs/readme.md"],
      claim: { kind: "acceptance" }
    });
  });

  it("requires unit evidence for non-source assets under tests", () => {
    const active = frontierSession();
    active.durable.state.mutationFrontier.changedPaths = ["tests/fixtures/data.json"];

    expect(frontierValidationReadiness(active)).toMatchObject({
      ready: false,
      coveredPaths: [],
      missingPaths: ["tests/fixtures/data.json"],
      missingClaims: ["unit"]
    });
  });

  it("limits node --check to its exact file and gives generic probes no coverage", () => {
    const active = frontierSession();
    const syntax = validationScope(active, {
      id: "syntax", name: "validate",
      arguments: { executable: "node", args: ["--check", "src/code.ts"] }
    }, { ...validationPlan, readPaths: ["."] });
    expect(syntax).toMatchObject({
      coveredPaths: ["src/code.ts"],
      claim: { kind: "syntax", subject: { exactFiles: ["src/code.ts"] } }
    });
    const probe = validationScope(active, {
      id: "probe", name: "validate", arguments: { executable: "node", args: ["--version"] }
    }, { ...validationPlan, readPaths: ["."] });
    expect(probe).toMatchObject({ coveredPaths: [], claim: { kind: "probe" } });
  });

  it("honors an explicit node --check acceptance command as a syntax requirement", () => {
    const active = frontierSession();
    active.durable.state.plan = {
      ...active.durable.state.plan,
      goal: "Create provider-smoke.js and run node --check provider-smoke.js."
    };
    active.durable.state.mutationFrontier.changedPaths = ["provider-smoke.js"];

    expect(assuranceRequirement(active)).toMatchObject({
      requiredClaims: ["syntax"]
    });
    expect(validationScope(active, {
      id: "syntax", name: "validate",
      arguments: { executable: "node", args: ["--check", "provider-smoke.js"] }
    }, validationPlan)).toMatchObject({
      coveredPaths: ["provider-smoke.js"],
      claim: { kind: "syntax", subject: { exactFiles: ["provider-smoke.js"] } }
    });
  });

  it("allows one final validation set and invalidates it after a later revision", () => {
    const active = frontierSession();
    active.durable.state.evidence.push(
      frontierValidation("code", ["src/code.ts"]),
      frontierValidation("docs", ["docs/readme.md"])
    );
    expect(frontierValidationReadiness(active)).toMatchObject({
      ready: true,
      missingPaths: []
    });
    active.durable.state.mutationFrontier = {
      ...active.durable.state.mutationFrontier,
      revision: 5,
      currentStateDigest: "b".repeat(64)
    };
    expect(frontierValidationReadiness(active)).toMatchObject({
      ready: false,
      missingPaths: ["src/code.ts"]
    });
  });

  it("keeps semantic validation hard while advisory review does not block", () => {
    const active = frontierSession();
    const call: ModelToolCall = { id: "runtime_completion_intent_test", name: "runtime_finalize", arguments: { summary: "done" } };
    const descriptor = { possibleEffects: ["outcome.propose"] } as ToolDescriptor;
    expect(completionFailure(active, call, descriptor, now)).toMatchObject({
      ok: false,
      diagnostics: ["validation_evidence_required"]
    });
    active.durable.state.evidence.push(
      frontierValidation("code", ["src/code.ts"]),
      frontierValidation("docs", ["docs/readme.md"])
    );
    expect(completionFailure(active, call, descriptor, now)).toBeNull();
  });

  it("keeps failed goal input obligations open until that same external path is read", () => {
    const requiredPath = pathForInputObligation();
    const inputAccess = (
      evidenceId: string,
      status: "passed" | "failed",
      inputPath: string,
      scope: "external" | "workspace"
    ): EvidenceRecord => ({
      evidenceId, sessionId: "session", runId: "run", kind: "input_access", status,
      createdAt: now, producer: { authority: "tool", id: evidenceId }, summary: evidenceId,
      data: {
        path: inputPath,
        scope,
        ...(status === "passed" ? { sha256: "f".repeat(64), byteLength: 7 } : { failureCode: "workspace_read_unavailable" })
      }
    });
    const failed = inputAccess("required-failed", "failed", requiredPath, "external");
    const substitute = inputAccess("generated-substitute", "passed", "fixture/generated.txt", "workspace");
    const target = session([failed, substitute]);
    target.durable.state.plan.goal = `Transform the user input at ${requiredPath}.`;
    const call: ModelToolCall = { id: "runtime_completion_intent_test", name: "runtime_finalize", arguments: { summary: "done" } };
    const descriptor = { possibleEffects: ["outcome.propose"] } as ToolDescriptor;

    expect(completionFailure(target, call, descriptor, now)).toMatchObject({
      ok: false,
      diagnostics: ["input_access_unresolved"],
      result: { paths: [requiredPath] }
    });
    target.durable.state.evidence.push(inputAccess("required-passed", "passed", requiredPath, "external"));
    expect(completionFailure(target, call, descriptor, now)).toBeNull();
    expect(completionFailure(target, {
      id: "blocked", name: "report_blocked", arguments: { summary: "input inaccessible" }
    }, { possibleEffects: ["outcome.report_blocked"] } as ToolDescriptor, now)).toBeNull();
  });
});

function pathForInputObligation(): string {
  return process.platform === "win32" ? "C:\\user-input\\source.txt" : "/user-input/source.txt";
}

describe("leaf-aware effect-plan enforcement", () => {
  it("accepts a declared leaf after that file has been deleted", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-deleted-leaf-plan-"));
    await mkdir(path.join(workspace, "src"));
    const active = runtimeSessionFixture({ workspacePath: workspace });
    const plan: ToolCallPlan = {
      exactEffects: ["filesystem.write", "destructive"],
      readPaths: ["src/obsolete.txt"], writePaths: ["src/obsolete.txt"],
      network: "none", processMode: "none", checkpointScope: ["src/obsolete.txt"],
      idempotence: "non_replayable"
    };
    const result: ToolReceipt = {
      callId: "delete", ok: true, output: "deleted",
      observedEffects: ["filesystem.write", "destructive"],
      actualEffects: ["filesystem.write", "destructive"],
      artifacts: [], diagnostics: [], evidence: [], startedAt: now, completedAt: now,
      workspaceDelta: { added: [], modified: [], deleted: ["src/obsolete.txt"] }
    };

    await expect(assertReceiptWithinPlan(active, result, plan)).resolves.toBeUndefined();
  });
});

describe("review repair plan enforcement", () => {
  function repairPlan(writePaths: string[]): ToolCallPlan {
    return {
      exactEffects: ["filesystem.write"], readPaths: [], writePaths,
      network: "none", processMode: "none", checkpointScope: writePaths,
      idempotence: "non_replayable"
    };
  }

  it("allows only writes inside the runtime-authenticated finding scope", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-review-repair-plan-"));
    await mkdir(path.join(workspace, "src"));
    const active = runtimeSessionFixture({ workspacePath: workspace });
    active.durable.state.taskControl = reviewRepairObligation(
      active.durable.state.taskControl,
      active.durable.state.revision,
      "a".repeat(64),
      ["src/target.ts"]
    );

    await expect(assertTaskControlPlanAllowed(active, repairPlan(["src/target.ts"])))
      .resolves.toBeUndefined();
    await expect(assertTaskControlPlanAllowed(active, repairPlan(["src/other.ts"])))
      .rejects.toMatchObject({ code: "tool_unavailable_for_repair" });
  });

  it("rejects mutation plans without an exact write target", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-review-repair-empty-plan-"));
    const active = runtimeSessionFixture({ workspacePath: workspace });
    active.durable.state.taskControl = reviewRepairObligation(
      active.durable.state.taskControl,
      active.durable.state.revision,
      "b".repeat(64),
      ["target.ts"]
    );
    await expect(assertTaskControlPlanAllowed(active, repairPlan([])))
      .rejects.toMatchObject({ code: "tool_unavailable_for_repair" });
  });
});

describe.runIf(process.platform !== "win32")("symlink-aware effect-plan enforcement", () => {
  it("treats a workspace virtual-environment interpreter link as the written link object", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-venv-link-plan-"));
    const external = await mkdtemp(path.join(os.tmpdir(), "sigma-venv-link-target-"));
    await mkdir(path.join(workspace, ".venv", "bin"), { recursive: true });
    await writeFile(path.join(external, "python"), "runtime", "utf8");
    await symlink(path.join(external, "python"), path.join(workspace, ".venv", "bin", "python"), "file");
    const active = runtimeSessionFixture({ workspacePath: workspace });
    const plan: ToolCallPlan = {
      exactEffects: ["filesystem.write"], readPaths: [], writePaths: [".venv"],
      network: "none", processMode: "none", checkpointScope: [".venv"],
      idempotence: "non_replayable"
    };
    const result: ToolReceipt = {
      callId: "venv", ok: true, output: "created",
      observedEffects: ["filesystem.write"], actualEffects: ["filesystem.write"],
      artifacts: [], diagnostics: [], evidence: [], startedAt: now, completedAt: now,
      workspaceDelta: {
        added: [".venv", ".venv/bin", ".venv/bin/python"], modified: [], deleted: []
      }
    };

    await expect(assertReceiptWithinPlan(active, result, plan)).resolves.toBeUndefined();
  });

  it("rejects a changed path whose linked ancestor escapes the workspace", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-link-ancestor-plan-"));
    const external = await mkdtemp(path.join(os.tmpdir(), "sigma-link-ancestor-target-"));
    await mkdir(path.join(workspace, ".venv"));
    await writeFile(path.join(external, "python"), "runtime", "utf8");
    await symlink(external, path.join(workspace, ".venv", "bin"), "dir");
    const active = runtimeSessionFixture({ workspacePath: workspace });
    const plan: ToolCallPlan = {
      exactEffects: ["filesystem.write"], readPaths: [], writePaths: [".venv"],
      network: "none", processMode: "none", checkpointScope: [".venv"],
      idempotence: "non_replayable"
    };
    const result: ToolReceipt = {
      callId: "escape", ok: true, output: "changed",
      observedEffects: ["filesystem.write"], actualEffects: ["filesystem.write"],
      artifacts: [], diagnostics: [], evidence: [], startedAt: now, completedAt: now,
      workspaceDelta: { added: [], modified: [".venv/bin/python"], deleted: [] }
    };

    await expect(assertReceiptWithinPlan(active, result, plan))
      .rejects.toMatchObject({ code: "effect_plan_violation" });
  });
});

const completionDescriptor = { possibleEffects: ["outcome.propose"] } as ToolDescriptor;
const completionCall = {
  id: "runtime_completion_intent_test",
  name: "runtime_finalize",
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

function completionReceipt(
  evidence: EvidenceRecord[],
  call: ModelToolCall = completionCall
): ToolReceipt | null {
  return completionFailure(session(evidence), call, completionDescriptor, now);
}

describe.skip("V3 run-scoped completion evidence", () => {
  it("bounds the prompt projection while keeping the newest structural and observational evidence", () => {
    const target = session([]);
    const observations = Array.from({ length: 40 }, (_, index): EvidenceRecord => ({
      ...proofEvidence(),
      evidenceId: `observation-${index}`,
      status: "passed",
      summary: `observation ${index}`
    }));
    const validations = Array.from({ length: 40 }, (_, index) => validation(`validation-${index}`, []));
    target.durable.state.evidence = [...observations, ...validations];

    const ledger = evidenceLedger(target)!;
    const projectedRecords = ledger.content.match(/^- /gmu) ?? [];
    expect(projectedRecords).toHaveLength(48);
    expect(ledger.content).toContain("32 older current-run evidence records omitted");
    expect(ledger.content).not.toContain("- observation-0 ");
    expect(ledger.content).toContain("- observation-39 ");
    expect(ledger.content).not.toContain("- validation-0 ");
    expect(ledger.content).toContain("- validation-39 ");
    expect(ledger.id).toMatch(/^runtime:evidence-ledger:run:[a-f0-9]{16}$/u);
  });

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

  it("lets failed validation prove execution and honest reporting, but never validation success", () => {
    const failed = failedValidation("failed-validation", []);
    const call = (claim: "validation_executed" | "validation_passed" | "acceptance_met"): ModelToolCall => ({
      id: `complete-${claim}`,
      name: "runtime_finalize",
      arguments: {
        summary: "reported",
        criteria: [{
          criterion: "Validation was executed and reported honestly.",
          status: "met",
          claim,
          evidence: [{ evidenceId: failed.evidenceId, kind: "validation", claim }]
        }]
      }
    });
    expect(completionReceipt([failed], call("validation_executed"))).toBeNull();
    expect(completionReceipt([failed], call("validation_passed"))).toMatchObject({
      ok: false,
      diagnostics: ["invalid_completion_evidence"],
      result: {
        status: "rejected",
        code: "invalid_completion_evidence",
        availableEvidence: expect.arrayContaining([expect.objectContaining({
          evidenceId: failed.evidenceId,
          status: "failed",
          claims: ["validation_executed"]
        })]),
        nextActions: [{
          tool: "runtime_finalize",
          action: "replace_invalid_evidence_references",
          rule: expect.stringContaining("Mixed reference claims within one criterion are valid")
        }]
      }
    });
    expect(completionReceipt([failed], call("acceptance_met"))?.diagnostics)
      .toEqual(["invalid_completion_evidence"]);
  });

  it("requires an exited failed validation to be cited instead of pretending it passed", () => {
    const changed = delta("delta");
    const failed = failedValidation("failed-validation", [changed.evidenceId]);
    expect(completionReceipt([changed, failed])).toMatchObject({
      ok: false,
      diagnostics: ["validation_result_reporting_required"],
      result: {
        status: "rejected",
        code: "validation_result_reporting_required",
        missing: [{
          requirement: "failed_validation_reported",
          workspaceDeltaEvidenceId: changed.evidenceId,
          checkpointId: changed.data.checkpointId,
          expectedEvidence: {
            evidenceId: failed.evidenceId,
            kind: "validation",
            status: "failed",
            claim: "validation_executed"
          }
        }],
        nextActions: [{
          tool: "runtime_finalize",
          action: "cite_failed_validation_result",
          evidenceReferences: [{
            evidenceId: failed.evidenceId,
            kind: "validation",
            claim: "validation_executed"
          }]
        }]
      }
    });
  });

  it("completes a reviewed change with independent workspace and failed-validation claims", () => {
    const changed = delta("delta");
    const failed = failedValidation("failed-validation", [changed.evidenceId]);
    const approved = review("review", [changed.evidenceId], "run", [failed.evidenceId]);
    const call: ModelToolCall = {
      id: "complete-failed-validation",
      name: "runtime_finalize",
      arguments: {
        summary: "change applied; failed validation reported",
        criteria: [{
          criterion: "The change was applied and its failed validation was reported.",
          status: "met",
          evidence: [
            { evidenceId: changed.evidenceId, kind: changed.kind, claim: "acceptance_met" },
            { evidenceId: failed.evidenceId, kind: failed.kind, claim: "validation_executed" },
            { evidenceId: approved.evidenceId, kind: approved.kind, claim: "acceptance_met" }
          ]
        }]
      }
    };
    expect(reviewReadiness(session([changed, failed])).eligible.map((item) => item.evidenceId))
      .toEqual([changed.evidenceId]);
    expect(completionReceipt([changed, failed, approved], call)).toBeNull();
  });

  it("accepts workspace and passed-validation claims in the same criterion", () => {
    const changed = delta("delta");
    const passed = validation("validation", [changed.evidenceId]);
    const approved = review("review", [changed.evidenceId], "run", [passed.evidenceId]);
    const call: ModelToolCall = {
      id: "complete-passed-validation",
      name: "runtime_finalize",
      arguments: {
        summary: "change applied and validation passed",
        criteria: [{
          criterion: "The change was applied and validated.",
          status: "met",
          evidence: [
            { evidenceId: changed.evidenceId, kind: changed.kind, claim: "acceptance_met" },
            { evidenceId: passed.evidenceId, kind: passed.kind, claim: "validation_passed" },
            { evidenceId: approved.evidenceId, kind: approved.kind, claim: "acceptance_met" }
          ]
        }]
      }
    };
    expect(completionReceipt([changed, passed, approved], call)).toBeNull();
  });

  it("does not hide a later failed validation behind an earlier pass or stale review", () => {
    const changed = delta("delta");
    const passed = validation("passed-validation", [changed.evidenceId]);
    const staleReview = review("stale-review", [changed.evidenceId], "run", [passed.evidenceId]);
    const failed = failedValidation("later-failed-validation", [changed.evidenceId]);
    const call = (reviewEvidence: EvidenceRecord, includeFailure: boolean): ModelToolCall => ({
      id: `complete-latest-${includeFailure}`,
      name: "runtime_finalize",
      arguments: {
        summary: "latest validation outcome reported",
        criteria: [{
          criterion: "The latest validation result is represented without changing its meaning.",
          status: "met",
          evidence: [
            { evidenceId: changed.evidenceId, kind: changed.kind, claim: "acceptance_met" },
            ...(includeFailure
              ? [{ evidenceId: failed.evidenceId, kind: failed.kind, claim: "validation_executed" }]
              : [{ evidenceId: passed.evidenceId, kind: passed.kind, claim: "validation_passed" }]),
            { evidenceId: reviewEvidence.evidenceId, kind: reviewEvidence.kind, claim: "acceptance_met" }
          ]
        }]
      }
    });

    expect(completionReceipt([changed, passed, staleReview, failed], call(staleReview, false)))
      .toMatchObject({ diagnostics: ["validation_result_reporting_required"] });
    expect(completionReceipt([changed, passed, staleReview, failed], call(staleReview, true)))
      .toMatchObject({ diagnostics: ["review_evidence_required"] });

    const currentReview = review("current-review", [changed.evidenceId], "run", [passed.evidenceId, failed.evidenceId]);
    expect(completionReceipt(
      [changed, passed, staleReview, failed, currentReview],
      call(currentReview, true)
    )).toBeNull();
  });

  it("requests a current executable validation instead of citing an older-run failure", () => {
    const changed = delta("delta");
    const oldFailure = failedValidation("old-failure", [changed.evidenceId], "old-run");
    expect(completionReceipt([changed, oldFailure])).toMatchObject({
      diagnostics: ["validation_evidence_required"],
      result: {
        missing: [{ requirement: "validation_executed", workspaceDeltaEvidenceId: changed.evidenceId }],
        nextActions: [{
          tool: "validate",
          arguments: { workspaceDeltaEvidenceIds: [changed.evidenceId] }
        }]
      }
    });
  });

  it("returns a structured, ID-free internal review repair path", async () => {
    const changed = delta("delta");
    const checked = validation("validation", [changed.evidenceId]);
    const active = session([changed, checked]);
    expect(reviewReadiness(active)).toMatchObject({
      pending: [{ evidenceId: changed.evidenceId }],
      eligible: [{ evidenceId: changed.evidenceId }],
      relevantValidations: [{ evidenceId: checked.evidenceId }]
    });
    const control = new RuntimeControlService({} as RuntimeControlServiceOptions).forSession(active);
    expect(await control.requestReview()).toEqual({
      status: "review_requested",
      workspaceDeltaEvidenceIds: [changed.evidenceId],
      validationEvidenceIds: [checked.evidenceId],
      missingValidationWorkspaceDeltaEvidenceIds: []
    });
    expect(completionReceipt([changed, checked])).toMatchObject({
      ok: false,
      diagnostics: ["review_evidence_required"],
      result: {
        status: "rejected",
        code: "review_evidence_required",
        missing: [{
          requirement: "review_approved",
          workspaceDeltaEvidenceId: changed.evidenceId,
          expectedEvidence: {
            kind: "review",
            status: "passed",
            verdict: "approved",
            claim: "acceptance_met"
          }
        }],
        nextActions: [{
          tool: "request_review",
          arguments: {},
          citeOnSuccess: {
            source: "next_current_run_evidence_ledger",
            kind: "review",
            status: "passed",
            verdict: "approved",
            claim: "acceptance_met",
            workspaceDeltaEvidenceIds: [changed.evidenceId]
          }
        }]
      }
    });
  });

  it("does not treat a non-approved review verdict as completed review", async () => {
    const changed = delta("delta");
    const checked = validation("validation", [changed.evidenceId]);
    const inconsistent = {
      ...failedReview("not-approved", [changed.evidenceId], "run", [checked.evidenceId]),
      status: "passed" as const
    };
    const readiness = reviewReadiness(session([changed, checked, inconsistent]));

    expect(readiness.pending.map((item) => item.evidenceId)).toEqual([changed.evidenceId]);
    expect(readiness.eligible.map((item) => item.evidenceId)).toEqual([changed.evidenceId]);
    expect(completionDiagnostic([changed, checked, inconsistent])).toBe("review_evidence_required");
  });

  it("surfaces review findings instead of pretending an identical review can be replayed", async () => {
    const changed = delta("delta");
    const checked = validation("validation", [changed.evidenceId]);
    const rejected = failedReview("review-failed", [changed.evidenceId], "run", [checked.evidenceId]);
    const active = session([changed, checked, rejected]);
    expect(reviewReadiness(active).blockedReview?.evidenceId)
      .toBe(rejected.evidenceId);
    const control = new RuntimeControlService({} as RuntimeControlServiceOptions).forSession(active);
    expect(await control.requestReview()).toMatchObject({
      status: "changes_required",
      reviewEvidenceId: rejected.evidenceId,
      findings: ["fix it"]
    });
    expect(completionReceipt([changed, checked, rejected])).toMatchObject({
      ok: false,
      diagnostics: ["review_evidence_required"],
      result: {
        missing: [{
          latestReview: {
            evidenceId: rejected.evidenceId,
            status: "failed",
            verdict: "changes_requested",
            findings: ["fix it"]
          }
        }],
        nextActions: [
          { action: "address_review_findings", reviewEvidenceId: rejected.evidenceId, findings: ["fix it"] },
          {
            tool: "validate",
            argumentsSource: {
              source: "post_repair_current_run_evidence_ledger",
              field: "workspaceDeltaEvidenceIds",
              selection: "all unresolved workspace deltas genuinely exercised by the validation command"
            }
          },
          {
            tool: "request_review",
            when: expect.stringContaining("retryable reviewer infrastructure or interruption failure")
          }
        ]
      }
    });
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

  it("issues repository acceptance only for broker-proved recovery targets in the current goal epoch", () => {
    const raw = repositoryDelta();
    const plan: ToolCallPlan = {
      exactEffects: ["repository.write"], readPaths: [], writePaths: [], network: "none",
      processMode: "pipe", checkpointScope: [], idempotence: "non_idempotent"
    };
    const transactionReceipt = {
      ...receipt("git-call"),
      actualEffects: ["repository.write"] as const,
      observedEffects: ["repository.write"] as const,
      evidence: [raw]
    };
    const frontier = {
      revision: 4,
      baselineManifestDigest: "0".repeat(64),
      currentStateDigest: "3".repeat(64),
      changedPaths: [],
      sourceCheckpointIds: []
    };
    const normalized = normalizeReceiptEvidence(transactionReceipt, "git_transaction", plan, {
      sessionId: "session",
      runId: "run",
      workspaceDeltas: [],
      repositoryScope: { goalEpoch: 7, frontier, mutationEvidence: [] }
    });
    const acceptance = normalized.evidence?.find((item) => item.kind === "repository_acceptance");
    expect(acceptance).toMatchObject({
      kind: "repository_acceptance",
      producer: { authority: "runtime", id: "git-call" },
      data: {
        goalEpoch: 7,
        frontierRevision: 5,
        selectionEvidenceId: "selection",
        candidateId: "e".repeat(64)
      }
    });

    const mismatched = repositoryDelta();
    mismatched.data.semanticAssertions!.targetAssertions!.selectedHead = "4".repeat(40);
    const rejected = normalizeReceiptEvidence({ ...transactionReceipt, evidence: [mismatched] },
      "git_transaction", plan, {
        sessionId: "session", runId: "run", workspaceDeltas: [],
        repositoryScope: { goalEpoch: 7, frontier, mutationEvidence: [] }
      });
    expect(rejected.evidence?.some((item) => item.kind === "repository_acceptance")).toBe(false);
  });

  it("clears evidence, waiver, receipts, and checkpoint head at a follow-up run boundary", () => {
    const active = session([waiver("waiver"), delta("delta")]);
    active.durable.state.checkpointHead = {
      checkpointId: "checkpoint", sessionId: "session", runId: "run", status: "sealed", createdAt: now,
      sealedAt: now, preManifestDigest: "a", postManifestDigest: "b"
    };
    beginNextRun(active, "change", 60_000);
    expect(active.durable.runId).not.toBe("run");
    expect(active.durable.state.evidence).toEqual([]);
    expect(active.durable.state.receipts).toEqual([]);
    expect(active.durable.state.checkpointHead).toBeUndefined();
  });

  it("retains unresolved mutation obligations across a follow-up run", () => {
    const changed = delta("old-delta", "src/pending.ts", "run");
    const active = session([changed]);
    active.durable.state.mutationEvidence = [changed];
    beginNextRun(active, "change", 60_000);
    active.durable.state.evidence = [{ ...proofEvidence(), runId: active.durable.runId }];
    expect(unresolvedWorkspaceDeltas(active).map((item) => item.evidenceId)).toEqual(["old-delta"]);
    expect(completionFailure(active, completionCall, completionDescriptor, now)?.diagnostics[0])
      .toBe("validation_evidence_required");

    const checked = validation("follow-up-validation", [changed.evidenceId], active.durable.runId);
    const approved = review("follow-up-review", [changed.evidenceId], active.durable.runId);
    active.durable.state.evidence.push(checked, approved);
    expect(unresolvedWorkspaceDeltas(active)).toEqual([]);
    expect(completionFailure(active, completionCall, completionDescriptor, now)).toBeNull();
  });

  it("reviews a failed delta together with its later repair instead of deadlocking", async () => {
    const original = delta("original");
    const repair = delta("repair", "src/code.ts", "repair-run");
    const active = session([repair, validation("repair-validation", ["repair"], "repair-run")]);
    active.durable.runId = "repair-run";
    active.durable.state.runId = "repair-run";
    active.durable.state.evidence[0] = { ...proofEvidence(), runId: "repair-run" };
    active.durable.state.mutationEvidence = [
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
      if (type === "review.completed") active.durable.state.evidence.push(value as ReviewEvidence);
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
      selectedSessionId = runtimeSession.identity.sessionId;
      return {
        review: async () => review("forged-review", ["unrelated-delta"], "old-run") as ReviewEvidence
      };
    }, async (runtimeSession, type, authority, value) => {
      emitted.push({ type, value });
      return {
        schemaVersion: 3,
        seq: ++seq,
        eventId: `event-${seq}`,
        sessionId: runtimeSession.identity.sessionId,
        runId: runtimeSession.durable.runId,
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

  it("retries a reviewer infrastructure failure only through an explicit review request", async () => {
    const changed = delta("delta");
    const checked = validation("validation", [changed.evidenceId]);
    const active = session([changed, checked]);
    let calls = 0;
    let seq = 1;
    const coordinator = new ReviewCoordinator({
      reviewerId: "transient-reviewer",
      review: async (input) => {
        calls += 1;
        if (calls === 1) throw new Error("temporary reviewer outage");
        return review(
          "approved-after-retry",
          input.workspaceDeltas.map((item) => item.evidenceId),
          input.runId
        ) as ReviewEvidence;
      }
    }, async (runtimeSession, type, authority, value) => {
      if (type === "review.completed") active.durable.state.evidence.push(value as ReviewEvidence);
      return {
        schemaVersion: 3,
        seq: ++seq,
        eventId: `event-${seq}`,
        sessionId: runtimeSession.identity.sessionId,
        runId: runtimeSession.durable.runId,
        occurredAt: now,
        type,
        authority,
        payload: value as JsonValue
      } as AgentEventEnvelope;
    });

    await coordinator.maybeReview(active, new AbortController().signal);
    const failed = active.durable.state.evidence.at(-1) as ReviewEvidence;
    expect(failed).toMatchObject({
      kind: "review",
      status: "failed",
      data: {
        verdict: "changes_requested",
        failureKind: "infrastructure",
        workspaceDeltaEvidenceIds: [changed.evidenceId],
        validationEvidenceIds: [checked.evidenceId]
      }
    });
    const retryReadiness = reviewReadiness(active);
    expect(retryReadiness.blockedReview).toBeUndefined();
    expect(retryReadiness.retryableReview?.evidenceId).toBe(failed.evidenceId);
    expect(completionReceipt([changed, checked, failed])).toMatchObject({
      diagnostics: ["review_evidence_required"],
      result: {
        nextActions: [{
          tool: "request_review",
          arguments: {},
          retryOfReviewEvidenceId: failed.evidenceId
        }]
      }
    });

    await coordinator.maybeReview(active, new AbortController().signal);
    expect(calls).toBe(1);
    const control = new RuntimeControlService({} as RuntimeControlServiceOptions).forSession(active);
    await expect(control.requestReview()).resolves.toMatchObject({
      status: "review_requested",
      retryOfReviewEvidenceId: failed.evidenceId
    });

    await coordinator.maybeReview(active, new AbortController().signal, true);
    expect(calls).toBe(2);
    expect(active.durable.state.evidence.at(-1)).toMatchObject({
      kind: "review",
      status: "passed",
      data: { verdict: "approved", workspaceDeltaEvidenceIds: [changed.evidenceId] }
    });
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
      if (type === "review.completed") active.durable.state.evidence.push(value as ReviewEvidence);
      return {
        schemaVersion: 3,
        seq: ++seq,
        eventId: `event-${seq}`,
        sessionId: runtimeSession.identity.sessionId,
        runId: runtimeSession.durable.runId,
        occurredAt: now,
        type,
        authority,
        payload: value as JsonValue
      } as AgentEventEnvelope;
    });

    await coordinator.maybeReview(active, new AbortController().signal);
    await coordinator.maybeReview(active, new AbortController().signal);
    expect(reviewCalls).toBe(1);
    expect((active.durable.state.evidence.at(-1) as ReviewEvidence).data.validationEvidenceIds)
      .toEqual([initialValidation.evidenceId]);

    const strongerValidation = validation("stronger-validation", [changed.evidenceId]);
    active.durable.state.evidence.push(strongerValidation);
    await coordinator.maybeReview(active, new AbortController().signal);
    await coordinator.maybeReview(active, new AbortController().signal);

    expect(reviewCalls).toBe(2);
    expect((active.durable.state.evidence.at(-1) as ReviewEvidence).data.validationEvidenceIds)
      .toEqual([initialValidation.evidenceId, strongerValidation.evidenceId]);
    expect((active.durable.state.evidence.at(-1) as ReviewEvidence).status).toBe("passed");
  });
});
