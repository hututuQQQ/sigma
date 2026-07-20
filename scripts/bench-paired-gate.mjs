#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  comparePairedRunControls,
  pairedRunTaskIdentity,
  pairedRunTaskSetSnapshot
} from "./bench-common.mjs";

function median(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validRevision(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}

const REQUIRED_VALIDATION_CHECKS = [
  "unit", "property", "protocol", "typecheck", "lint", "nativeBroker", "package",
  "containment", "fairness", "ociMatrix", "harborCanary"
];

export function benchmarkPlanFileSha256(plan) {
  return sha256(`${JSON.stringify(plan, null, 2)}\n`);
}

function validateFrozenControls(controls) {
  const required = controls && controls.provider === "deepseek" && typeof controls.model === "string"
    && controls.dataset === "terminal-bench/terminal-bench-2" && controls.agentProfile === "standard"
    && controls.evaluationLane === "solving"
    && ["none", "loopback", "full"].includes(controls.networkMode) && controls.containerEngine === "docker"
    && controls.containerTarget === "managed" && controls.concurrency === 2
    && Number.isSafeInteger(controls.maxTurns) && controls.maxTurns > 0
    && Number.isSafeInteger(controls.commandTimeoutSec) && controls.commandTimeoutSec > 0
    && controls.benchmarkClass === "standard" && controls.attemptsPerArm === 1 && controls.retries === 0
    && controls.baselineExecutionMode === "sandboxed" && controls.candidateExecutionMode === "container"
    && controls.baselineManagedProvenance === true && controls.candidateManagedProvenance === true
    && controls.baselineHarborTopology === "managed_three_role"
    && controls.candidateHarborTopology === "managed_three_role"
    && validRevision(controls.terminalBenchRevision) && validRevision(controls.sourceRevision)
    && validSha256(controls.baselineArchiveSha256) && validSha256(controls.candidateArchiveSha256)
    && validSha256(controls.validationManifestSha256)
    && controls.modelParameters && typeof controls.modelParameters === "object"
    && controls.timeoutPolicy === "solver_full_task_timeout_separate_cleanup_grace"
    && Number.isSafeInteger(controls.cleanupGraceSec) && controls.cleanupGraceSec >= 0;
  if (!required) throw new Error("Frozen sample plan controls are incomplete or unsupported.");
}

function validateFrozenPlan(plan, expectedPlanSha256) {
  const quotas = plan?.quotas;
  const tasks = plan?.tasks;
  const exactQuotas = quotas && Object.keys(quotas).length === 3
    && quotas.easy === 2 && quotas.medium === 6 && quotas.hard === 4;
  if (!plan || plan.kind !== "sigma.benchmark-sample-plan" || plan.schemaVersion !== 1
    || plan.taskCount !== 12 || !exactQuotas || !Array.isArray(tasks) || tasks.length !== 12) {
    throw new Error("A frozen 12-task 2-easy/6-medium/4-hard sigma.benchmark-sample-plan is required.");
  }
  const tasksSha256 = sha256(canonical(tasks));
  const tasksFileSha256 = sha256(`${JSON.stringify(tasks, null, 2)}\n`);
  if (plan.tasksSha256 !== tasksSha256 || plan.tasksFileSha256 !== tasksFileSha256) {
    throw new Error("Frozen sample plan task digests do not match its task records.");
  }
  if (!validSha256(expectedPlanSha256) || benchmarkPlanFileSha256(plan) !== expectedPlanSha256) {
    throw new Error("Frozen sample plan does not match the externally pinned SHA-256.");
  }
  validateFrozenControls(plan.controls);
}

function verifierReached(task) {
  return task?.verifier_reached === true || task?.verifier_outcome === "passed"
    || task?.verifier_outcome === "failed" || task?.verifier_status === "passed"
    || task?.verifier_status === "failed"
    || (task?.reward !== null && task?.reward !== undefined && Number.isFinite(Number(task.reward)));
}

function verifierPassed(task) {
  return task?.verifier_outcome === "passed" || task?.verifier_status === "passed" || Number(task?.reward) >= 1;
}

function taskIndex(report) {
  const entries = Array.isArray(report?.tasks) ? report.tasks : [];
  const index = new Map();
  for (const task of entries) {
    const key = typeof task?.task_id === "string" ? task.task_id : "";
    if (!key || index.has(key)) throw new Error("Each report task must have a unique non-empty task_id.");
    index.set(key, task);
  }
  return index;
}

function completeReport(report, arm) {
  if (!report || report.status === "incomplete" || report.score_status === "incomplete"
    || (Array.isArray(report.incomplete_reason) && report.incomplete_reason.length > 0)) {
    throw new Error(`${arm} report is incomplete.`);
  }
  if (report?.harbor_job_accounting?.total !== 12
    || report?.harbor_job_accounting?.completed !== 12
    || Number(report?.harbor_job_accounting?.retries ?? -1) !== 0
    || report?.trial_accounting?.expected !== 12
    || report?.trial_accounting?.observed !== 12
    || Number(report?.trial_accounting?.missing ?? -1) !== 0) {
    throw new Error(`${arm} report lacks complete one-attempt accounting or contains prohibited retries.`);
  }
  if (!validSha256(report.agent_cli_sha256) || !validRevision(report.source_revision)) {
    throw new Error(`${arm} report lacks mandatory package/source provenance.`);
  }
  if (report.exit_code !== 0 || report.harbor_exit_code !== 0 || report.infra_status !== "passed"
    || report.docker_cleanup?.clean !== true) {
    throw new Error(`${arm} report has an infrastructure or cleanup failure.`);
  }
}

function pushMismatch(mismatches, label, observed, expected) {
  if (JSON.stringify(observed ?? null) !== JSON.stringify(expected ?? null)) mismatches.push(label);
}

function validateReportControls(report, plan, expectedPlanSha256, arm, mismatches) {
  const controls = plan.controls;
  const expected = {
    provider: controls.provider,
    model: controls.model,
    dataset: controls.dataset,
    agent_profile: controls.agentProfile,
    evaluation_lane: controls.evaluationLane,
    network_mode: controls.networkMode,
    n_concurrent_trials: controls.concurrency,
    max_turns: controls.maxTurns,
    command_timeout_sec: controls.commandTimeoutSec,
    benchmark_class: controls.benchmarkClass,
    model_parameters: controls.modelParameters,
    terminal_bench_revision: controls.terminalBenchRevision,
    source_revision: controls.sourceRevision,
    agent_cli_sha256: arm === "baseline" ? controls.baselineArchiveSha256 : controls.candidateArchiveSha256,
    execution_mode: arm === "baseline" ? controls.baselineExecutionMode : controls.candidateExecutionMode,
    managed_provenance: arm === "baseline"
      ? controls.baselineManagedProvenance : controls.candidateManagedProvenance,
    harbor_topology: arm === "baseline"
      ? controls.baselineHarborTopology : controls.candidateHarborTopology,
    container_engine_requested: controls.containerEngine,
    preregistration_sha256: expectedPlanSha256,
    validation_manifest_sha256: controls.validationManifestSha256
  };
  for (const [key, value] of Object.entries(expected)) {
    pushMismatch(mismatches, `${arm}.${key}`, report?.[key], value);
  }
  pushMismatch(mismatches, `${arm}.container_engine`, report?.container_engine, controls.containerEngine);
  pushMismatch(mismatches, `${arm}.container_target`, report?.container_target, controls.containerTarget);
}

function validateValidationManifest(report, plan) {
  const manifest = report?.validation_manifest;
  if (!manifest || manifest.schemaVersion !== 1 || manifest.kind !== "sigma.validation-manifest"
    || manifest.sourceRevision !== plan.controls.sourceRevision
    || manifest.candidateArchiveSha256 !== plan.controls.candidateArchiveSha256
    || report.validation_manifest_sha256 !== plan.controls.validationManifestSha256) {
    throw new Error("Candidate report lacks the externally pinned candidate validation manifest.");
  }
  const failed = REQUIRED_VALIDATION_CHECKS.filter((name) => {
    const check = manifest.checks?.[name];
    const evidence = check?.evidence;
    return check?.status !== "passed"
      || !(typeof evidence === "string" ? evidence.trim().length > 0 : Array.isArray(evidence) && evidence.length > 0);
  });
  if (failed.length > 0) {
    throw new Error(`Candidate validation manifest lacks passing evidence for: ${failed.join(", ")}.`);
  }
}

function planTaskIdentities(plan) {
  return plan.tasks.map((task) => {
    if (task.name) return task.name;
    const taskPath = typeof task.path === "string" ? task.path.replaceAll("\\", "/") : "";
    const baseName = path.posix.basename(taskPath);
    return task.source && baseName ? `${task.source}/${baseName}`
      : `${task.git_url ?? ""}\0${task.git_commit_id ?? ""}\0${taskPath}`;
  });
}

function sameControl(baseline, candidate, plan, expectedPlanSha256) {
  const mismatches = [];
  const controls = plan.controls;
  validateReportControls(baseline, plan, expectedPlanSha256, "baseline", mismatches);
  validateReportControls(candidate, plan, expectedPlanSha256, "candidate", mismatches);
  for (const key of [
    "provider", "model", "dataset", "agent_profile", "evaluation_lane",
    "network_mode", "n_concurrent_trials", "max_turns", "command_timeout_sec", "benchmark_class"
  ]) {
    if (baseline?.[key] !== candidate?.[key]) mismatches.push(key);
  }
  for (const key of ["model_parameters", "timeout_plan"]) {
    if (JSON.stringify(baseline?.[key] ?? null) !== JSON.stringify(candidate?.[key] ?? null)) mismatches.push(key);
  }
  if (baseline?.timeout_plan?.policy !== controls.timeoutPolicy
    || candidate?.timeout_plan?.policy !== controls.timeoutPolicy) {
    mismatches.push("timeout_policy");
  }
  if (baseline?.tasks_file_sha256 !== candidate?.tasks_file_sha256
    || baseline?.tasks_file_sha256 !== plan?.tasksFileSha256) mismatches.push("tasks_file_sha256");
  const baselineTasks = taskIndex(baseline);
  const candidateTasks = taskIndex(candidate);
  const plannedTasks = planTaskIdentities(plan).sort();
  if (baselineTasks.size !== plan.taskCount || candidateTasks.size !== plan.taskCount
    || JSON.stringify([...baselineTasks.keys()].sort()) !== JSON.stringify([...candidateTasks.keys()].sort())
    || JSON.stringify([...baselineTasks.keys()].sort()) !== JSON.stringify(plannedTasks)) {
    mismatches.push("paired_task_set");
  }
  for (const [taskId, before] of baselineTasks) {
    const after = candidateTasks.get(taskId);
    if (!after) continue;
    const beforeImage = before.task_image_digest ?? before.target_image_id ?? null;
    const afterImage = after.task_image_digest ?? after.target_image_id ?? null;
    if (!beforeImage || !afterImage || beforeImage !== afterImage) mismatches.push(`task_image:${taskId}`);
    for (const deadline of ["harbor_deadline_sec", "sigma_deadline_sec"]) {
      if (!Number.isFinite(Number(before[deadline])) || Number(before[deadline]) <= 0
        || Number(before[deadline]) !== Number(after[deadline])) {
        mismatches.push(`${deadline}:${taskId}`);
      }
    }
    if (Number(before.harbor_deadline_sec) !== Number(before.sigma_deadline_sec)
      || Number(after.harbor_deadline_sec) !== Number(after.sigma_deadline_sec)) {
      mismatches.push(`solver_full_task_timeout:${taskId}`);
    }
    const beforeNetwork = before.network_mode_effective;
    const afterNetwork = after.network_mode_effective;
    if (beforeNetwork !== controls.networkMode || afterNetwork !== controls.networkMode) {
      mismatches.push(`network_capability:${taskId}`);
    }
  }
  return { mismatches, baselineTasks, candidateTasks };
}

function requirement(name, passed, observed, expected) {
  return { name, passed, observed, expected };
}

function pairedBootstrapInterval(differences) {
  const count = differences.length;
  if (count === 0) return { lower: null, upper: null };
  const frequencies = new Map();
  for (const value of differences) frequencies.set(value, (frequencies.get(value) ?? 0) + 1);
  let distribution = new Map([[0, 1]]);
  for (let draw = 0; draw < count; draw += 1) {
    const next = new Map();
    for (const [sum, probability] of distribution) {
      for (const [value, frequency] of frequencies) {
        const key = sum + value;
        next.set(key, (next.get(key) ?? 0) + probability * frequency / count);
      }
    }
    distribution = next;
  }
  const ordered = [...distribution.entries()].sort(([left], [right]) => left - right);
  function quantile(target) {
    let cumulative = 0;
    for (const [sum, probability] of ordered) {
      cumulative += probability;
      if (cumulative >= target) return sum / count;
    }
    return ordered.at(-1)[0] / count;
  }
  return { lower: quantile(0.025), upper: quantile(0.975) };
}

function pairedBinarySummary(baselineTasks, candidateTasks, predicate) {
  const differences = [...baselineTasks.entries()].map(([key, before]) =>
    Number(predicate(candidateTasks.get(key))) - Number(predicate(before)));
  return {
    difference: differences.reduce((total, value) => total + value, 0) / differences.length,
    bootstrap95: pairedBootstrapInterval(differences)
  };
}

const CROSS_AGENT_PLAN_KIND = "sigma.benchmark-paired-run-plan";
const OUTCOME_CLASSES = new Set([
  "verifier_passed", "verifier_failed", "structured_blocker",
  "infrastructure_failure", "manual_stop", "unknown"
]);

function crossAgentPlanControls(plan) {
  return {
    model: plan.controls.model,
    terminal_bench_revision: plan.controls.taskRevision ?? plan.controls.terminalBenchRevision,
    network_mode: plan.controls.networkMode,
    n_concurrent_trials: plan.controls.concurrency,
    attempts_per_arm: plan.controls.attemptsPerArm,
    retries: plan.controls.retries,
    cohort_schedule: plan.controls.cohortSchedule,
    cohort_schedule_sha256: plan.controls.cohortScheduleSha256,
    tasks: plan.tasks
  };
}

function validateCrossAgentPlan(plan, expectedPlanSha256) {
  if (!plan || plan.kind !== CROSS_AGENT_PLAN_KIND || plan.schemaVersion !== 1
    || !Array.isArray(plan.tasks) || plan.tasks.length === 0
    || plan.taskCount !== plan.tasks.length
    || plan.tasks.some((task) => !pairedRunTaskIdentity(task))) {
    throw new Error("A non-empty sigma.benchmark-paired-run-plan is required.");
  }
  if (typeof plan.controls?.model !== "string" || plan.controls.model.trim().length === 0) {
    throw new Error("Paired-run plan must freeze a non-empty model identity.");
  }
  if (!validSha256(expectedPlanSha256) || benchmarkPlanFileSha256(plan) !== expectedPlanSha256) {
    throw new Error("Paired-run plan does not match the externally pinned SHA-256.");
  }
  const controls = crossAgentPlanControls(plan);
  const validation = comparePairedRunControls(controls, controls, controls);
  if (!validation.comparable || !validRevision(validation.controls.taskRevision)
    || !Number.isSafeInteger(plan.controls.concurrency) || plan.controls.concurrency <= 0
    || plan.controls.attemptsPerArm !== 1 || plan.controls.retries !== 0) {
    throw new Error(
      `Paired-run plan controls are incomplete or unsupported: ${validation.mismatchReasons.join(", ") || "task revision"}.`
    );
  }
  const arms = plan.arms;
  const order = plan.armOrder;
  const validArmSource = (arm) => arm?.sourceProvenanceKind === "installed-adapter"
    ? arm.executionSubjectKind === "installed-agent"
      && validSha256(arm.installedAdapterSha256)
    : validRevision(arm?.sourceRevision) && typeof arm?.sourceDirty === "boolean"
      && validSha256(arm?.sourceDiffSha256);
  const validArm = (arm) => typeof arm?.agent === "string" && arm.agent.length > 0
    && validArmSource(arm)
    && ["archive", "installed-agent"].includes(arm.executionSubjectKind)
    && validSha256(arm.executionSubjectSha256);
  if (!validArm(arms?.baseline) || !validArm(arms?.candidate)
    || !Array.isArray(order)
    || order.length !== 2 || new Set(order).size !== 2
    || !order.includes("baseline") || !order.includes("candidate")) {
    throw new Error("Paired-run plan must freeze baseline/candidate identities and execution order.");
  }
  return controls;
}

function controlSource(record) {
  const controls = record?.paired_run_controls;
  return controls && typeof controls === "object" && !Array.isArray(controls) ? controls : record;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "") ?? null;
}

