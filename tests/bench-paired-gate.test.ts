import { describe, expect, it } from "vitest";
import {
  benchmarkPlanFileSha256,
  evaluateBenchmarkPair,
  evaluateCrossAgentBenchmarkPair,
  evaluateCrossAgentPreflight
} from "../scripts/bench-paired-gate.mjs";
import { createBenchmarkSamplePlan } from "../scripts/bench-sample-plan.mjs";
import {
  pairedRunCohortSchedule,
  pairedRunCohortScheduleSha256,
  pairedRunTaskIdentitySha256
} from "../scripts/bench-common.mjs";

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
      networkMode: "full",
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
      timeoutPolicy: "solver_full_task_timeout_separate_cleanup_grace",
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
    network_mode: "full",
    n_concurrent_trials: 2,
    max_turns: 200,
    command_timeout_sec: 180,
    benchmark_class: "standard",
    timeout_plan: { policy: "solver_full_task_timeout_separate_cleanup_grace" },
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
      sigma_deadline_sec: 1800,
      network_mode_effective: "full",
      execution_backend: candidate ? "oci:docker" : "sandbox:bwrap",
      container_engine: "docker",
      container_target: "managed"
    }))
  };
}

function evaluate(frozen: ReturnType<typeof plan>, before = report(frozen, 7, 4), after = report(frozen, 10, 6, true)) {
  return evaluateBenchmarkPair(before, after, frozen, benchmarkPlanFileSha256(frozen));
}

function crossAgentPlan() {
  const revision = "1".repeat(40);
  const tasks = [900, 900, 900, 750, 1800].map((timeout, index) => ({
    pairing_key: `private-suite/case-${index}`,
    source: "https://example.test/private-suite.git",
    path: `tasks/case-${index}`,
    git_commit_id: revision,
    effective_solver_timeout_sec: timeout,
    network_mode_effective: "full"
  }));
  const cohortSchedule = pairedRunCohortSchedule(tasks, [750, 900, 1800]);
  return {
    schemaVersion: 1,
    kind: "sigma.benchmark-paired-run-plan",
    taskCount: 5,
    tasks,
    controls: {
      model: "provider/model",
      taskRevision: revision,
      networkMode: "full",
      concurrency: 5,
      attemptsPerArm: 1,
      retries: 0,
      cohortSchedule,
      cohortScheduleSha256: pairedRunCohortScheduleSha256(cohortSchedule)
    },
    arms: {
      baseline: {
        agent: "external-agent", version: "1.0.0", sourceRevision: "2".repeat(40),
        sourceDirty: false, sourceDiffSha256: "3".repeat(64),
        executionSubjectKind: "installed-agent", executionSubjectSha256: "4".repeat(64)
      },
      candidate: {
        agent: "sigma", sourceRevision: "5".repeat(40), sourceDirty: true,
        sourceDiffSha256: "6".repeat(64),
        executionSubjectKind: "archive", executionSubjectSha256: "7".repeat(64)
      }
    },
    armOrder: ["baseline", "candidate"]
  };
}

