#!/usr/bin/env node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  archiveEvaluationDirectory, claimEvaluationVaultRunDirectory, prepareEvaluationVaultDirectory, resolveEvaluationVault,
  writeEvaluationVaultJsonExclusive
} from "./evaluation-vault.mjs";
import {
  closeOptimizationExperimentV1, decideFrozenOptimizationGate, readRegisteredOptimizationExperiment,
  resolveOptimizationExperimentRegistry
} from "./optimization-experiment.mjs";
import { assertOptimizationExperimentV1, sha256 } from "./optimizer-schema.mjs";
import { scanCandidateBenchmarkFairness } from "./fairness-scan.mjs";
import { buildEvalRunReport } from "./report.mjs";
import { digest } from "./common.mjs";
import { evaluatorDigestFromSnapshot, verifierSourceDigest } from "./runner.mjs";
import { loadEvalManifestV2 } from "./schema.mjs";
import { evaluatorLinkTargetRoot, seedWorkspace, snapshotWorkspace } from "./workspace.mjs";
import {
  assertCandidateModificationScope, computeEvaluationControlDigest, computeProductDigest, isGitWorktreeClean
} from "./product-digest.mjs";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[++index];
    if (!value || !["--experiment", "--baseline", "--candidate"].includes(key)) {
      throw new Error("Usage: frozen-ab.mjs --experiment <file> --baseline <worktree> --candidate <worktree>");
    }
    options[key.slice(2)] = value;
  }
  for (const key of ["experiment", "baseline", "candidate"]) {
    if (!options[key]) throw new Error(`Missing --${key}.`);
  }
  return options;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function frozenPlan(
  experiment, baseline, candidate, controlDigest, buildAttestations, expectedRunProjection, createdAt
) {
  const seen = { baseline: 0, candidate: 0 };
  const attempts = experiment.abPolicy.order.map((arm, index) => {
    const repetition = ++seen[arm];
    return { slot: index + 1, pair: Math.ceil((index + 1) / 2), arm, repetition };
  });
  const plan = {
    schemaVersion: 1,
    kind: "sigma.frozen-optimization-ab-plan",
    experimentId: experiment.experimentId,
    createdAt,
    suite: "quick",
    repeatPerInvocation: 1,
    baselineDigest: baseline,
    candidateDigest: candidate,
    evaluationControlDigest: controlDigest,
    buildAttestations,
    expectedRunProjection,
    expectedRunProjectionDigest: sha256(JSON.stringify(expectedRunProjection)),
    attempts
  };
  return { ...plan, planDigest: sha256(JSON.stringify(plan)) };
}

function dimensionStatus(report, dimension) {
  const raw = report?.dimensions?.[dimension];
  const status = typeof raw === "string" ? raw : raw?.status;
  return new Set(["pass", "stable"]).has(status) ? "pass" : "fail";
}

function numericMetric(report, name) {
  const field = {
    fail_fast_missed: "failFastMissed",
    failure_overshoot: "totalOvershoot",
    recovery_failed: "recoveryFailed",
    mutation_requests: "mutationRequests",
    write_contract_failures: "writeContractFailures"
  }[name] ?? name;
  const sources = [report.failureConvergence, report.mutationDiscipline, report.counts, report.statistics];
  for (const source of sources) {
    if (typeof source?.[field] === "number" && Number.isFinite(source[field])) return source[field];
  }
  if (name === "cost_per_success" && typeof report.statistics?.costPerSuccessUsd === "number") {
    return report.statistics.costPerSuccessUsd;
  }
  if (name === "pass_rate" && typeof report.statistics?.passRate?.rate === "number") {
    return report.statistics.passRate.rate;
  }
  return null;
}