function armIdentity(record, expected) {
  const source = controlSource(record);
  const configured = Array.isArray(record?.agents) && record.agents.length === 1
    ? record.agents[0] : null;
  const observed = {
    agent: firstValue(
      source?.agent, source?.agent_name, source?.agentName,
      record?.agent, record?.agent_name, record?.agentName, configured?.name
    ),
    version: firstValue(
      source?.version, source?.agent_version, source?.agentVersion,
      record?.version, record?.agent_version, record?.agentVersion, configured?.kwargs?.version
    ),
    sourceRevision: firstValue(
      source?.source_revision, source?.sourceRevision,
      record?.source_revision, record?.sourceRevision
    ),
    sourceDirty: firstValue(
      source?.source_dirty, source?.sourceDirty,
      record?.source_dirty, record?.sourceDirty
    ),
    sourceDiffSha256: firstValue(
      source?.source_diff_sha256, source?.sourceDiffSha256,
      record?.source_diff_sha256, record?.sourceDiffSha256
    ),
    sourceProvenanceKind: firstValue(
      source?.source_provenance_kind, source?.sourceProvenanceKind,
      record?.source_provenance_kind, record?.sourceProvenanceKind
    ),
    installedAdapterSha256: firstValue(
      source?.installed_adapter_sha256, source?.installedAdapterSha256,
      record?.installed_adapter_sha256, record?.installedAdapterSha256
    ),
    executionSubjectKind: firstValue(
      source?.execution_subject_kind, source?.executionSubjectKind,
      record?.execution_subject_kind, record?.executionSubjectKind
    ),
    executionSubjectSha256: firstValue(
      source?.execution_subject_sha256, source?.executionSubjectSha256,
      record?.execution_subject_sha256, record?.executionSubjectSha256
    )
  };
  return Object.fromEntries(Object.keys(expected).filter((key) => expected[key] !== undefined)
    .map((key) => [key, observed[key] ?? null]));
}

