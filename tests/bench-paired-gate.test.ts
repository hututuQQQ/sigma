import { describe, expect, it } from "vitest";
import { benchmarkPlanFileSha256, evaluateBenchmarkPair } from "../scripts/bench-paired-gate.mjs";
import { createBenchmarkSamplePlan } from "../scripts/bench-sample-plan.mjs";

const baselineArchiveSha256 = "a".repeat(64);
const candidateArchiveSha256 = "b".repeat(64);
const validationManifestSha256 = "c".repeat(64);
const sourceRevision = "d".repeat(40);
const terminalBenchRevision = "e".repeat(40);
const requiredChecks = [
  "unit", "property", "protocol", "typecheck", "lint", "nativeBroker", "package",
  "containment", "fairness", "ociMatrix", "harborCanary"
];

function plan() {
  const difficulties = ["easy", "easy", ...Array(6).fill("medium"), ...Array(4).fill("hard")];
  return {
    ...createBenchmarkSamplePlan({
      schemaVersion: 1,
      tasks: difficulties.map((difficulty, index) => ({
        difficulty,
        path: `tasks/task-${index}`,
        git_url: "https://example.test/frozen-suite.git",
        git_commit_id: terminalBenchRevision,
        source: "terminal-bench"
      }))
    }, { seed: "paired-gate-test", quotas: { easy: 2, medium: 6, hard: 4 }, createdAt: "2026-01-01T00:00:00.000Z" }),
    controls: {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      dataset: "terminal-bench/terminal-bench-2",
      agentProfile: "standard",
      evaluationLane: "solving",
      networkMode: "none",
      containerEngine: "docker",
      containerTarget: "managed",
      concurrency: 2,
      maxTurns: 200,
      commandTimeoutSec: 180,
      benchmarkClass: "standard",
      attemptsPerArm: 1,
      retries: 0,
      baselineExecutionMode: "sandboxed",
      candidateExecutionMode: "container",
      baselineManagedProvenance: true,
      candidateManagedProvenance: true,
      baselineHarborTopology: "managed_three_role",
      candidateHarborTopology: "managed_three_role",
      terminalBenchRevision,
      sourceRevision,
      baselineArchiveSha256,
      candidateArchiveSha256,
      validationManifestSha256,
      modelParameters: { temperature: "provider_default", top_p: "provider_default" },
      timeoutPolicy: "harbor_task_metadata_minus_cleanup_grace",
      cleanupGraceSec: 120
    }
  };
}

function validationManifest() {
  return {
    schemaVersion: 1,
    kind: "sigma.validation-manifest",
    sourceRevision,
    candidateArchiveSha256,
    checks: Object.fromEntries(requiredChecks.map((name) => [name, { status: "passed", evidence: `${name}: ok` }]))
  };
}

function report(frozen: ReturnType<typeof plan>, reached: number, passed: number, candidate = false) {
  const preregistrationSha256 = benchmarkPlanFileSha256(frozen);
  return {
    status: "failed",
    score_status: "failed",
    incomplete_reason: null,
    provider: "deepseek",
    model: "deepseek-v4-pro",
    model_parameters: frozen.controls.modelParameters,
    dataset: frozen.controls.dataset,
    terminal_bench_revision: terminalBenchRevision,
    source_revision: sourceRevision,
    agent_cli_sha256: candidate ? candidateArchiveSha256 : baselineArchiveSha256,
    agent_profile: "standard",
    evaluation_lane: "solving",
    tasks_file_sha256: frozen.tasksFileSha256,
    execution_mode: candidate ? "container" : "sandboxed",
    managed_provenance: true,
    harbor_topology: "managed_three_role",
    execution_backend: candidate ? "oci:docker" : "sandbox:bwrap",
    container_engine: "docker",
    container_target: "managed",
    container_engine_requested: "docker",
    network_mode: "none",
    n_concurrent_trials: 2,
    max_turns: 200,
    command_timeout_sec: 180,
    benchmark_class: "standard",
    timeout_plan: { policy: "fixed-test" },
    preregistration_sha256: preregistrationSha256,
    validation_manifest_sha256: validationManifestSha256,
    validation_manifest: validationManifest(),
    exit_code: 0,
    harbor_exit_code: 0,
    infra_status: "passed",
    docker_cleanup: { clean: true },
    harbor_job_accounting: { total: 12, completed: 12, retries: 0 },
    trial_accounting: { expected: 12, observed: 12, missing: 0 },
    tasks: frozen.tasks.map((task, index) => ({
      task_id: `terminal-bench/${task.path.split("/").at(-1)}`,
      verifier_outcome: index < passed ? "passed" : index < reached ? "failed" : "not_run",
      input_tokens: candidate ? 70 : 100,
      target_image_id: "sha256:fixed-task-image",
      harbor_deadline_sec: 1800,
      sigma_deadline_sec: 1680,
      execution_backend: candidate ? "oci:docker" : "sandbox:bwrap",
      container_engine: "docker",
      container_target: "managed"
    }))
  };
}

