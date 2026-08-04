import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createKernelState } from "../packages/agent-kernel/src/index.js";
import type {
  EvidenceRecord,
  ModelToolCall,
  ToolCallPlan,
  ToolDescriptor,
  ToolReceipt,
  ValidationEvidence
} from "../packages/agent-protocol/src/index.js";
import { completionFailure } from "../packages/agent-runtime/src/effect-helpers.js";
import { completionGateDecision } from "../packages/agent-runtime/src/completion-evidence-gate.js";
import { assuranceRequirement, validationClaimSatisfies } from "../packages/agent-runtime/src/assurance-engine.js";
import { evidenceLedger } from "../packages/agent-runtime/src/model-evidence-ledger.js";
import {
  assertTransactionIsolationPlanAllowed,
  assertReceiptWithinPlan,
  validationScope
} from "../packages/agent-runtime/src/tool-plan-enforcement.js";
import { reviewReadiness } from "../packages/agent-runtime/src/review-coordinator.js";
import {
  currentFrontierValidationStatus,
  frontierValidationReadiness
} from "../packages/agent-runtime/src/mutation-evidence.js";
import type { RuntimeSession } from "../packages/agent-runtime/src/types.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

const now = "2026-01-01T00:00:00.000Z";

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

describe("assurance-coordinated mutation completion", () => {
  it("requires active review for an environment-only mutation frontier", () => {
    const active = session([]);
    const environment: EvidenceRecord = {
      evidenceId: "environment-change",
      sessionId: "session",
      runId: "run",
      kind: "diagnostic",
      status: "passed",
      createdAt: now,
      producer: { authority: "tool", id: "exec" },
      summary: "container path changed",
      data: {
        source: "enclosing_container_mutation",
        diagnostic: {
          schemaVersion: 1,
          scope: "enclosing_container",
          callId: "exec",
          declaredPaths: ["/etc/example.conf"],
          resultDigest: "b".repeat(64),
          ok: true,
          effects: ["filesystem.write"]
        }
      }
    };
    active.durable.state.evidence.push(environment);
    active.durable.state.mutationEvidence.push(environment);
    active.durable.state.mutationFrontier = {
      revision: 1,
      baselineManifestDigest: "0".repeat(64),
      currentStateDigest: "b".repeat(64),
      changedPaths: [],
      environmentChangedPaths: ["/etc/example.conf"],
      sourceCheckpointIds: []
    };

    expect(reviewReadiness(active, "completion")).toMatchObject({
      pending: [],
      eligible: [],
      environmentMutations: [
        expect.objectContaining({ evidenceId: "environment-change" })
      ]
    });
    expect(evidenceLedger(active).content).toContain(
      "enclosing-container changed paths: 1"
    );
  });

  it("does not carry a broad reviewer waiver into current explicit-review readiness", () => {
    const active = session([]);
    const environment: EvidenceRecord = {
      evidenceId: "current-environment-change",
      sessionId: "session",
      runId: "run",
      kind: "diagnostic",
      status: "passed",
      createdAt: now,
      producer: { authority: "tool", id: "exec" },
      summary: "container path changed",
      data: {
        source: "enclosing_container_mutation",
        diagnostic: {
          schemaVersion: 1,
          scope: "enclosing_container",
          callId: "exec",
          declaredPaths: ["/etc/example.conf"],
          resultDigest: "c".repeat(64),
          ok: true,
          effects: ["filesystem.write"]
        }
      }
    };
    active.durable.state.mutationEvidence.push(
      waiver("prior-run-waiver", "prior-run"),
      environment
    );
    active.durable.state.mutationFrontier = {
      revision: 1,
      baselineManifestDigest: "0".repeat(64),
      currentStateDigest: "c".repeat(64),
      changedPaths: [],
      environmentChangedPaths: ["/etc/example.conf"],
      sourceCheckpointIds: []
    };

    expect(reviewReadiness(active, "completion").environmentMutations)
      .toContainEqual(expect.objectContaining({ evidenceId: "current-environment-change" }));
    expect(completionGateDecision(active)).toMatchObject({
      action: "continue",
      message: expect.stringContaining("has not been validated")
    });
  });

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

  it("derives authoritative coverage from model-declared subjects, not command syntax or read roots", () => {
    const active = frontierSession();
    const scope = validationScope(active, {
      id: "validate", name: "validate", arguments: {
        executable: "tsc",
        args: ["--noEmit"],
        purpose: "Check the changed source.",
        subjects: ["src/code.ts"],
        criterionIds: ["source-check"]
      }
    }, { ...validationPlan, readPaths: ["docs"] });
    expect(scope).toMatchObject({
      frontierRevision: 4,
      stateDigest: "a".repeat(64),
      coveredPaths: ["src/code.ts"],
      intent: {
        purpose: "Check the changed source.",
        subjects: ["src/code.ts"],
        criterionIds: ["source-check"]
      },
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
      arguments: {
        executable: "cargo",
        args: ["+stable", "test", "--locked"],
        subjects: ["native/sigma-exec/src/main.rs"]
      }
    }, validationPlan);
    expect(unit).toMatchObject({
      coveredPaths: ["native/sigma-exec/src/main.rs"],
      claim: { kind: "unit" }
    });
    const acceptance = validationScope(active, {
      id: "cargo-build", name: "validate",
      arguments: {
        executable: "cargo",
        args: ["build", "--locked"],
        subjects: ["."]
      }
    }, validationPlan);
    expect(acceptance).toMatchObject({
      coveredPaths: ["native/sigma-exec/src/main.rs", "docs/readme.md"],
      claim: { kind: "acceptance" }
    });
  });

  it("binds direct compiler acceptance to the source files named by the command", () => {
    const active = frontierSession();
    active.durable.state.mutationFrontier.changedPaths = [
      "proofs/theorem.v",
      "proofs/.theorem.aux",
      "proofs/theorem.glob",
      "proofs/theorem.vo",
      "proofs/theorem.vok",
      "proofs/theorem.vos",
      "src/program.cbl",
      "program",
      "docs/readme.md"
    ];

    expect(validationScope(active, {
      id: "coq-compile", name: "validate",
      arguments: {
        shell: "bash",
        command: "/usr/bin/coqc -q proofs/theorem.v 2>&1",
        subjects: ["proofs"]
      }
    }, validationPlan)).toMatchObject({
      coveredPaths: [
        "proofs/theorem.v",
        "proofs/.theorem.aux",
        "proofs/theorem.glob",
        "proofs/theorem.vo",
        "proofs/theorem.vok",
        "proofs/theorem.vos"
      ],
      claim: {
        kind: "acceptance",
        subject: {
          exactFiles: [
            "proofs/.theorem.aux",
            "proofs/theorem.glob",
            "proofs/theorem.v",
            "proofs/theorem.vo",
            "proofs/theorem.vok",
            "proofs/theorem.vos"
          ]
        }
      }
    });
    expect(validationScope(active, {
      id: "cobol-compile", name: "validate",
      arguments: {
        executable: "cobc",
        args: ["-x", "-o", "program", "src/program.cbl"],
        subjects: ["src/program.cbl", "program"]
      }
    }, validationPlan)).toMatchObject({
      coveredPaths: ["src/program.cbl", "program"],
      claim: {
        kind: "acceptance",
        subject: { exactFiles: ["program", "src/program.cbl"] }
      }
    });
    expect(validationScope(active, {
      id: "compiler-version", name: "validate",
      arguments: { executable: "coqc", args: ["--version"] }
    }, validationPlan)).toMatchObject({
      coveredPaths: [],
      claim: { kind: "probe", subject: { exactFiles: [] } }
    });
  });

  it("treats a transitive document build with environment prefixes as project acceptance", () => {
    const active = frontierSession();
    active.durable.state.mutationFrontier.changedPaths = [
      "main.tex", "chapters/input.tex"
    ];

    expect(validationScope(active, {
      id: "document-build", name: "validate",
      arguments: {
        shell: "bash",
        command: "TEXMFVAR=/tmp/tex-var TEXMFCONFIG=/tmp/tex-config pdflatex -interaction=nonstopmode main.tex",
        subjects: ["."]
      }
    }, validationPlan)).toMatchObject({
      coveredPaths: ["main.tex", "chapters/input.tex"],
      claim: {
        kind: "acceptance",
        subject: { projectId: ".", exactFiles: [] }
      }
    });
  });

  it("binds strict shell comparison tests to the source programs they execute", () => {
    const active = frontierSession();
    active.durable.state.mutationFrontier.changedPaths = [
      "program.py", "reference.py", "notes.txt"
    ];

    expect(validationScope(active, {
      id: "behavior-comparison", name: "validate",
      arguments: {
        shell: "bash",
        command: [
          "cd .",
          "python3 program.py > /tmp/actual",
          "python3 reference.py > /tmp/expected",
          "diff /tmp/actual /tmp/expected",
          "echo PASS"
        ].join(" && "),
        subjects: ["program.py", "reference.py"]
      }
    }, validationPlan)).toMatchObject({
      coveredPaths: ["program.py", "reference.py"],
      claim: {
        kind: "unit",
        subject: { exactFiles: ["program.py", "reference.py"] }
      }
    });
  });

  it("does not trust shell comparisons whose failure is explicitly masked", () => {
    const active = frontierSession();
    active.durable.state.mutationFrontier.changedPaths = ["program.py"];

    for (const command of [
      "python3 program.py > /tmp/actual && diff /tmp/actual /tmp/expected || echo FAIL",
      "python3 program.py > /tmp/actual && diff /tmp/actual /tmp/expected | cat"
    ]) {
      expect(validationScope(active, {
        id: "masked-comparison", name: "validate",
        arguments: { shell: "bash", command }
      }, validationPlan)).toMatchObject({
        coveredPaths: [],
        claim: { kind: "probe", subject: { exactFiles: [] } }
      });
    }
  });

  it("does not infer tests from shell arguments or failure-masked commands", () => {
    const active = frontierSession();
    active.durable.state.mutationFrontier.changedPaths = ["program.py"];

    for (const command of ["echo pytest", "pytest || true", "pytest | cat"]) {
      expect(validationScope(active, {
        id: "masked-test", name: "validate",
        arguments: { shell: "bash", command }
      }, validationPlan)).toMatchObject({
        coveredPaths: [],
        claim: { kind: "probe", subject: { exactFiles: [] } }
      });
    }
    expect(validationScope(active, {
      id: "strict-test", name: "validate",
      arguments: {
        shell: "bash",
        command: "cd . && pytest tests/test_program.py && echo PASS",
        subjects: ["program.py"]
      }
    }, validationPlan)).toMatchObject({
      coveredPaths: ["program.py"],
      claim: { kind: "unit" }
    });
  });

  it("recognizes structured Python syntax checks but not inline source text", () => {
    const active = frontierSession();
    active.durable.state.mutationFrontier.changedPaths = ["program.py"];

    expect(validationScope(active, {
      id: "python-syntax", name: "validate",
      arguments: {
        executable: "/usr/bin/python3",
        args: ["-m", "py_compile", "program.py"],
        subjects: ["program.py"]
      }
    }, validationPlan)).toMatchObject({
      coveredPaths: ["program.py"],
      claim: {
        kind: "syntax",
        subject: { exactFiles: ["program.py"] }
      }
    });
    for (const script of [
      "print('assert')",
      "print(\"py_compile.compile('program.py')\")",
      "# assert program behavior"
    ]) {
      expect(validationScope(active, {
        id: "python-inline", name: "validate",
        arguments: { executable: "/usr/bin/python3", args: ["-c", script] }
      }, validationPlan)).toMatchObject({
        coveredPaths: [],
        claim: { kind: "probe", subject: { exactFiles: [] } }
      });
    }
  });

  it("recognizes direct Node test and check runners as semantic validation", () => {
    const active = frontierSession();
    active.durable.state.mutationFrontier.changedPaths = ["src/code.mjs", "config.json"];

    expect(validationScope(active, {
      id: "node-test", name: "validate",
      arguments: {
        executable: "node",
        args: ["--test", "tests/code.test.mjs"],
        subjects: ["src/code.mjs"]
      }
    }, validationPlan)).toMatchObject({
      coveredPaths: ["src/code.mjs"],
      claim: { kind: "unit", subject: { selectedTests: ["tests/code.test.mjs"] } }
    });
    expect(validationScope(active, {
      id: "node-check-script", name: "validate",
      arguments: { executable: "node", args: ["check.mjs"], subjects: ["."] }
    }, validationPlan)).toMatchObject({
      coveredPaths: ["src/code.mjs", "config.json"],
      claim: { kind: "acceptance" }
    });
  });

  it("gives falsifiable inline Node assertions exact-file coverage only", () => {
    const active = frontierSession();
    active.durable.state.mutationFrontier.changedPaths = [
      "src/app.mjs", "config.json", "docs/unrelated.md"
    ];

    const source = validationScope(active, {
      id: "inline-source", name: "validate",
      arguments: {
        executable: "node",
        args: ["-e", "import('./src/app.mjs').then(m => { if (!m.ok) process.exit(1); })"],
        subjects: ["src/app.mjs"]
      }
    }, validationPlan);
    expect(source).toMatchObject({
      coveredPaths: ["src/app.mjs"],
      claim: { kind: "unit", subject: { exactFiles: ["src/app.mjs"] } }
    });

    const config = validationScope(active, {
      id: "inline-config", name: "validate",
      arguments: {
        executable: "node",
        args: ["--eval", "const c=JSON.parse(readFileSync('config.json','utf8')); if (!c.ok) throw new Error('bad')"],
        subjects: ["config.json"]
      }
    }, validationPlan);
    expect(config).toMatchObject({
      coveredPaths: ["config.json"],
      claim: { kind: "acceptance", subject: { exactFiles: ["config.json"] } }
    });

    const observation = validationScope(active, {
      id: "inline-observation", name: "validate",
      arguments: {
        executable: "node",
        args: ["-e", "console.log(readFileSync('config.json','utf8'))"]
      }
    }, validationPlan);
    expect(observation).toMatchObject({ coveredPaths: [], claim: { kind: "probe" } });

    const unrelated = validationScope(active, {
      id: "inline-unrelated", name: "validate",
      arguments: {
        executable: "node",
        args: ["-e", "const c=readFileSync('not-changed.json','utf8'); if (!c) process.exit(1)"]
      }
    }, validationPlan);
    expect(unrelated).toMatchObject({
      coveredPaths: [],
      claim: { kind: "acceptance", subject: { exactFiles: ["not-changed.json"] } }
    });
  });

  it("shows goal-derived command classification only as model-visible telemetry", () => {
    const active = frontierSession();
    active.durable.state.plan = {
      ...active.durable.state.plan,
      goal: "Update service.mjs, then run `node check.mjs` and report the result."
    };
    active.durable.state.mutationFrontier.changedPaths = ["service.mjs"];

    expect(assuranceRequirement(active)).toMatchObject({ requiredClaims: ["acceptance"] });
    expect(evidenceLedger(active).content).toContain(
      "telemetry-only inferred validation claim gaps: acceptance"
    );

    active.durable.state.plan = {
      ...active.durable.state.plan,
      goal: "Update service.mjs, then run `node checker.mjs`."
    };
    expect(assuranceRequirement(active)).toMatchObject({ requiredClaims: ["unit"] });
  });

  it("turns recognized Node validation into current-frontier readiness", () => {
    const active = frontierSession();
    active.durable.state.mutationFrontier.changedPaths = ["src/code.mjs"];
    const scope = validationScope(active, {
      id: "node-test", name: "validate",
      arguments: {
        executable: "node",
        args: ["--test", "tests/code.test.mjs"],
        subjects: ["src/code.mjs"]
      }
    }, validationPlan)!;
    active.durable.state.evidence.push({
      evidenceId: "node-test-evidence",
      sessionId: "session",
      runId: "run",
      kind: "validation",
      status: "passed",
      createdAt: now,
      producer: { authority: "tool", id: "node-test" },
      summary: "tests passed",
      data: {
        validator: "command",
        command: "node --test tests/code.test.mjs",
        exitCode: 0,
        artifactIds: [],
        frontierRevision: scope.frontierRevision,
        stateDigest: scope.stateDigest,
        coveredPaths: scope.coveredPaths,
        claim: { ...scope.claim, status: "passed" }
      }
    });

    expect(frontierValidationReadiness(active)).toMatchObject({
      ready: true,
      coveredPaths: ["src/code.mjs"],
      missingClaims: []
    });
  });

  it("keeps failed validation as current-frontier status without a hidden completion tool", () => {
    const active = frontierSession();
    active.durable.state.plan = {
      ...active.durable.state.plan,
      goal: "Update service.mjs, then run `node check.mjs` and report the result."
    };
    active.durable.state.mutationFrontier.changedPaths = ["service.mjs"];
    const scope = validationScope(active, {
      id: "node-check", name: "validate",
      arguments: {
        executable: "node",
        args: ["check.mjs"],
        subjects: ["service.mjs"]
      }
    }, validationPlan)!;
    active.durable.state.evidence.push({
      evidenceId: "node-check-failed",
      sessionId: "session",
      runId: "run",
      kind: "validation",
      status: "failed",
      createdAt: now,
      producer: { authority: "tool", id: "node-check" },
      summary: "check failed",
      data: {
        validator: "command",
        command: "node check.mjs",
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
        frontierRevision: scope.frontierRevision,
        stateDigest: scope.stateDigest,
        coveredPaths: scope.coveredPaths,
        claim: { ...scope.claim, status: "failed" }
      }
    });

    const call: ModelToolCall = {
      id: "runtime_completion_intent_failed-check",
      name: "runtime_finalize",
      arguments: { summary: "The requested check failed." }
    };
    expect(frontierValidationReadiness(active)).toMatchObject({
      ready: false,
      executionReady: true,
      missingClaims: ["acceptance"],
      latestFailed: { evidenceId: "node-check-failed" }
    });
    expect(currentFrontierValidationStatus(active)).toMatchObject({
      hasRecord: true,
      passed: false,
      latestFailed: { evidenceId: "node-check-failed" }
    });
    expect(completionFailure(active, call, {
      possibleEffects: ["outcome.propose"]
    } as ToolDescriptor, now)).toMatchObject({
      ok: false,
      diagnostics: ["internal_tool_denied"]
    });
  });

  it("reports a test-path unit expectation as non-binding telemetry", () => {
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
      arguments: {
        executable: "node",
        args: ["--check", "src/code.ts"],
        subjects: ["src/code.ts"]
      }
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
      arguments: {
        executable: "node",
        args: ["--check", "provider-smoke.js"],
        subjects: ["provider-smoke.js"]
      }
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
      missingPaths: ["src/code.ts", "docs/readme.md"]
    });
  });

  it("does not let custom languages or compound shell syntax erase model-declared subjects", () => {
    const active = frontierSession();
    active.durable.state.mutationFrontier.changedPaths = [
      "solver/main.scm",
      "scripts/check-output"
    ];
    for (const command of [
      "scheme solver/main.scm | tee /tmp/result",
      "bash -c 'diff <(scheme solver/main.scm) <(cat scripts/check-output)'"
    ]) {
      expect(validationScope(active, {
        id: `custom-${command.length}`,
        name: "validate",
        arguments: {
          shell: "bash",
          command,
          purpose: "Check the declared custom-language behavior.",
          subjects: ["solver/main.scm", "scripts/check-output"],
          criterionIds: ["custom-behavior"]
        }
      }, validationPlan)).toMatchObject({
        coveredPaths: ["solver/main.scm", "scripts/check-output"],
        intent: {
          purpose: "Check the declared custom-language behavior.",
          subjects: ["solver/main.scm", "scripts/check-output"],
          criterionIds: ["custom-behavior"]
        }
      });
    }
  });

  it("never re-enables the removed completion tool based on validation state", () => {
    const active = frontierSession();
    const call: ModelToolCall = { id: "runtime_completion_intent_test", name: "runtime_finalize", arguments: { summary: "done" } };
    const descriptor = { possibleEffects: ["outcome.propose"] } as ToolDescriptor;
    expect(completionFailure(active, call, descriptor, now)).toMatchObject({
      ok: false,
      diagnostics: ["internal_tool_denied"]
    });
    active.durable.state.evidence.push(
      frontierValidation("code", ["src/code.ts"]),
      frontierValidation("docs", ["docs/readme.md"])
    );
    expect(completionFailure(active, call, descriptor, now)).toMatchObject({
      ok: false,
      diagnostics: ["internal_tool_denied"]
    });
  });

  it("keeps input-access evidence as facts without creating a completion obligation", () => {
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
      diagnostics: ["internal_tool_denied"]
    });
    target.durable.state.evidence.push(inputAccess("required-passed", "passed", requiredPath, "external"));
    expect(completionFailure(target, call, descriptor, now)).toMatchObject({
      ok: false,
      diagnostics: ["internal_tool_denied"]
    });
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

  it("allows only checkpointed workspace paths in a mixed enclosing-container plan", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-hybrid-plan-"));
    await mkdir(path.join(workspace, "src"));
    const active = runtimeSessionFixture({ workspacePath: workspace });
    const plan: ToolCallPlan = {
      exactEffects: ["process.spawn", "filesystem.write"],
      readPaths: [".", path.parse(path.resolve(workspace)).root],
      writePaths: [
        path.parse(path.resolve(workspace)).root,
        "src/generated.txt"
      ],
      network: "none",
      processMode: "pipe",
      checkpointScope: [
        path.parse(path.resolve(workspace)).root,
        "src"
      ],
      mutationAuthority: "disposable_enclosing_container",
      idempotence: "non_replayable"
    };
    const receipt = (changed: string): ToolReceipt => ({
      callId: "hybrid",
      ok: true,
      output: "changed",
      observedEffects: ["process.spawn", "filesystem.write"],
      actualEffects: ["process.spawn", "filesystem.write"],
      artifacts: [],
      diagnostics: [],
      evidence: [],
      startedAt: now,
      completedAt: now,
      workspaceDelta: { added: [changed], modified: [], deleted: [] }
    });

    await expect(assertReceiptWithinPlan(
      active,
      receipt("src/generated.txt"),
      plan
    )).resolves.toBeUndefined();
    await expect(assertReceiptWithinPlan(
      active,
      receipt("src/unexpected.txt"),
      plan
    )).rejects.toMatchObject({ code: "effect_plan_violation" });
  });
});

describe("model-owned review repair planning", () => {
  function repairPlan(writePaths: string[]): ToolCallPlan {
    return {
      exactEffects: ["filesystem.write"], readPaths: [], writePaths,
      network: "none", processMode: "none", checkpointScope: writePaths,
      idempotence: "non_replayable"
    };
  }

  it("does not turn reviewer findings into a runtime write-scope obligation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-review-repair-plan-"));
    await mkdir(path.join(workspace, "src"));
    const active = runtimeSessionFixture({ workspacePath: workspace });
    await expect(assertTransactionIsolationPlanAllowed(active, repairPlan(["src/target.ts"])))
      .resolves.toBeUndefined();
    await expect(assertTransactionIsolationPlanAllowed(active, repairPlan(["src/other.ts"])))
      .resolves.toBeUndefined();
  });

  it("does not require a synthetic repair target in the effect plan", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-review-repair-empty-plan-"));
    const active = runtimeSessionFixture({ workspacePath: workspace });
    await expect(assertTransactionIsolationPlanAllowed(active, repairPlan([])))
      .resolves.toBeUndefined();
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