function plannedArmIdentity(arm) {
  return Object.fromEntries([
    "agent", "version", "sourceRevision", "sourceDirty", "sourceDiffSha256",
    "sourceProvenanceKind", "installedAdapterSha256",
    "executionSubjectKind", "executionSubjectSha256"
  ]
    .filter((key) => arm[key] !== undefined).map((key) => [key, arm[key]]));
}

function digestList(value, ordered) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const normalized = ordered
    ? value.map((item, index) => ({ order: item?.order, sha256: item?.sha256, index }))
    : value.map((item) => typeof item === "string" ? item : item?.sha256).sort();
  if (ordered) {
    if (normalized.some((item) => item.order !== item.index || !validSha256(item.sha256))
      || new Set(normalized.map((item) => item.sha256)).size !== normalized.length) return null;
    return normalized.map(({ order, sha256 }) => ({ order, sha256 }));
  }
  return normalized.every(validSha256) && new Set(normalized).size === normalized.length
    ? normalized : null;
}

function inputAttestationCheck(name, record, requireLocks) {
  const source = controlSource(record);
  const attestation = record?.run_input_attestation ?? record?.input_attestation;
  const declaredConfigs = digestList(source?.input_config_sha256s, true);
  const observedConfigs = digestList(attestation?.configSha256s, true);
  const declaredResolvedTasks = digestList(source?.resolved_task_attestation_sha256s, true);
  const observedResolvedTasks = digestList(attestation?.resolvedTaskAttestationSha256s, true);
  const declaredLocks = digestList(source?.lock_sha256s, false);
  const observedLocks = digestList(attestation?.lockSha256s, false);
  const executionSubjectSha256 = firstValue(
    source?.execution_subject_sha256, source?.executionSubjectSha256,
    record?.execution_subject_sha256, record?.executionSubjectSha256
  );
  const valid = attestation?.valid === true && declaredConfigs !== null
    && JSON.stringify(declaredConfigs) === JSON.stringify(observedConfigs)
    && declaredResolvedTasks !== null
    && JSON.stringify(declaredResolvedTasks) === JSON.stringify(observedResolvedTasks)
    && validSha256(executionSubjectSha256)
    && attestation?.executionSubjectSha256 === executionSubjectSha256
    && (!requireLocks || (declaredLocks !== null && observedLocks !== null
      && JSON.stringify(declaredLocks) === JSON.stringify(observedLocks)));
  return {
    name,
    passed: valid,
    baseline: declaredConfigs ? sha256(canonical(declaredConfigs)) : null,
    candidate: requireLocks && observedLocks ? sha256(canonical(observedLocks)) : null,
    expected: requireLocks ? "config-and-lock-attested" : "config-attested"
  };
}

