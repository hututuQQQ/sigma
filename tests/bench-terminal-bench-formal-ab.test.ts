import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FORMAL_AB_DATASET,
  FORMAL_AB_TASK_COUNT,
  formalAbSha256,
  formalTaskCatalogSha256,
  sigmaFormalABPreregistration,
  validateFormalABPreregistration
} from "../scripts/bench-terminal-bench-formal-ab-preregistration.mjs";
import { evaluateFormalABGate } from "../scripts/bench-terminal-bench-formal-ab-gate.mjs";
import {
  assertCandidateHarnessObserved,
  runFormalAB,
  validateCandidateFreezeManifest,
  validateSafetyValidationReport
} from "../scripts/bench-terminal-bench-formal-ab.mjs";
import { freezeSafetyValidationReport } from "../scripts/freeze-safety-validation-report.mjs";

const terminalRevision = "a".repeat(40);

function draft(safetyReportSha256 = "9".repeat(64)) {
  const tasks = Array.from({ length: FORMAL_AB_TASK_COUNT }, (_unused, index) => ({
    path: `tasks/task-${FORMAL_AB_TASK_COUNT - 1 - index}`,
    git_url: "https://example.test/terminal-bench.git",
    git_commit_id: terminalRevision,
    provenance_source: "frozen-catalog"
  }));
  return {
    formal_ab_id: "flagship-frozen-ab",
    arms: {
      baseline: {
        source_revision: "b".repeat(40),
        archive_sha256: "c".repeat(64),
        compiler_digest: null
      },
      candidate: {
        source_revision: "d".repeat(40),
        archive_sha256: "e".repeat(64),
        compiler_digest: "f".repeat(64)
      }
    },
    task_selection: {
      dataset: FORMAL_AB_DATASET,
      terminal_bench_revision: terminalRevision,
      catalog: {
        git_url: "https://example.test/terminal-bench.git",
        task_count: tasks.length,
        task_identity_sha256: formalTaskCatalogSha256(tasks)
      },
      tasks
    },
    controls: {
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoning_effort: "max",
      agent_profile: "standard",
      benchmark_class: "standard",
      k: 1,
      attempts: 1,
      retries: 0,
      concurrency: 5,
      max_turns: 200,
      network_mode: "full",
      execution_mode: "container",
      write_scope: "enclosing-container",
      managed_environment_mode: "required",
      harbor_topology: "managed_three_role",
      command_timeout_sec: 300,
      cleanup_grace_sec: 30
    },
    release_evidence: {
      candidate_freeze_manifest_sha256: "8".repeat(64),
      safety_report_sha256: safetyReportSha256
    }
  };
}

function safetyReport(manifest: ReturnType<typeof sigmaFormalABPreregistration>) {
  return {
    schemaVersion: 1,
    kind: "SigmaSafetyValidationReport",
    source_revision: manifest.arms.candidate.source_revision,
    candidate_archive_sha256: manifest.arms.candidate.archive_sha256,
    compiler_digest: manifest.arms.candidate.compiler_digest,
    checks: [
      "test", "typecheck", "lint", "package_verification", "harbor_smoke", "fairness_scan"
    ].map((id) => ({
      id,
      command: `pnpm ${id}`,
      status: "passed",
      evidence_sha256: formalAbSha256(`evidence:${id}`)
    }))
  };
}

function records(taskIndexes: readonly number[], candidateWins = 1) {
  return taskIndexes.flatMap((taskIndex, index) => [
    {
      task_index: taskIndex,
      arm: "baseline",
      passed: index < 8,
      infra_failure: false,
      timeout: false,
      cost_usd: 1
    },
    {
      task_index: taskIndex,
      arm: "candidate",
      passed: index < 8 + candidateWins,
      infra_failure: false,
      timeout: false,
      cost_usd: 1.05
    }
  ]);
}