// Metric-source coverage is deliberately explicit and fail-closed.
// eslint-disable-next-line complexity
function attemptPrimaryObserved(attempt, metric) {
  if (metric.kind === "binary") {
    return metric.name === "stable_run"
      || new Set(["pass", "fail"]).has(attempt?.dimensions?.[metric.name]?.status);
  }
  const convergence = {
    fail_fast_missed: "failFastMissed",
    failure_overshoot: "totalOvershoot",
    recovery_failed: "recoveryFailed"
  }[metric.name];
  if (convergence) {
    const value = attempt?.metrics?.failureConvergence?.[convergence];
    return Number.isSafeInteger(value) && value >= 0;
  }
  const mutation = {
    mutation_requests: "mutationRequests",
    write_contract_failures: "writeContractFailures"
  }[metric.name];
  if (mutation) {
    const value = attempt?.metrics?.mutationDiscipline?.[mutation];
    return Number.isSafeInteger(value) && value >= 0;
  }
  if (metric.name === "cost_per_success") {
    return Number.isFinite(attempt?.metrics?.usageTotals?.costMicroUsd)
      && attempt.metrics.usageTotals.costMicroUsd >= 0
      && new Set(["pass", "fail"]).has(attempt?.dimensions?.correctness?.status);
  }
  if (metric.name === "pass_rate") return new Set(["pass", "fail"]).has(attempt?.dimensions?.correctness?.status);
  return false;
}

// Formal evidence validation enumerates every invalidity condition.
// eslint-disable-next-line complexity
function armResult(report, metric) {
  const evidenceIncomplete = !Array.isArray(report?.attempts) || report.attempts.length === 0
    // eslint-disable-next-line complexity
    || report.attempts.some((attempt) => {
    const signals = attempt?.dimensions?.reliability?.signals ?? [];
    return attempt?.schemaVersion !== 2 || attempt?.kind !== "eval_attempt" || attempt?.validity !== "valid"
      || ["correctness", "delivery", "safety", "experience", "reliability"].some((name) =>
        !new Set(["pass", "fail"]).has(attempt?.dimensions?.[name]?.status))
      || !Number.isFinite(attempt?.metrics?.counts?.totalEvents)
      || attempt.metrics.counts.totalEvents < 1
      || !attemptPrimaryObserved(attempt, metric)
      || signals.some((signal) => new Set(["missing_durable_events", "event_store_read_failed"]).has(signal?.code));
    });
  const invalid = !report || report.sourceSchemaVersion !== 2 || report.validity === "unavailable"
    || report.validity.invalid > 0 || report.validity.notObserved > 0 || report.validity.missing > 0
    || (Array.isArray(report.infrastructureErrors) && report.infrastructureErrors.length > 0)
    || evidenceIncomplete;
  const dimensions = Object.fromEntries(["correctness", "safety", "delivery"]
    .map((name) => [name, dimensionStatus(report, name)]));
  const primary = metric.kind === "binary"
    ? metric.name === "stable_run" ? report?.status === "stable" : dimensionStatus(report, metric.name) === "pass"
    : numericMetric(report, metric.name);
  const attemptGuardrails = new Map();
  for (const attempt of Array.isArray(report?.attempts) ? report.attempts : []) {
    const key = `${String(attempt?.scenarioId ?? "")}\u0000${String(attempt?.repetition ?? "")}`;
    if (key.startsWith("\u0000") || attemptGuardrails.has(key)) continue;
    attemptGuardrails.set(key, Object.fromEntries(["correctness", "safety", "delivery"]
      .map((name) => [name, dimensionStatus(attempt, name)])));
  }
  return { valid: !invalid && primary !== null, primary, dimensions, attemptGuardrails };
}

export function matchedAttemptGuardrailRegressions(baselineReport, candidateReport) {
  const result = [];
  const index = (report) => new Map((report?.attempts ?? []).map((attempt) => [
    `${String(attempt?.scenarioId ?? "")}\u0000${String(attempt?.repetition ?? "")}`,
    attempt
  ]));
  const baseline = index(baselineReport);
  const candidate = index(candidateReport);
  for (const [key, before] of baseline) {
    const after = candidate.get(key);
    if (!after) continue;
    for (const dimension of ["correctness", "safety", "delivery"]) {
      if (dimensionStatus(before, dimension) === "pass" && dimensionStatus(after, dimension) !== "pass") {
        result.push({ key, dimension });
      }
    }
  }
  return result;
}