function identityCheck(name, observed, expected) {
  const observedDigest = sha256(canonical(observed));
  const expectedDigest = sha256(canonical(expected));
  return {
    name,
    passed: observedDigest === expectedDigest,
    baseline: observedDigest,
    candidate: null,
    expected: expectedDigest
  };
}

function preregistrationCheck(baseline, candidate, expectedPlanSha256) {
  const before = firstValue(
    controlSource(baseline)?.preregistration_sha256, baseline?.preregistration_sha256
  );
  const after = firstValue(
    controlSource(candidate)?.preregistration_sha256, candidate?.preregistration_sha256
  );
  return {
    name: "preregistration",
    passed: before === expectedPlanSha256 && after === expectedPlanSha256,
    baseline: before,
    candidate: after,
    expected: expectedPlanSha256
  };
}

/** Validate a frozen cross-agent pair before either solver is launched. The
 * return value is safe to persist as a control-plane artifact and is never
 * consumed by a solver. */
export function evaluateCrossAgentPreflight(baseline, candidate, plan, expectedPlanSha256) {
  const expectedControls = validateCrossAgentPlan(plan, expectedPlanSha256);
  const controls = comparePairedRunControls(baseline, candidate, expectedControls);
  const plannedBaseline = plannedArmIdentity(plan.arms.baseline);
  const plannedCandidate = plannedArmIdentity(plan.arms.candidate);
  const identityChecks = [
    identityCheck(
      "baseline_identity", armIdentity(baseline, plannedBaseline), plannedBaseline
    ),
    identityCheck(
      "candidate_identity", armIdentity(candidate, plannedCandidate), plannedCandidate
    ),
    preregistrationCheck(baseline, candidate, expectedPlanSha256),
    inputAttestationCheck("baseline_input_config_attestation", baseline, false),
    inputAttestationCheck("candidate_input_config_attestation", candidate, false)
  ];
  const checks = [...controls.checks, ...identityChecks];
  return {
    ...controls,
    comparable: checks.every((check) => check.passed),
    mismatchReasons: checks.filter((check) => !check.passed).map((check) => check.name),
    preregistrationSha256: expectedPlanSha256,
    armOrder: [...plan.armOrder],
    checks
  };
}