function crossAgentReport(
  frozen: ReturnType<typeof crossAgentPlan>, candidate: boolean,
  outcomes: string[] = Array(5).fill("verifier_passed")
) {
  const preregistration = benchmarkPlanFileSha256(frozen);
  const inputDigests = candidate ? ["8", "9", "a"] : ["b", "c", "d"];
  const resolvedDigests = candidate ? ["1", "2", "3"] : ["5", "6", "7"];
  const lockDigests = candidate ? ["e", "f", "0"] : ["1", "2", "3"];
  const inputConfigSha256s = frozen.controls.cohortSchedule.map((cohort, index) => ({
    order: cohort.order,
    sha256: inputDigests[index].repeat(64)
  }));
  const resolvedTaskAttestationSha256s = frozen.controls.cohortSchedule.map((cohort, index) => ({
    order: cohort.order,
    sha256: resolvedDigests[index].repeat(64)
  }));
  const lockSha256s = frozen.controls.cohortSchedule.map((_cohort, index) =>
    lockDigests[index].repeat(64));
  const outcomeRecords = frozen.tasks.map((task, index) => ({
    ...(candidate ? { pairing_key: task.pairing_key } : { task_name: task.pairing_key }),
    task_identity_sha256: pairedRunTaskIdentitySha256(task),
    paired_outcome: outcomes[index],
    stdout: "raw solver output must not be copied"
  }));
  return {
    agent: candidate ? "sigma" : "external-agent",
    ...(candidate ? {} : { version: "1.0.0" }),
    source_revision: candidate ? "5".repeat(40) : "2".repeat(40),
    source_dirty: candidate,
    source_diff_sha256: (candidate ? "6" : "3").repeat(64),
    executionSubjectKind: candidate ? "archive" : "installed-agent",
    executionSubjectSha256: (candidate ? "7" : "4").repeat(64),
    provider: "provider",
    model: "model",
    preregistration_sha256: preregistration,
    attempts_per_arm: 1,
    retries: 0,
    terminal_bench_revision: frozen.controls.taskRevision,
    network_mode: "full",
    n_concurrent_trials: 5,
    run_input_attestation: {
      valid: true,
      configSha256s: inputConfigSha256s,
      resolvedTaskAttestationSha256s,
      lockSha256s,
      executionSubjectSha256: (candidate ? "7" : "4").repeat(64),
      issues: []
    },
    paired_run_controls: {
      model_identity: "provider/model",
      execution_subject_kind: candidate ? "archive" : "installed-agent",
      execution_subject_sha256: (candidate ? "7" : "4").repeat(64),
      terminal_bench_revision: frozen.controls.taskRevision,
      network_mode: "full",
      n_concurrent_trials: 5,
      attempts_per_arm: 1,
      retries: 0,
      preregistration_sha256: preregistration,
      tasks: frozen.tasks.map((task) => ({ ...task })),
      cohort_schedule: frozen.controls.cohortSchedule,
      cohort_schedule_sha256: frozen.controls.cohortScheduleSha256,
      input_config_sha256s: inputConfigSha256s,
      resolved_task_attestation_sha256s: resolvedTaskAttestationSha256s,
      lock_sha256s: lockSha256s
    },
    ...(candidate ? { tasks: outcomeRecords } : { trials: outcomeRecords })
  };
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
    const networkDrift = report(frozen, 10, 6, true);
    networkDrift.tasks[0].network_mode_effective = "none";
    expect(() => evaluate(frozen, report(frozen, 7, 4), networkDrift)).toThrow(/network_capability/iu);
  });
});