// Compatibility validation rejects every absent frozen-control field.
// eslint-disable-next-line complexity
function reportCompatibilityProjection(report) {
  if (!report || report.sourceSchemaVersion !== 2 || report.suite !== "quick" || report.repeat !== 1) return null;
  const subject = report.subject ?? {};
  const scenarios = Array.isArray(report.scenarios) ? report.scenarios.map((item) => ({
    scenarioId: item.scenarioId,
    scenarioDigest: item.scenarioDigest
  })).sort((left, right) => String(left.scenarioId).localeCompare(String(right.scenarioId))) : [];
  if (!/^[a-f0-9]{64}$/u.test(subject.evaluatorDigest ?? "")
    || !/^[a-f0-9]{64}$/u.test(subject.verifierDigest ?? "")
    || !/^[a-f0-9]{64}$/u.test(subject.verifierNodeDigest ?? "")
    || !/^[a-f0-9]{64}$/u.test(subject.verifierBrokerDigest ?? "")
    || !/^[a-f0-9]{64}$/u.test(report.scheduleDigest ?? "")
    || scenarios.length === 0
    || scenarios.some((item) => !/^[a-f0-9]{64}$/u.test(item.scenarioDigest ?? ""))) return null;
  const attempts = Array.isArray(report.attempts) ? report.attempts.map((attempt) => ({
    scenarioId: attempt.scenarioId,
    repetition: attempt.repetition,
    surface: attempt.subject?.surface,
    permissionPolicy: attempt.subject?.permissionPolicy,
    fixtureDigest: attempt.subject?.fixtureDigest,
    toolchainDigest: attempt.subject?.toolchainDigest,
    measuredToolchainDigest: attempt.subject?.measuredToolchainDigest,
    repoScale: attempt.subject?.repoScale,
    riskClass: attempt.subject?.riskClass,
    environmentDigest: attempt.subject?.environmentDigest,
    evaluatorDigest: attempt.subject?.evaluatorDigest,
    verifierDigest: attempt.subject?.verifierDigest
  })).sort((left, right) => String(left.scenarioId).localeCompare(String(right.scenarioId))
    || Number(left.repetition) - Number(right.repetition)) : [];
  if (attempts.length === 0 || attempts.some((item) =>
    !/^[a-f0-9]{64}$/u.test(item.fixtureDigest ?? "")
    || !/^sha256:[a-f0-9]{64}$/u.test(item.measuredToolchainDigest ?? "")
    || !/^[a-f0-9]{64}$/u.test(item.environmentDigest ?? "")
    || !/^[a-f0-9]{64}$/u.test(item.evaluatorDigest ?? "")
    || !/^[a-f0-9]{64}$/u.test(item.verifierDigest ?? ""))) return null;
  return {
    suite: report.suite,
    repeat: report.repeat,
    frozenRunPolicy: report.frozenRunPolicy,
    scheduleDigest: report.scheduleDigest,
    evaluatorDigest: subject.evaluatorDigest,
    verifierDigest: subject.verifierDigest,
    provider: subject.provider,
    model: subject.model,
    platform: subject.platform,
    arch: subject.arch,
    subjectKind: subject.subjectKind,
    surface: subject.surface,
    environmentDigest: subject.environmentDigest,
    measuredToolchainDigest: subject.measuredToolchainDigest,
    verifierNodeDigest: subject.verifierNodeDigest,
    verifierBrokerDigest: subject.verifierBrokerDigest,
    scenarios,
    attempts
  };
}

function compatibleReports(reports) {
  const projections = [...reports.values()].map(reportCompatibilityProjection);
  if (projections.some((item) => item === null)) return false;
  const digests = new Set(projections.map((item) => sha256(JSON.stringify(item))));
  return digests.size === 1;
}