function taskOutcomeClass(task) {
  const explicit = firstValue(task?.paired_outcome, task?.outcome_class, task?.outcomeClass);
  if (OUTCOME_CLASSES.has(explicit)) return explicit;
  if (task?.termination_source === "manual_stop" || Number(task?.manual_stop_count) > 0) {
    return "manual_stop";
  }
  if (verifierPassed(task)) return "verifier_passed";
  if (verifierReached(task)) return "verifier_failed";
  if (["blocked", "needs_input"].includes(task?.agent_outcome)
    || ["blocked", "needs_input"].includes(task?.status)
    || task?.failure_category === "needs_input") return "structured_blocker";
  if (task?.validity === "infra_failed" || task?.status === "infra_failed"
    || task?.failure_category === "infra_failed") return "infrastructure_failure";
  return "unknown";
}

function aggregateArm(report, expectedTasks, expectedTaskSetSha256) {
  const tasks = Array.isArray(report?.tasks) ? report.tasks
    : Array.isArray(report?.trials) ? report.trials : [];
  const taskSet = pairedRunTaskSetSnapshot(tasks);
  const counts = Object.fromEntries([...OUTCOME_CLASSES].map((outcome) => [outcome, 0]));
  for (const task of tasks) counts[taskOutcomeClass(task)] += 1;
  const missing = Math.max(0, expectedTasks - tasks.length);
  counts.unknown += missing;
  const verifierReachedCount = counts.verifier_passed + counts.verifier_failed;
  const eligibleTerminations = verifierReachedCount + counts.structured_blocker;
  return {
    tasksExpected: expectedTasks,
    tasksObserved: tasks.length,
    outcomeTaskSetSha256: taskSet.taskSetSha256,
    outcomeTaskSetMatches: taskSet.valid && taskSet.taskSetSha256 === expectedTaskSetSha256,
    verifierReached: verifierReachedCount,
    verifierPassed: counts.verifier_passed,
    naturalFailures: counts.verifier_failed,
    structuredBlockers: counts.structured_blocker,
    infrastructureFailures: counts.infrastructure_failure,
    manualStops: counts.manual_stop,
    unknown: counts.unknown,
    eligibleTerminations,
    outcomeStatus: eligibleTerminations === expectedTasks ? "complete" : "incomplete",
    passRate: expectedTasks > 0 ? counts.verifier_passed / expectedTasks : null
  };
}

