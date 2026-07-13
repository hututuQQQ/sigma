#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertOptimizationExperimentV1, assertOptimizerClusterCardV1, branchForCluster,
  isActiveExperimentStatus, optimizationExperimentIdV1, sha256
} from "./optimizer-schema.mjs";
import { resolveWorkspaceStateRoot } from "./event-store.mjs";

const FROZEN_ORDER = ["baseline", "candidate", "candidate", "baseline", "baseline", "candidate"];
const REQUIRED_DIMENSIONS = ["correctness", "safety", "delivery"];
const execFile = promisify(execFileCallback);

function defaultGuardrails() {
  return REQUIRED_DIMENSIONS.map((metric) => ({ metric, rule: "no_regression", limit: null }));
}

export function createOptimizationExperimentV1(input) {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const base = {
    schemaVersion: 1,
    kind: "sigma.optimization-experiment",
    clusterId: input.clusterId,
    eligibilityClaimDigest: input.eligibilityClaimDigest,
    createdAt,
    closedAt: null,
    status: "preregistered",
    invariant: input.invariant,
    hypothesis: input.hypothesis,
    modificationScope: { allowedGlobs: input.allowedGlobs },
    primaryMetric: input.primaryMetric,
    guardrails: input.guardrails ?? defaultGuardrails(),
    rollback: input.rollback,
    candidate: {
      branch: branchForCluster(input.clusterId),
      baseDigest: input.baseDigest,
      candidateDigest: null,
      frozenAt: null
    },
    fairness: {
      noIdentityBranching: true,
      noVerifierInput: true,
      noPostVerifierRetry: true,
      oneActiveExperiment: true
    },
    abPolicy: { pairs: 3, order: FROZEN_ORDER, invalidPairAction: "block" }
  };
  return assertOptimizationExperimentV1({ ...base, experimentId: optimizationExperimentIdV1(base) });
}

export function assertSingleActiveExperiment(experiments, clusterId, exceptId = null) {
  const active = experiments.filter((item) => {
    const experiment = assertOptimizationExperimentV1(item);
    return experiment.clusterId === clusterId
      && experiment.experimentId !== exceptId
      && isActiveExperimentStatus(experiment.status);
  });
  if (active.length > 0) throw new Error("An active experiment already exists for this cluster.");
}

export function freezeOptimizationExperimentV1(input, candidateDigest, frozenAt = new Date().toISOString()) {
  const experiment = structuredClone(assertOptimizationExperimentV1(input));
  if (experiment.status !== "preregistered") throw new Error("Only a preregistered experiment can be frozen.");
  experiment.status = "frozen";
  experiment.candidate.candidateDigest = candidateDigest;
  experiment.candidate.frozenAt = frozenAt;
  return assertOptimizationExperimentV1(experiment);
}

export async function freezeRegisteredOptimizationExperimentV1(
  input, candidateDigest, directory, frozenAt = new Date().toISOString()
) {
  const requested = assertOptimizationExperimentV1(input);
  const registered = await readRegisteredOptimizationExperiment(requested.experimentId, directory);
  if (JSON.stringify(registered) !== JSON.stringify(requested)) {
    throw new Error("Experiment file does not match its immutable registered preregistration.");
  }
  const frozen = freezeOptimizationExperimentV1(registered, candidateDigest, frozenAt);
  await updateRegisteredExperiment(frozen, directory, "freeze");
  return frozen;
}

export async function resolveOptimizationRepositoryStateRoot(workspace = ".") {
  const resolvedWorkspace = path.resolve(workspace);
  const workspaceState = await resolveWorkspaceStateRoot(resolvedWorkspace);
  const stateHome = path.dirname(path.dirname(workspaceState));
  const reportedCommonDirectory = await execFile(
    "git", ["rev-parse", "--git-common-dir"],
    { cwd: resolvedWorkspace, windowsHide: true }
  ).then((result) => path.resolve(resolvedWorkspace, result.stdout.trim())).catch(() => resolvedWorkspace);
  const commonDirectory = await realpath(reportedCommonDirectory).catch(() => path.resolve(reportedCommonDirectory));
  const identity = process.platform === "win32" ? commonDirectory.toLowerCase() : commonDirectory;
  return path.join(stateHome, "repositories", sha256(identity));
}

export async function resolveOptimizationExperimentRegistry(workspace = ".") {
  return path.join(await resolveOptimizationRepositoryStateRoot(workspace), "optimizer", "experiments");
}

export async function readRegisteredOptimizationExperiments(directory) {
  const names = await readdir(directory).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const experiments = [];
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    experiments.push(assertOptimizationExperimentV1(JSON.parse(await readFile(path.join(directory, name), "utf8"))));
  }
  return experiments;
}

export function resolveOptimizerClusterDirectoryFromRegistry(directory) {
  return path.join(path.dirname(path.resolve(directory)), "clusters");
}