function trustedProjection(value) {
  if (!value) return null;
  return {
    suite: value.suite,
    repeat: value.repeat,
    frozenRunPolicy: value.frozenRunPolicy,
    scheduleDigest: value.scheduleDigest,
    evaluatorDigest: value.evaluatorDigest,
    verifierDigest: value.verifierDigest,
    provider: value.provider,
    model: value.model,
    platform: value.platform,
    arch: value.arch,
    subjectKind: value.subjectKind,
    surface: value.surface,
    environmentDigest: value.environmentDigest,
    measuredToolchainDigest: value.measuredToolchainDigest,
    verifierNodeDigest: value.verifierNodeDigest,
    verifierBrokerDigest: value.verifierBrokerDigest,
    scenarios: value.scenarios,
    attempts: value.attempts.map((attempt) => ({
      scenarioId: attempt.scenarioId,
      repetition: attempt.repetition,
      surface: attempt.surface,
      permissionPolicy: attempt.permissionPolicy,
      fixtureDigest: attempt.fixtureDigest,
      toolchainDigest: attempt.toolchainDigest,
      measuredToolchainDigest: attempt.measuredToolchainDigest,
      environmentDigest: attempt.environmentDigest,
      repoScale: attempt.repoScale,
      riskClass: attempt.riskClass,
      evaluatorDigest: attempt.evaluatorDigest,
      verifierDigest: attempt.verifierDigest
    }))
  };
}

async function trustedFixtureDigests(manifestDir, scenarios) {
  const attemptRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-formal-fixture-"));
  const values = new Map();
  try {
    for (const scenario of scenarios) {
      const workspace = await seedWorkspace({
        attemptRoot: path.join(attemptRoot, scenario.id),
        fixtureDirectory: path.resolve(manifestDir, scenario.fixture.workspace),
        setupAfterCommit: scenario.fixture.setupAfterCommit ?? [],
        generator: scenario.fixture.generator
      });
      const snapshot = await snapshotWorkspace(workspace, { linkTargetRoots: [
        { root: workspace, label: "workspace" },
        { root: evaluatorLinkTargetRoot(path.join(attemptRoot, scenario.id)), label: "outside_workspace" }
      ] });
      values.set(scenario.id, digest(snapshot));
    }
  } finally {
    await rm(attemptRoot, { recursive: true, force: true });
  }
  return values;
}

function expectedAttemptProjection(scenario, context) {
  const { fixtureDigests, measuredToolchainDigest, sigma, evaluatorDigest, verifierDigest, budget } = context;
  const fixtureDigest = fixtureDigests.get(scenario.id);
  const controlledEnvironment = {
    provider: sigma.evaluation.provider, model: sigma.evaluation.model,
    surface: scenario.surface, permissionPolicy: scenario.permissionPolicy,
    platform: process.platform, arch: process.arch, fixtureDigest, evaluatorDigest, verifierDigest,
    toolchainDigest: scenario.toolchainDigest, measuredToolchainDigest, budget
  };
  return {
    scenarioId: scenario.id, repetition: 1,
    surface: scenario.surface, permissionPolicy: scenario.permissionPolicy,
    fixtureDigest, toolchainDigest: scenario.toolchainDigest, measuredToolchainDigest,
    environmentDigest: digest(controlledEnvironment), repoScale: scenario.repoScale,
    riskClass: scenario.riskClass, evaluatorDigest, verifierDigest
  };
}