/** Aggregate one preregistered cross-agent pair. It is intentionally a
 * terminal reporting operation: it neither schedules attempts nor emits task,
 * verifier, prompt, or output records that could be fed back to a solver. */
export function evaluateCrossAgentBenchmarkPair(baseline, candidate, plan, expectedPlanSha256) {
  const preflight = evaluateCrossAgentPreflight(
    baseline, candidate, plan, expectedPlanSha256
  );
  const expectedTaskSetSha256 = pairedRunTaskSetSnapshot(plan.tasks).taskSetSha256;
  const before = aggregateArm(baseline, plan.taskCount, expectedTaskSetSha256);
  const after = aggregateArm(candidate, plan.taskCount, expectedTaskSetSha256);
  const outcomeChecks = [
    inputAttestationCheck("baseline_lock_attestation", baseline, true),
    inputAttestationCheck("candidate_lock_attestation", candidate, true),
    {
      name: "baseline_outcome_task_set",
      passed: before.outcomeTaskSetMatches,
      baseline: before.outcomeTaskSetSha256,
      candidate: null,
      expected: expectedTaskSetSha256
    },
    {
      name: "candidate_outcome_task_set",
      passed: after.outcomeTaskSetMatches,
      baseline: null,
      candidate: after.outcomeTaskSetSha256,
      expected: expectedTaskSetSha256
    }
  ];
  const checks = [...preflight.checks, ...outcomeChecks];
  const comparable = preflight.comparable && outcomeChecks.every((check) => check.passed);
  return {
    schemaVersion: 1,
    kind: "sigma.benchmark-cross-agent-pair",
    status: comparable ? "reported" : "not_comparable",
    comparable,
    mismatchReasons: checks.filter((check) => !check.passed).map((check) => check.name),
    preregistrationSha256: expectedPlanSha256,
    sample: {
      tasks: plan.taskCount,
      taskSetSha256: preflight.controls.taskSetSha256,
      timeoutPlanSha256: preflight.controls.timeoutPlanSha256,
      cohortScheduleSha256: preflight.controls.cohortScheduleSha256
    },
    controls: {
      taskRevision: preflight.controls.taskRevision,
      model: preflight.controls.model,
      networkMode: preflight.controls.networkMode,
      concurrency: preflight.controls.concurrency
    },
    outcomeStatus: before.outcomeStatus === "complete" && after.outcomeStatus === "complete"
      ? "complete" : "incomplete",
    arms: {
      baseline: { agent: plan.arms.baseline.agent, ...before },
      candidate: { agent: plan.arms.candidate.agent, ...after }
    },
    comparison: {
      verifierReachedDelta: comparable ? after.verifierReached - before.verifierReached : null,
      verifierPassedDelta: comparable
        ? after.verifierPassed - before.verifierPassed : null
    },
    checks
  };
}

/** Apply the pre-registered 12-task gate once. This function only consumes
 * post-run aggregate records and never schedules a retry or produces solver
 * input. */