async function readTrustedEligibilityCard(experiment, directory) {
  const cardPath = path.join(
    resolveOptimizerClusterDirectoryFromRegistry(directory), `${experiment.clusterId}.json`
  );
  let card;
  try {
    card = assertOptimizerClusterCardV1(JSON.parse(await readFile(cardPath, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("No trusted cluster card exists for this experiment.", { cause: error });
    }
    throw error;
  }
  if (card.clusterId !== experiment.clusterId) {
    throw new Error("Trusted cluster card does not match the experiment cluster.");
  }
  if (card.cardDigest !== experiment.eligibilityClaimDigest) {
    throw new Error("Experiment eligibility claim does not match the trusted cluster card.");
  }
  if (card.eligibility.eligible !== true) {
    throw new Error("Trusted cluster card is not eligible for an optimization experiment.");
  }
  return card;
}

async function readOptionalRegisteredExperiment(target) {
  return readFile(target, "utf8").then(
    (value) => assertOptimizationExperimentV1(JSON.parse(value)),
    (error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  );
}

export async function registerOptimizationExperimentV1(experiment, directory) {
  const validated = assertOptimizationExperimentV1(experiment);
  if (validated.status !== "preregistered") throw new Error("Only preregistered experiments may enter the registry.");
  const target = path.join(directory, `${validated.experimentId}.json`);
  const registered = await readOptionalRegisteredExperiment(target);
  if (registered !== null) {
    if (JSON.stringify(registered) !== JSON.stringify(validated)) {
      throw new Error("Registered experiment content is immutable.");
    }
    throw new Error("Experiment is already registered; registration claims are single-use.");
  }
  const card = await readTrustedEligibilityCard(validated, directory);
  await mkdir(directory, { recursive: true });
  const activeDirectory = path.join(directory, "active");
  const claimDirectory = path.join(directory, "claims");
  await Promise.all([activeDirectory, claimDirectory].map((item) => mkdir(item, { recursive: true })));
  const pointer = path.join(activeDirectory, `${validated.clusterId}.json`);
  const claim = path.join(claimDirectory, `${card.cardDigest}.json`);
  let claimCreated = false;
  try {
    await writeFile(pointer, `${JSON.stringify({
      schemaVersion: 1,
      kind: "sigma.active-optimization-experiment",
      clusterId: validated.clusterId,
      experimentId: validated.experimentId,
      claimedAt: new Date().toISOString()
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const active = JSON.parse(await readFile(pointer, "utf8"));
    if (active.experimentId !== validated.experimentId) {
      throw new Error("An active experiment already exists for this cluster.", { cause: error });
    }
    throw new Error("The active experiment registration is incomplete; manual state review is required.", { cause: error });
  }
  try {
    await writeFile(claim, `${JSON.stringify({
      schemaVersion: 1,
      kind: "sigma.optimizer-eligibility-claim",
      cardDigest: card.cardDigest,
      clusterId: validated.clusterId,
      experimentId: validated.experimentId,
      claimedAt: new Date().toISOString()
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    claimCreated = true;
    await writeFile(target, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return target;
  } catch (error) {
    if (claimCreated) await rm(claim, { force: true });
    await rm(pointer, { force: true });
    if (error?.code === "EEXIST") {
      throw new Error("This trusted eligibility claim has already been consumed.", { cause: error });
    }
    throw error;
  }
}

export async function readRegisteredOptimizationExperiment(experimentId, directory) {
  return assertOptimizationExperimentV1(JSON.parse(await readFile(path.join(directory, `${experimentId}.json`), "utf8")));
}

async function updateRegisteredExperiment(experiment, directory, transition) {
  const target = path.join(directory, `${experiment.experimentId}.json`);
  const current = await readFile(target, "utf8").then((value) => assertOptimizationExperimentV1(JSON.parse(value))).catch((error) => {
    if (error?.code === "ENOENT") throw new Error("Experiment must be registered before it can be updated.");
    throw error;
  });
  if (current.experimentId !== experiment.experimentId || current.clusterId !== experiment.clusterId) {
    throw new Error("Registered experiment identity does not match the requested transition.");
  }
  const pointer = JSON.parse(await readFile(path.join(directory, "active", `${experiment.clusterId}.json`), "utf8"));
  if (pointer.experimentId !== experiment.experimentId) throw new Error("Active experiment pointer does not match.");
  if (transition === "freeze") {
    if (current.status !== "preregistered" || experiment.status !== "frozen") {
      throw new Error("Registry freeze requires a preregistered-to-frozen transition.");
    }
  } else if (transition === "close") {
    if (!isActiveExperimentStatus(current.status) || isActiveExperimentStatus(experiment.status)
      || current.candidate.candidateDigest !== experiment.candidate.candidateDigest
      || current.candidate.frozenAt !== experiment.candidate.frozenAt
      || current.closedAt !== null || experiment.closedAt === null) {
      throw new Error("Registry close must preserve the frozen candidate.");
    }
  } else {
    throw new Error("Unsupported experiment registry transition.");
  }
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(experiment, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temp, target);
}

export async function closeOptimizationExperimentV1(
  input, status, directory, closedAt = new Date().toISOString()
) {
  if (!new Set(["accepted", "rejected", "rolled_back"]).has(status)) {
    throw new Error("Experiment may close only as accepted, rejected, or rolled_back.");
  }
  const experiment = structuredClone(assertOptimizationExperimentV1(input));
  if (!isActiveExperimentStatus(experiment.status)) throw new Error("Experiment is already closed.");
  experiment.status = status;
  experiment.closedAt = closedAt;
  assertOptimizationExperimentV1(experiment);
  await updateRegisteredExperiment(experiment, directory, "close");
  const pointer = path.join(directory, "active", `${experiment.clusterId}.json`);
  const active = JSON.parse(await readFile(pointer, "utf8"));
  if (active.experimentId !== experiment.experimentId) throw new Error("Active experiment pointer does not match.");
  await rm(pointer, { force: false });
  return assertOptimizationExperimentV1(experiment);
}

function pairDimensionsRegressed(pair) {
  return REQUIRED_DIMENSIONS.some((dimension) => {
    const baseline = pair.baseline.dimensions?.[dimension];
    const candidate = pair.candidate.dimensions?.[dimension];
    return baseline === "pass" && candidate !== "pass";
  });
}

function binaryResult(pairs) {
  let wins = 0;
  let losses = 0;
  for (const pair of pairs) {
    if (pair.candidate.primary === true && pair.baseline.primary !== true) wins += 1;
    if (pair.baseline.primary === true && pair.candidate.primary !== true) losses += 1;
  }
  return { accepted: wins >= 2 && losses === 0, wins, losses, ties: pairs.length - wins - losses };
}

function relativeChange(baseline, candidate, direction) {
  if (baseline === candidate) return 0;
  if (baseline === 0) return direction === "increase" ? (candidate > 0 ? 1 : -1) : (candidate < 0 ? 1 : -1);
  return direction === "increase" ? (candidate - baseline) / Math.abs(baseline) : (baseline - candidate) / Math.abs(baseline);
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
}

function continuousResult(pairs, metric) {
  const changes = pairs.map((pair) => relativeChange(pair.baseline.primary, pair.candidate.primary, metric.direction));
  const pairedMedianChange = median(changes);
  return {
    accepted: changes.every((value) => value >= 0) && pairedMedianChange >= metric.minimumRelativeChange,
    allNonInferior: changes.every((value) => value >= 0),
    pairedMedianChange
  };
}

function validPair(pair) {
  if (!pair || pair.validity !== "valid") return false;
  if (!pair.baseline || !pair.candidate) return false;
  return REQUIRED_DIMENSIONS.every((key) => ["pass", "fail"].includes(pair.baseline.dimensions?.[key])
    && ["pass", "fail"].includes(pair.candidate.dimensions?.[key]));
}

export function decideFrozenOptimizationGate(input, pairs) {
  const experiment = assertOptimizationExperimentV1(input);
  if (experiment.status !== "frozen" && experiment.status !== "draft_pr") {
    throw new Error("The external gate only accepts a frozen candidate.");
  }
  if (!Array.isArray(pairs) || pairs.length !== 3 || pairs.some((pair) => !validPair(pair))) {
    // Formal evidence is single-shot: an invalid fixed pair rejects this
    // candidate without retry while preserving the reason for human review.
    return { decision: "rejected", reason: "invalid_pair" };
  }
  if (pairs.some(pairDimensionsRegressed)) return { decision: "rejected", reason: "product_guardrail_regression" };
  const result = experiment.primaryMetric.kind === "binary"
    ? binaryResult(pairs)
    : continuousResult(pairs, experiment.primaryMetric);
  return { decision: result.accepted ? "accepted" : "rejected", reason: result.accepted ? "primary_metric_met" : "primary_metric_not_met", summary: result };
}

async function cli(argv) {
  const [command, file, value] = argv;
  if (!command || !file) throw new Error("Usage: optimization-experiment.mjs <validate|register|freeze> <file> [value]");
  const experiment = JSON.parse(await readFile(path.resolve(file), "utf8"));
  if (command === "validate") {
    assertOptimizationExperimentV1(experiment);
    process.stdout.write("OptimizationExperimentV1 is valid.\n");
    return;
  }
  const registry = await resolveOptimizationExperimentRegistry();
  if (command === "register") {
    const target = await registerOptimizationExperimentV1(experiment, registry);
    process.stdout.write(`OptimizationExperimentV1 registered: ${target}\n`);
    return;
  }
  if (command === "close") throw new Error("Accepted/rejected transitions belong only to the sealed external gate.");
  if (command !== "freeze" || !value) throw new Error("freeze requires a candidate SHA-256 digest.");
  const frozen = await freezeRegisteredOptimizationExperimentV1(experiment, value, registry);
  await writeFile(path.resolve(file), `${JSON.stringify(frozen, null, 2)}\n`, "utf8");
  process.stdout.write("OptimizationExperimentV1 candidate frozen.\n");
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) cli(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