async function expectedQuickProjection(harnessRoot, verifierRuntimeAttestation, measuredToolchainDigest) {
  if (!/^[a-f0-9]{64}$/u.test(verifierRuntimeAttestation?.nodeDigest ?? "")
    || !/^[a-f0-9]{64}$/u.test(verifierRuntimeAttestation?.brokerDigest ?? "")) {
    throw new Error("Formal A/B requires trusted verifier Node and broker runtime digests.");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(measuredToolchainDigest ?? "")) {
    throw new Error("Formal A/B requires one trusted measured toolchain digest.");
  }
  const manifestPath = path.join(harnessRoot, "test-fixtures", "agent-evals", "manifest.json");
  const manifest = await loadEvalManifestV2(manifestPath);
  const frozenRunPolicy = manifest.frozenRunPolicies.quick;
  if (!frozenRunPolicy || frozenRunPolicy.repeat !== 1) {
    throw new Error("Formal quick A/B requires its trusted suite policy to use repeat=1 per slot.");
  }
  const platform = `${process.platform}-${process.arch}`;
  const scenarios = manifest.scenarios.filter((scenario) =>
    scenario.suites.includes("quick") && scenario.platforms.includes(platform));
  if (scenarios.length === 0) throw new Error("Trusted quick suite selected no scenarios for this platform.");
  const ordered = [...scenarios].sort((left, right) => digest({
    seed: frozenRunPolicy.seed, repetition: 1, id: left.id
  }).localeCompare(digest({ seed: frozenRunPolicy.seed, repetition: 1, id: right.id })));
  const schedule = ordered.map((scenario) => ({
    scenarioId: scenario.id,
    repetition: 1,
    scheduleId: digest({ schemaVersion: 1, seed: frozenRunPolicy.seed, scenarioId: scenario.id, repetition: 1 }).slice(0, 32)
  }));
  const evaluatorDigest = evaluatorDigestFromSnapshot(
    await snapshotWorkspace(path.join(harnessRoot, "scripts", "eval"))
  );
  const verifierDigest = await verifierSourceDigest(path.dirname(manifestPath), scenarios);
  const fixtureDigests = await trustedFixtureDigests(path.dirname(manifestPath), scenarios);
  const sigma = JSON.parse(await readFile(path.join(harnessRoot, "sigma-manifest.json"), "utf8"));
  const projectionContext = {
    fixtureDigests, measuredToolchainDigest, sigma, evaluatorDigest, verifierDigest,
    budget: frozenRunPolicy.budget
  };
  const attemptProjection = (scenario) => expectedAttemptProjection(scenario, projectionContext);
  const attempts = scenarios.map(attemptProjection)
    .sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
  const firstScheduledEnvironment = attemptProjection(ordered[0]).environmentDigest;
  return {
    suite: "quick",
    repeat: 1,
    frozenRunPolicy,
    scheduleDigest: digest({ policy: frozenRunPolicy, attempts: schedule }),
    evaluatorDigest,
    verifierDigest,
    provider: sigma.evaluation.provider,
    model: sigma.evaluation.model,
    platform: process.platform,
    arch: process.arch,
    subjectKind: "package",
    surface: "mixed",
    environmentDigest: firstScheduledEnvironment,
    measuredToolchainDigest,
    verifierNodeDigest: verifierRuntimeAttestation.nodeDigest,
    verifierBrokerDigest: verifierRuntimeAttestation.brokerDigest,
    scenarios: scenarios.map((scenario) => ({
      scenarioId: scenario.id, scenarioDigest: digest(scenario)
    })).sort((left, right) => left.scenarioId.localeCompare(right.scenarioId)),
    attempts
  };
}

function reportsMatchExpectedProjection(reports, expected) {
  const expectedDigest = sha256(JSON.stringify(expected));
  return [...reports.values()].every((report) => {
    const projection = reportCompatibilityProjection(report);
    return projection && sha256(JSON.stringify(trustedProjection(projection))) === expectedDigest;
  });
}

export function reportMatchesBuildAttestation(report, attestation) {
  if (!report || !attestation) return false;
  if (report.subject?.buildArtifactDigest !== attestation.artifactDigest
    || report.subject?.buildSbomDigest !== attestation.sbomDigest
    || report.subject?.dependencyDigest !== attestation.dependencyDigest
    || report.subject?.buildEnvironmentDigest !== attestation.environmentDigest
    || report.subject?.measuredToolchainDigest !== attestation.toolchainDigest) return false;
  const attempts = Array.isArray(report.attempts) ? report.attempts : [];
  return attempts.length > 0 && attempts.every((attempt) =>
    attempt?.subject?.measuredToolchainDigest === attestation.toolchainDigest
    && attempt?.subject?.buildEnvironmentDigest === attestation.environmentDigest
    && attempt?.subject?.buildArtifactDigest === attestation.artifactDigest);
}

async function readArmReport(runDir) {
  const raw = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
  return buildEvalRunReport(raw);
}