describe("cross-agent paired-run reporting", () => {
  it("preflights equal commits, models, task sets, networks, and effective solver timeouts", () => {
    const frozen = crossAgentPlan();
    const digest = benchmarkPlanFileSha256(frozen);
    const result = evaluateCrossAgentPreflight(
      crossAgentReport(frozen, false), crossAgentReport(frozen, true), frozen, digest
    );
    expect(result).toMatchObject({
      kind: "sigma.benchmark-paired-preflight",
      comparable: true,
      mismatchReasons: [],
      controls: {
        taskCount: 5, taskRevision: frozen.controls.taskRevision,
        model: "provider/model", networkMode: "full", concurrency: 5
      }
    });
  });

  it.each([
    ["model", (report: any) => { report.paired_run_controls.model_identity = "provider/other"; }],
    ["task_revision", (report: any) => {
      report.paired_run_controls.terminal_bench_revision = "3".repeat(40);
      for (const task of report.paired_run_controls.tasks) task.git_commit_id = "3".repeat(40);
    }],
    ["task_set", (report: any) => { report.paired_run_controls.tasks.pop(); }],
    ["network", (report: any) => {
      report.paired_run_controls.network_mode = "none";
      for (const task of report.paired_run_controls.tasks) task.network_mode_effective = "none";
    }],
    ["effective_solver_timeout", (report: any) => {
      report.paired_run_controls.tasks[0].effective_solver_timeout_sec += 1;
    }],
    ["concurrency", (report: any) => { report.paired_run_controls.n_concurrent_trials = 4; }],
    ["cohort_schedule", (report: any) => {
      report.paired_run_controls.cohort_schedule = [
        ...report.paired_run_controls.cohort_schedule
      ].reverse();
    }]
  ])("records %s drift as comparable=false without suppressing the report", (reason, mutate) => {
    const frozen = crossAgentPlan();
    const candidate = crossAgentReport(frozen, true);
    mutate(candidate);
    const result = evaluateCrossAgentBenchmarkPair(
      crossAgentReport(frozen, false), candidate, frozen, benchmarkPlanFileSha256(frozen)
    );
    expect(result).toMatchObject({ status: "not_comparable", comparable: false });
    expect(result.mismatchReasons).toContain(reason);
    expect(result.arms.candidate.tasksObserved).toBe(5);
  });

  it("reports verifier results, blockers, infrastructure failures, and manual stops as scalars", () => {
    const frozen = crossAgentPlan();
    const candidate = crossAgentReport(frozen, true, [
      "verifier_passed", "verifier_failed", "structured_blocker",
      "infrastructure_failure", "manual_stop"
    ]);
    const result = evaluateCrossAgentBenchmarkPair(
      crossAgentReport(frozen, false), candidate, frozen, benchmarkPlanFileSha256(frozen)
    );
    expect(result).toMatchObject({
      status: "reported",
      comparable: true,
      outcomeStatus: "incomplete",
      arms: {
        baseline: { verifierReached: 5, verifierPassed: 5 },
        candidate: {
          verifierReached: 2,
          verifierPassed: 1,
          naturalFailures: 1,
          structuredBlockers: 1,
          infrastructureFailures: 1,
          manualStops: 1,
          unknown: 0
        }
      },
      comparison: { verifierReachedDelta: -3, verifierPassedDelta: -4 }
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private-suite/case-");
    expect(serialized).not.toContain("raw solver output");
  });

  it.each([
    ["substituted", (report: any) => {
      report.tasks[0].pairing_key = "private-suite/substituted";
    }],
    ["duplicate", (report: any) => {
      report.tasks[1].pairing_key = report.tasks[0].pairing_key;
    }]
  ])("rejects a %s outcome task key even when task counts match", (_label, mutate) => {
    const frozen = crossAgentPlan();
    const candidate = crossAgentReport(frozen, true);
    mutate(candidate);
    const result = evaluateCrossAgentBenchmarkPair(
      crossAgentReport(frozen, false), candidate, frozen, benchmarkPlanFileSha256(frozen)
    );
    expect(result).toMatchObject({
      status: "not_comparable",
      comparable: false,
      mismatchReasons: expect.arrayContaining(["candidate_outcome_task_set"]),
      arms: { candidate: { tasksObserved: 5, outcomeTaskSetMatches: false } },
      comparison: { verifierReachedDelta: null, verifierPassedDelta: null }
    });
  });

  it("fails closed for a changed plan, retries, or an arm identity mismatch", () => {
    const frozen = crossAgentPlan();
    const digest = benchmarkPlanFileSha256(frozen);
    const baseline = crossAgentReport(frozen, false);
    const candidate = crossAgentReport(frozen, true);
    candidate.paired_run_controls.retries = 1;
    expect(evaluateCrossAgentPreflight(baseline, candidate, frozen, digest)).toMatchObject({
      comparable: false,
      mismatchReasons: expect.arrayContaining(["retries"])
    });
    candidate.paired_run_controls.retries = 0;
    candidate.agent = "different";
    expect(evaluateCrossAgentPreflight(baseline, candidate, frozen, digest)).toMatchObject({
      comparable: false,
      mismatchReasons: expect.arrayContaining(["candidate_identity"])
    });
    const unattested = crossAgentReport(frozen, true);
    unattested.run_input_attestation.valid = false;
    expect(evaluateCrossAgentPreflight(baseline, unattested, frozen, digest)).toMatchObject({
      comparable: false,
      mismatchReasons: expect.arrayContaining(["candidate_input_config_attestation"])
    });
    const missingResolvedPolicy = crossAgentReport(frozen, false);
    delete missingResolvedPolicy.run_input_attestation.resolvedTaskAttestationSha256s;
    expect(evaluateCrossAgentPreflight(
      missingResolvedPolicy, crossAgentReport(frozen, true), frozen, digest
    )).toMatchObject({
      comparable: false,
      mismatchReasons: expect.arrayContaining(["baseline_input_config_attestation"])
    });
    expect(() => evaluateCrossAgentPreflight(
      baseline, crossAgentReport(frozen, true), { ...frozen, taskCount: 4 }, digest
    )).toThrow(/paired-run-plan/iu);
  });
});