function evaluate(frozen: ReturnType<typeof plan>, before = report(frozen, 7, 4), after = report(frozen, 10, 6, true)) {
  return evaluateBenchmarkPair(before, after, frozen, benchmarkPlanFileSha256(frozen));
}

describe("paired benchmark acceptance", () => {
  it("accepts the preregistered absolute, delta, OCI, token, and infrastructure gates", () => {
    const frozen = plan();
    const result = evaluate(frozen);
    expect(result.status).toBe("accepted");
    expect(result.pairedTokens).toMatchObject({ commonReached: 7, medianImprovement: 0.3, gated: true });
    expect(result.pairedIntervals.verifierPassed).toHaveProperty("bootstrap95");
  });

  it("rejects metric misses and fails closed for incomplete, cleanup, or control drift", () => {
    const frozen = plan();
    expect(evaluate(frozen, report(frozen, 8, 5), report(frozen, 9, 5, true)).status).toBe("rejected");
    expect(() => evaluate(frozen, { ...report(frozen, 7, 4), status: "incomplete" })).toThrow(/baseline report is incomplete/iu);
    expect(() => evaluate(frozen, report(frozen, 7, 4), {
      ...report(frozen, 10, 6, true), docker_cleanup: { clean: false }
    })).toThrow(/infrastructure or cleanup/iu);
    expect(() => evaluate(frozen, report(frozen, 7, 4), {
      ...report(frozen, 10, 6, true), model: "different"
    })).toThrow(/control drift.*model/iu);
    expect(() => evaluate(frozen, {
      ...report(frozen, 7, 4), managed_provenance: false
    })).toThrow(/control drift.*baseline\.managed_provenance/iu);
    expect(() => evaluate(frozen, {
      ...report(frozen, 7, 4), harbor_topology: "main_only"
    })).toThrow(/control drift.*baseline\.harbor_topology/iu);
  });

  it("fails closed for an unpinned replacement plan or missing validation evidence", () => {
    const frozen = plan();
    const expected = benchmarkPlanFileSha256(frozen);
    const replacement = { ...frozen, createdAt: "2027-01-01T00:00:00.000Z" };
    expect(() => evaluateBenchmarkPair(
      report(frozen, 7, 4), report(frozen, 10, 6, true), replacement, expected
    )).toThrow(/externally pinned/iu);
    const candidate = report(frozen, 10, 6, true);
    delete candidate.validation_manifest.checks.fairness;
    expect(() => evaluate(frozen, report(frozen, 7, 4), candidate)).toThrow(/fairness/iu);
    const missingManagedControl = plan();
    missingManagedControl.controls.baselineManagedProvenance = false;
    expect(() => evaluateBenchmarkPair(
      report(missingManagedControl, 7, 4), report(missingManagedControl, 10, 6, true),
      missingManagedControl, benchmarkPlanFileSha256(missingManagedControl)
    )).toThrow(/controls are incomplete or unsupported/iu);
  });

  it("fails closed for task identity, image, deadline, or OCI identity drift", () => {
    const frozen = plan();
    const candidate = report(frozen, 10, 6, true);
    delete candidate.tasks[0].container_engine;
    expect(evaluate(frozen, report(frozen, 7, 4), candidate).status).toBe("rejected");
    const baseline = report(frozen, 7, 4);
    baseline.tasks[0].execution_backend = "oci:docker";
    expect(evaluate(frozen, baseline, report(frozen, 10, 6, true)).status).toBe("rejected");
    const baselineIdentity = report(frozen, 7, 4);
    delete baselineIdentity.tasks[0].container_target;
    expect(evaluate(frozen, baselineIdentity, report(frozen, 10, 6, true)).status).toBe("rejected");
    const deadlineDrift = report(frozen, 10, 6, true);
    deadlineDrift.tasks[0].sigma_deadline_sec = 1700;
    expect(() => evaluate(frozen, report(frozen, 7, 4), deadlineDrift)).toThrow(/deadline/iu);
  });
});