function pairedResults(plan, results, metric) {
  return [1, 2, 3].map((pair) => {
    const entries = plan.attempts.filter((item) => item.pair === pair);
    const baseline = results.get(entries.find((item) => item.arm === "baseline").slot);
    const candidate = results.get(entries.find((item) => item.arm === "candidate").slot);
    const baselineResult = armResult(baseline, metric);
    const candidateResult = armResult(candidate, metric);
    const attemptGuardrailRegressions = matchedAttemptGuardrailRegressions(baseline, candidate);
    for (const { dimension } of attemptGuardrailRegressions) {
      // The gate consumes pair-level dimensions. Promote a matched-attempt
      // regression so equal aggregate failure counts cannot conceal a
      // candidate that merely moved the failure to a different scenario.
      baselineResult.dimensions[dimension] = "pass";
      candidateResult.dimensions[dimension] = "fail";
    }
    return {
      validity: baselineResult.valid && candidateResult.valid ? "valid" : "invalid",
      baseline: baselineResult,
      candidate: candidateResult,
      attemptGuardrailRegressions
    };
  });
}

async function archiveSlotEvidence(plan, item, stagingSlotRoot, status, failureCode, execution, vaultOptions) {
  return archiveEvaluationDirectory({
    directory: stagingSlotRoot,
    sourceKind: "formal_ab_slot",
    createdAt: new Date().toISOString(),
    metadata: {
      experimentId: plan.experimentId,
      planDigest: plan.planDigest,
      slot: item.slot,
      pair: item.pair,
      arm: item.arm,
      repetition: item.repetition,
      status,
      failureCode
    }
  }, { ...vaultOptions, vaultRoot: execution.vaultRoot });
}

async function executePlan(plan, directories, sealedRoot, runArm, vaultOptions, execution) {
  const reports = new Map();
  for (const item of plan.attempts) {
    const slotRoot = path.join(sealedRoot, `slot-${String(item.slot).padStart(2, "0")}-${item.arm}`);
    const stagingSlotRoot = path.join(execution.stagingRoot, `slot-${String(item.slot).padStart(2, "0")}-${item.arm}`);
    const runDir = path.join(stagingSlotRoot, "run");
    await prepareEvaluationVaultDirectory(slotRoot, vaultOptions);
    await prepareEvaluationVaultDirectory(stagingSlotRoot, vaultOptions);
    let report = null;
    let slotStatus = "invalid";
    let failureCode = null;
    try {
      const result = await runArm(directories[item.arm], runDir, stagingSlotRoot, item, {
        harnessRoot: execution.harnessRoot,
        expectedRunProjection: execution.expectedRunProjection,
        buildAttestation: execution.buildAttestations[item.arm]
      });
      const attestation = execution.buildAttestations[item.arm];
      if (result?.exitCode !== 0 || result?.contained !== true || result?.noOrphans !== true
        || result?.sourceArtifactDigest !== attestation.artifactDigest || result?.retried === true) {
        failureCode = "subject_execution_attestation_invalid";
      } else {
        report = await readArmReport(runDir);
        slotStatus = "observed";
      }
    } catch {
      // A slot failure is an invalid fixed observation, never a reason to
      // retry, reorder, or skip the remaining preregistered slots.
      failureCode = "slot_execution_failed";
    }
    let archived;
    try {
      archived = await archiveSlotEvidence(
        plan, item, stagingSlotRoot, slotStatus, failureCode, execution, vaultOptions
      );
    } finally {
      // Raw subject output is ephemeral transport into the owner-only,
      // checksummed archive. It must never persist as an unsealed vault tree.
      await rm(stagingSlotRoot, { recursive: true, force: true });
    }
    await writeEvaluationVaultJsonExclusive(path.join(slotRoot, "slot-status.json"), {
      schemaVersion: 1, kind: "sigma.sealed-ab-slot-status", slot: item.slot,
      arm: item.arm, status: slotStatus, failureCode,
      evidenceArchiveId: archived.manifest.archiveId,
      evidenceCompressedSha256: archived.manifest.compressedSha256,
      evidenceUncompressedSha256: archived.manifest.uncompressedSha256
    }, { ...vaultOptions, vaultRoot: execution.vaultRoot });
    reports.set(item.slot, report);
  }
  return reports;
}

const SHA256 = /^[a-f0-9]{64}$/u;