describe("formal flagship Harness A/B", () => {
  it("freezes one model/config, hash-sorted tasks, disjoint stages, and alternating arms", () => {
    const manifest = sigmaFormalABPreregistration(draft());
    expect(manifest).toMatchObject({
      kind: "SigmaFormalABPreregistration",
      controls: {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoning_effort: "max",
        k: 1,
        attempts: 1,
        retries: 0,
        concurrency: 5,
        max_turns: 200
      }
    });
    expect(manifest.execution.canary_task_indexes).toEqual(
      Array.from({ length: 16 }, (_unused, index) => index)
    );
    expect(manifest.execution.remaining_task_indexes).toEqual(
      Array.from({ length: FORMAL_AB_TASK_COUNT - 16 }, (_unused, index) => index + 16)
    );
    expect(manifest.execution.arm_order.slice(0, 2)).toEqual([
      { task_index: 0, arms: ["baseline", "candidate"] },
      { task_index: 1, arms: ["candidate", "baseline"] }
    ]);
    expect(validateFormalABPreregistration(manifest)).toEqual(manifest);
    expect(() => validateFormalABPreregistration({
      ...manifest,
      execution: { ...manifest.execution, canary_task_indexes: [1, 0] }
    })).toThrow(/stale derived fields/u);
    expect(() => sigmaFormalABPreregistration({
      ...draft(),
      task_selection: {
        ...draft().task_selection,
        catalog: { ...draft().task_selection.catalog, task_count: FORMAL_AB_TASK_COUNT - 1 }
      }
    })).toThrow(/authoritative catalog/u);
  });

  it("accepts only a complete, passed safety report bound to the candidate", () => {
    const manifest = sigmaFormalABPreregistration(draft());
    const report = safetyReport(manifest);
    expect(validateSafetyValidationReport(report, manifest)).toEqual(report);
    expect(() => validateSafetyValidationReport({
      ...report,
      checks: report.checks.filter((check) => check.id !== "harbor_smoke")
    }, manifest)).toThrow(/every required check/u);
    expect(() => validateSafetyValidationReport({
      ...report,
      candidate_archive_sha256: "0".repeat(64)
    }, manifest)).toThrow(/frozen candidate/u);
  });

  it("hashes successful validation evidence and binds a candidate freeze manifest", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-safety-freeze-"));
    const manifest = sigmaFormalABPreregistration(draft());
    const ids = [
      "test", "typecheck", "lint", "package_verification", "harbor_smoke", "fairness_scan"
    ];
    for (const id of ids) await writeFile(path.join(directory, `${id}.log`), `${id} passed\n`, "utf8");
    const report = await freezeSafetyValidationReport({
      source_revision: manifest.arms.candidate.source_revision,
      candidate_archive_sha256: manifest.arms.candidate.archive_sha256,
      compiler_digest: manifest.arms.candidate.compiler_digest,
      checks: ids.map((id) => ({
        id,
        command: `pnpm ${id}`,
        exit_code: 0,
        evidence_file: `${id}.log`
      }))
    }, { baseDir: directory });
    expect(report.checks).toHaveLength(6);
    const inspectionSha256 = "1".repeat(64);
    const candidateFreeze = {
      schemaVersion: 1,
      kind: "SigmaFlagshipCandidateFreeze",
      createdAt: "2026-08-07T00:00:00.000Z",
      source: {
        revision: manifest.arms.candidate.source_revision,
        tree: "2".repeat(40),
        clean: true,
        pnpmLockSha256: "3".repeat(64)
      },
      subject: {
        provider: manifest.controls.provider,
        model: manifest.controls.model,
        reasoningEffort: manifest.controls.reasoning_effort,
        profile: manifest.controls.agent_profile,
        runMode: "change"
      },
      artifact: {
        name: "agent-cli-linux-x64.tgz",
        bytes: 123,
        sha256: manifest.arms.candidate.archive_sha256
      },
      harness: {
        compilerVersion: "1.0.0",
        digest: manifest.arms.candidate.compiler_digest,
        inspectionSha256,
        tokens: {
          tokenizer: "approximate",
          countMethod: "gateway.countTokens",
          mandatoryPromptTokens: 100,
          initialToolSchemaTokens: 200,
          combinedTokens: 300,
          mandatoryPromptBytes: 400,
          initialToolSchemaBytes: 800
        }
      },
      safety: { reportSha256: manifest.release_evidence.safety_report_sha256 }
    };
    expect(validateCandidateFreezeManifest(candidateFreeze, manifest, {
      inspectionSha256
    })).toEqual(candidateFreeze);
  });

  it("enforces canary and release gates from paired aggregate records", () => {
    const manifest = sigmaFormalABPreregistration(draft());
    const canary = evaluateFormalABGate(
      manifest,
      "canary",
      records(manifest.execution.canary_task_indexes)
    );
    expect(canary).toMatchObject({
      status: "passed",
      candidate_lifecycle: "frozen_continue",
      paired: { wins: 1, losses: 0 }
    });
    const allIndexes = [
      ...manifest.execution.canary_task_indexes,
      ...manifest.execution.remaining_task_indexes
    ];
    const releaseRecords = records(allIndexes, 3);
    const released = evaluateFormalABGate(manifest, "release", releaseRecords, {
      safetyPassed: true,
      fairnessPassed: true
    });
    expect(released).toMatchObject({ status: "passed", candidate_lifecycle: "released" });
    const unsafe = evaluateFormalABGate(manifest, "release", releaseRecords, {
      safetyPassed: false,
      fairnessPassed: true
    });
    expect(unsafe.failure_reasons).toContain("safety_or_fairness");
  });

  it("binds the observed root session Harness while ignoring child-session digests", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-formal-ab-trace-"));
    const traceDirectory = path.join(directory, "tasks", "one");
    await mkdir(traceDirectory, { recursive: true });
    const expected = "f".repeat(64);
    const child = "1".repeat(64);
    const records = [
      { sigma_event: { type: "session.created", sessionId: "root", payload: {} } },
      { sigma_event: { type: "harness.compiled", authority: "runtime", sessionId: "root", payload: { digest: expected } } },
      { sigma_event: { type: "session.created", sessionId: "child", payload: { parentSessionId: "root" } } },
      { sigma_event: { type: "harness.compiled", authority: "runtime", sessionId: "child", payload: { digest: child } } }
    ];
    await writeFile(path.join(traceDirectory, "trace.jsonl"),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
    await expect(assertCandidateHarnessObserved(
      { runDir: directory }, expected, false
    )).resolves.toBeUndefined();
    await expect(assertCandidateHarnessObserved(
      { runDir: directory }, "2".repeat(64), false
    )).rejects.toThrow(/outside the preregistration/u);
  });

  it("consumes every canary arm once and publishes only its aggregate gate", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-formal-ab-"));
    const manifest = sigmaFormalABPreregistration(draft(), { baseDir: directory });
    const preregistration = path.join(directory, "preregistration.json");
    const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(preregistration, bytes, "utf8");
    const calls: Array<{ arm: string; taskIndex: number }> = [];
    const result = await runFormalAB([
      "--preregistration-file", preregistration,
      "--expected-preregistration-sha256", formalAbSha256(bytes),
      "--stage", "canary",
      "--output", path.join(directory, "output"),
      "--baseline-archive", path.join(directory, "baseline.tgz"),
      "--candidate-archive", path.join(directory, "candidate.tgz"),
      "--candidate-inspection-file", path.join(directory, "inspection.json"),
      "--candidate-freeze-manifest", path.join(directory, "candidate-freeze.json")
    ], {
      assertFrozenInputs: async () => undefined,
      assertCandidateHarnessObserved: async () => undefined,
      packageHarborRuntime: async () => ({ exitCode: 0, harborRuntimeDir: directory }),
      runArm: async (_args: string[], arm: string, taskIndex: number) => {
        calls.push({ arm, taskIndex });
        const passed = arm === "candidate" ? taskIndex < 9 : taskIndex < 8;
        return {
          // The outer runner may return non-zero for an ordinary verifier miss;
          // the sealed A/B must not relabel that as infrastructure failure.
          exitCode: passed ? 0 : 1,
          runDir: path.join(directory, `${taskIndex}-${arm}`),
          report: {
            effective_correctness: { passed: passed ? 1 : 0, total: 1 },
            counts: { passed: passed ? 1 : 0, infra_failed: 0, timeout: 0 },
            infra_status: "passed",
            cost_usd: 1
          }
        };
      }
    });
    expect(result.gate.status).toBe("passed");
    expect(result.gate.baseline.infra_failures).toBe(0);
    expect(result.gate.candidate.infra_failures).toBe(0);
    expect(calls).toHaveLength(32);
    expect(new Set(calls.map((call) => `${call.taskIndex}:${call.arm}`)).size).toBe(32);
    const publicGate = JSON.parse(await readFile(
      path.join(directory, "output", "canary-gate.json"), "utf8"
    ));
    expect(publicGate).not.toHaveProperty("tasks");
    await expect(readFile(
      path.join(directory, "output", "frozen-preregistration.json"), "utf8"
    )).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(
      path.join(directory, "output", "evaluation-vault", "frozen-preregistration.json"),
      "utf8"
    )).resolves.toContain("SigmaFormalABPreregistration");
    await expect(runFormalAB([
      "--preregistration-file", preregistration,
      "--expected-preregistration-sha256", formalAbSha256(bytes),
      "--stage", "canary",
      "--output", path.join(directory, "output"),
      "--baseline-archive", path.join(directory, "baseline.tgz"),
      "--candidate-archive", path.join(directory, "candidate.tgz"),
      "--candidate-inspection-file", path.join(directory, "inspection.json"),
      "--candidate-freeze-manifest", path.join(directory, "candidate-freeze.json")
    ], { assertFrozenInputs: async () => undefined })).rejects.toThrow(/already consumed/u);
  });
});