export function evaluateBenchmarkPair(baseline, candidate, plan, expectedPlanSha256) {
  completeReport(baseline, "baseline");
  completeReport(candidate, "candidate");
  validateFrozenPlan(plan, expectedPlanSha256);
  validateValidationManifest(candidate, plan);
  const control = sameControl(baseline, candidate, plan, expectedPlanSha256);
  if (control.mismatches.length > 0) {
    throw new Error(`Paired benchmark control drift: ${control.mismatches.join(", ")}.`);
  }
  const baselineTasks = [...control.baselineTasks.values()];
  const candidateTasks = [...control.candidateTasks.values()];
  const baselineReached = baselineTasks.filter(verifierReached).length;
  const candidateReached = candidateTasks.filter(verifierReached).length;
  const baselinePassed = baselineTasks.filter(verifierPassed).length;
  const candidatePassed = candidateTasks.filter(verifierPassed).length;
  const commonReached = [...control.baselineTasks.entries()].flatMap(([key, before]) => {
    const after = control.candidateTasks.get(key);
    return after && verifierReached(before) && verifierReached(after) ? [{ before, after }] : [];
  });
  const tokenImprovements = commonReached.flatMap(({ before, after }) => {
    const baselineTokens = Number(before.input_tokens);
    const candidateTokens = Number(after.input_tokens);
    return Number.isFinite(baselineTokens) && baselineTokens > 0 && Number.isFinite(candidateTokens)
      ? [(baselineTokens - candidateTokens) / baselineTokens] : [];
  });
  const medianTokenImprovement = median(tokenImprovements);
  const pairedIntervals = {
    verifierReached: pairedBinarySummary(control.baselineTasks, control.candidateTasks, verifierReached),
    verifierPassed: pairedBinarySummary(control.baselineTasks, control.candidateTasks, verifierPassed)
  };
  const baselineBackend = baseline.execution_backend;
  const sandboxBackend = baseline.execution_mode === "sandboxed"
    && typeof baselineBackend === "string" && baselineBackend.startsWith("sandbox:");
  const perTaskSandboxIdentity = baselineTasks.every((task) =>
    typeof task.execution_backend === "string" && task.execution_backend.startsWith("sandbox:")
    && task.container_engine === plan.controls.containerEngine
    && task.container_target === plan.controls.containerTarget
    && Boolean(task.task_image_digest ?? task.target_image_id));
  const backend = candidate.execution_backend;
  const ociBackend = candidate.execution_mode === "container"
    && typeof backend === "string" && backend.startsWith("oci:");
  const perTaskOciIdentity = candidateTasks.every((task) =>
    typeof task.execution_backend === "string" && task.execution_backend.startsWith("oci:")
    && task.container_engine === plan.controls.containerEngine
    && task.container_target === plan.controls.containerTarget
    && Boolean(task.task_image_digest ?? task.target_image_id));
  const requirements = [
    requirement("verifier_reached_absolute", candidateReached >= 10, candidateReached, ">=10/12"),
    requirement(
      "verifier_reached_delta",
      baselineReached >= 10 ? candidateReached >= baselineReached : candidateReached >= baselineReached + 3,
      candidateReached - baselineReached,
      baselineReached >= 10 ? ">=0" : ">=3"
    ),
    requirement("verifier_passed_absolute", candidatePassed >= 6, candidatePassed, ">=6/12"),
    requirement(
      "verifier_passed_delta",
      baselinePassed >= 6 ? candidatePassed >= baselinePassed : candidatePassed >= baselinePassed + 2,
      candidatePassed - baselinePassed,
      baselinePassed >= 6 ? ">=0" : ">=2"
    ),
    requirement("pre_verifier_failures", 12 - candidateReached <= 2, 12 - candidateReached, "<=2/12"),
    requirement(
      "baseline_managed_provenance",
      sandboxBackend && perTaskSandboxIdentity,
      `${baseline.execution_mode ?? "unknown"}/${baselineBackend ?? "unknown"}; per-task=${perTaskSandboxIdentity}`,
      "sandboxed/sandbox:* with complete per-task docker/managed/image identity"
    ),
    requirement(
      "oci_no_host_fallback",
      ociBackend && perTaskOciIdentity,
      `${candidate.execution_mode ?? "unknown"}/${backend ?? "unknown"}; per-task=${perTaskOciIdentity}`,
      "container/oci:* with complete per-task engine/target/image identity"
    )
  ];
  if (commonReached.length >= 4) {
    requirements.push(requirement(
      "paired_median_input_token_reduction",
      tokenImprovements.length === commonReached.length && medianTokenImprovement !== null
        && medianTokenImprovement >= 0.25,
      medianTokenImprovement,
      ">=0.25"
    ));
  }
  return {
    schemaVersion: 1,
    kind: "sigma.benchmark-paired-gate",
    status: requirements.every((item) => item.passed) ? "accepted" : "rejected",
    sample: { tasks: 12, tasksFileSha256: plan.tasksFileSha256 },
    baseline: { verifierReached: baselineReached, verifierPassed: baselinePassed },
    candidate: { verifierReached: candidateReached, verifierPassed: candidatePassed },
    pairedTokens: {
      commonReached: commonReached.length,
      validSamples: tokenImprovements.length,
      medianImprovement: medianTokenImprovement,
      gated: commonReached.length >= 4
    },
    pairedIntervals,
    requirements
  };
}