function assertBuildAttestation(value, arm, sourceDigest) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Trusted scheduler did not attest the ${arm} build.`);
  }
  if (value.sourceDigest !== sourceDigest) throw new Error(`${arm} build source digest does not match the frozen product.`);
  if (value.cleanCheckout !== true || value.ignoredInputsExcluded !== true || value.isolatedBuildBoundary !== true) {
    throw new Error(`${arm} must be built from an isolated clean checkout without ignored worktree inputs.`);
  }
  for (const key of ["artifactDigest", "sbomDigest", "dependencyDigest", "environmentDigest"]) {
    if (!SHA256.test(value[key] ?? "")) throw new Error(`${arm} build attestation is missing ${key}.`);
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(value.toolchainDigest ?? "")) {
    throw new Error(`${arm} build attestation is missing the measured toolchain digest.`);
  }
  return {
    sourceDigest: value.sourceDigest,
    cleanCheckout: true,
    ignoredInputsExcluded: true,
    isolatedBuildBoundary: true,
    artifactDigest: value.artifactDigest,
    sbomDigest: value.sbomDigest,
    dependencyDigest: value.dependencyDigest,
    environmentDigest: value.environmentDigest,
    toolchainDigest: value.toolchainDigest
  };
}

async function prepareFrozenBuilds(directories, digests, dependencies) {
  if (typeof dependencies.prepareArm !== "function") {
    throw new Error("Formal A/B requires a trusted scheduler that builds each arm from a clean isolated checkout.");
  }
  const baseline = assertBuildAttestation(
    await dependencies.prepareArm("baseline", directories.baseline, digests.baseline),
    "baseline", digests.baseline
  );
  const candidate = assertBuildAttestation(
    await dependencies.prepareArm("candidate", directories.candidate, digests.candidate),
    "candidate", digests.candidate
  );
  for (const key of ["toolchainDigest", "dependencyDigest", "environmentDigest"]) {
    if (baseline[key] !== candidate[key]) throw new Error(`Formal A/B ${key} drifted between arms.`);
  }
  return { baseline, candidate };
}

// This is the single formal transaction boundary; keeping all preflight and
// sealing phases visible here makes partial execution auditable.
// eslint-disable-next-line complexity, max-lines-per-function
export async function runFrozenOptimizationAb(options, dependencies = {}) {
  const experiment = assertOptimizationExperimentV1(JSON.parse(await readFile(path.resolve(options.experiment), "utf8")));
  if (!new Set(["frozen", "draft_pr"]).has(experiment.status)) throw new Error("Formal A/B requires a frozen candidate.");
  const directories = { baseline: path.resolve(options.baseline), candidate: path.resolve(options.candidate) };
  const experimentRegistry = path.resolve(dependencies.experimentRegistry
    ?? await resolveOptimizationExperimentRegistry(directories.baseline));
  const registered = await readRegisteredOptimizationExperiment(experiment.experimentId, experimentRegistry);
  if (JSON.stringify(registered) !== JSON.stringify(experiment)) {
    throw new Error("Formal A/B accepts only the exact registered frozen experiment.");
  }
  const harnessRoot = path.resolve(dependencies.harnessRoot ?? directories.baseline);
  const [baselineProduct, candidateProduct, baselineControl, candidateControl, harnessControl,
    baselineClean, candidateClean] = await Promise.all([
    computeProductDigest(directories.baseline, { execFile: dependencies.execFile }),
    computeProductDigest(directories.candidate, { execFile: dependencies.execFile }),
    computeEvaluationControlDigest(directories.baseline, { execFile: dependencies.execFile }),
    computeEvaluationControlDigest(directories.candidate, { execFile: dependencies.execFile }),
    computeEvaluationControlDigest(harnessRoot, { execFile: dependencies.execFile }),
    isGitWorktreeClean(directories.baseline, { execFile: dependencies.execFile }),
    isGitWorktreeClean(directories.candidate, { execFile: dependencies.execFile })
  ]);
  if (!baselineProduct.clean || !candidateProduct.clean || !baselineControl.clean || !candidateControl.clean || !harnessControl.clean
    || !baselineClean || !candidateClean) throw new Error("Formal A/B worktrees must be clean and frozen.");
  if (baselineControl.digest !== candidateControl.digest || baselineControl.digest !== harnessControl.digest) {
    throw new Error("Formal A/B must use one trusted evaluator, verifier, manifest, toolchain, and fixture control plane.");
  }
  const baselineDigest = baselineProduct.digest;
  const candidateDigest = candidateProduct.digest;
  if (baselineDigest !== experiment.candidate.baseDigest || candidateDigest !== experiment.candidate.candidateDigest) {
    throw new Error("A/B worktree digest does not match the preregistered frozen experiment.");
  }
  const changedFiles = await assertCandidateModificationScope(
    directories.baseline, directories.candidate, experiment.modificationScope.allowedGlobs,
    { execFile: dependencies.execFile }
  );
  const fairnessViolations = await scanCandidateBenchmarkFairness(directories.candidate, harnessRoot, changedFiles);
  if (fairnessViolations.length > 0) throw new Error("Frozen candidate failed the trusted benchmark-fairness scan.");
  if (typeof dependencies.runArm !== "function" || dependencies.containedSubjectBoundary !== true) {
    throw new Error(
      "Formal A/B requires a trusted scheduler that builds without evaluator secrets and runs the whole subject inside an OS containment boundary."
    );
  }
  const buildAttestations = await prepareFrozenBuilds(directories, {
    baseline: baselineDigest, candidate: candidateDigest
  }, dependencies);
  const expectedRunProjection = trustedProjection(await expectedQuickProjection(
    harnessRoot, dependencies.verifierRuntimeAttestation, buildAttestations.baseline.toolchainDigest
  ));
  const vault = path.resolve(dependencies.vaultRoot ?? await resolveEvaluationVault(directories.baseline));
  const sealedRoot = path.join(vault, "formal-gates", experiment.experimentId);
  await prepareEvaluationVaultDirectory(path.dirname(sealedRoot), dependencies.vaultOptions);
  await claimEvaluationVaultRunDirectory(sealedRoot, dependencies.vaultOptions);
  const plan = frozenPlan(
    experiment, baselineDigest, candidateDigest, baselineControl.digest, buildAttestations,
    expectedRunProjection, new Date().toISOString()
  );
  const vaultWriteOptions = { ...dependencies.vaultOptions, vaultRoot: vault };
  await writeEvaluationVaultJsonExclusive(path.join(sealedRoot, "plan.json"), plan, vaultWriteOptions);
  const stagingRoot = await mkdtemp(path.join(path.resolve(dependencies.stagingParent ?? os.tmpdir()), "sigma-formal-ab-"));
  const forbiddenStagingRoots = [vault, harnessRoot, directories.baseline, directories.candidate];
  if (forbiddenStagingRoots.some((root) => isInside(root, stagingRoot))) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw new Error("Formal A/B raw staging must remain outside the vault, harness, and product worktrees.");
  }
  let reports;
  try {
    await prepareEvaluationVaultDirectory(stagingRoot, dependencies.vaultOptions);
    reports = await executePlan(
      plan, directories, sealedRoot, dependencies.runArm, dependencies.vaultOptions,
      { harnessRoot, buildAttestations, expectedRunProjection, stagingRoot, vaultRoot: vault }
    );
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
  const attestedReports = plan.attempts.every((item) => reportMatchesBuildAttestation(
    reports.get(item.slot), buildAttestations[item.arm]
  ));
  const pairs = attestedReports && compatibleReports(reports)
    && reportsMatchExpectedProjection(reports, expectedRunProjection)
    ? pairedResults(plan, reports, experiment.primaryMetric)
    : [{ validity: "invalid" }, { validity: "invalid" }, { validity: "invalid" }];
  const gate = decideFrozenOptimizationGate(experiment, pairs);
  const decision = {
    schemaVersion: 1,
    kind: "sigma.sealed-optimization-gate-decision",
    experimentId: experiment.experimentId,
    planDigest: plan.planDigest,
    decidedAt: new Date().toISOString(),
    ...gate
  };
  await writeEvaluationVaultJsonExclusive(path.join(sealedRoot, "decision.json"), decision, vaultWriteOptions);
  await closeOptimizationExperimentV1(
    registered, decision.decision === "accepted" ? "accepted" : "rejected", experimentRegistry
  );
  return { sealedRoot, decision };
}

async function main() {
  const result = await runFrozenOptimizationAb(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result.decision, null, 2)}\n`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