function markdown(result) {
  if (result.kind === "sigma.benchmark-cross-agent-pair") return crossAgentMarkdown(result);
  return [
    "# Sigma Paired Benchmark Gate", "",
    `- Status: ${result.status}`,
    `- Baseline verifier reached/passed: ${result.baseline.verifierReached}/${result.baseline.verifierPassed}`,
    `- Candidate verifier reached/passed: ${result.candidate.verifierReached}/${result.candidate.verifierPassed}`,
    `- Paired verifier-reached difference (95% bootstrap interval): ${result.pairedIntervals.verifierReached.difference} [${result.pairedIntervals.verifierReached.bootstrap95.lower}, ${result.pairedIntervals.verifierReached.bootstrap95.upper}]`,
    `- Paired verifier-passed difference (95% bootstrap interval): ${result.pairedIntervals.verifierPassed.difference} [${result.pairedIntervals.verifierPassed.bootstrap95.lower}, ${result.pairedIntervals.verifierPassed.bootstrap95.upper}]`,
    `- Paired median input-token improvement: ${result.pairedTokens.medianImprovement ?? "not gated"}`,
    "", "| requirement | pass | observed | expected |", "| --- | --- | --- | --- |",
    ...result.requirements.map((item) => `| ${item.name} | ${item.passed} | ${item.observed} | ${item.expected} |`), ""
  ].join("\n");
}

function crossAgentMarkdown(result) {
  const before = result.arms.baseline;
  const after = result.arms.candidate;
  return [
    "# Cross-Agent Paired Benchmark Report", "",
    `- Status: ${result.status}`,
    `- Comparable: ${result.comparable}`,
    `- Outcome completeness: ${result.outcomeStatus}`,
    `- Control mismatches: ${result.mismatchReasons.join(", ") || "none"}`,
    `- Tasks: ${result.sample.tasks}`,
    `- Baseline (${before.agent}) verifier reached/passed: ${before.verifierReached}/${before.verifierPassed}`,
    `- Candidate (${after.agent}) verifier reached/passed: ${after.verifierReached}/${after.verifierPassed}`,
    `- Baseline natural failures / blockers / infra / manual / unknown: ${before.naturalFailures}/${before.structuredBlockers}/${before.infrastructureFailures}/${before.manualStops}/${before.unknown}`,
    `- Candidate natural failures / blockers / infra / manual / unknown: ${after.naturalFailures}/${after.structuredBlockers}/${after.infrastructureFailures}/${after.manualStops}/${after.unknown}`,
    "", "| control | pass | baseline | candidate | expected |", "| --- | --- | --- | --- | --- |",
    ...result.checks.map((item) =>
      `| ${item.name} | ${item.passed} | ${item.baseline ?? "n/a"} | ${item.candidate ?? "n/a"} | ${item.expected ?? "n/a"} |`), ""
  ].join("\n");
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!["--baseline", "--candidate", "--plan", "--expected-plan-sha256", "--output", "--phase"].includes(key) || !value) {
      throw new Error("Usage: bench-paired-gate.mjs --baseline report.json --candidate report.json --plan plan.json --expected-plan-sha256 <sha256> --output result.json [--phase preflight|result]");
    }
    values[key.slice(2)] = value;
  }
  for (const key of ["baseline", "candidate", "plan", "expected-plan-sha256", "output"]) {
    if (!values[key]) throw new Error(`--${key} is required.`);
  }
  if (!validSha256(values["expected-plan-sha256"])) throw new Error("--expected-plan-sha256 must be a SHA-256 digest.");
  values.phase = values.phase ?? "result";
  if (!["preflight", "result"].includes(values.phase)) throw new Error("--phase must be preflight or result.");
  return values;
}

async function main(argv) {
  const options = parseArgs(argv);
  const [baselineText, candidateText, planText] = await Promise.all(
    [options.baseline, options.candidate, options.plan].map((file) => readFile(path.resolve(file), "utf8"))
  );
  const observedPlanSha256 = sha256(planText);
  if (observedPlanSha256 !== options["expected-plan-sha256"]) {
    throw new Error(`Frozen sample plan SHA-256 ${observedPlanSha256} does not match the external pin.`);
  }
  const baseline = JSON.parse(baselineText);
  const candidate = JSON.parse(candidateText);
  const plan = JSON.parse(planText);
  if (options.phase === "preflight" && plan.kind !== CROSS_AGENT_PLAN_KIND) {
    throw new Error("--phase preflight requires a sigma.benchmark-paired-run-plan.");
  }
  const result = plan.kind === CROSS_AGENT_PLAN_KIND
    ? options.phase === "preflight"
      ? evaluateCrossAgentPreflight(baseline, candidate, plan, observedPlanSha256)
      : evaluateCrossAgentBenchmarkPair(baseline, candidate, plan, observedPlanSha256)
    : evaluateBenchmarkPair(baseline, candidate, plan, observedPlanSha256);
  await writeFile(path.resolve(options.output), `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  if (options.phase === "result") {
    await writeFile(`${path.resolve(options.output)}.md`, markdown(result), { encoding: "utf8", flag: "wx" });
  }
  process.stdout.write(`Paired benchmark ${options.phase}: ${result.status ?? (result.comparable ? "comparable" : "not_comparable")}\n`);
  if (result.comparable === false || (result.kind === "sigma.benchmark-paired-gate" && result.status !== "accepted")) {
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
