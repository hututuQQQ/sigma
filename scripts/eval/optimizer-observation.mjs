import { canonicalJson, digest as sha256 } from "./common.mjs";
import {
  assertOptimizationExperimentV1,
  assertOptimizerClusterCardV1,
  assertOptimizerObservationV1,
  isActiveExperimentStatus,
  optimizerClusterCardDigestV1
} from "./optimizer-schema.mjs";

const DEFAULT_PLATFORM = "unavailable";
const DEFAULT_DIGEST = sha256("unavailable");
const SUBSYSTEM_BY_FAMILY = {
  workspace_transaction: "workspace_transaction",
  checkpoint_recovery: "checkpoint_recovery",
  execution_broker: "execution_broker",
  execution_sandbox: "execution_sandbox",
  execution_capability: "execution_capability",
  execution_output_encoding: "execution_output_encoding",
  execution_timeout: "execution_timeout",
  failure_convergence: "failure_convergence"
};

function stableDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : sha256(String(value ?? "unavailable"));
}

function subjectDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : DEFAULT_DIGEST;
}

function stableCode(value, fallback) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  return /^[a-z][a-z0-9_]{1,95}$/u.test(normalized) ? normalized : fallback;
}

function subjectMetadata(input = {}) {
  const platform = input.platform === "win32" || input.platform === "linux" ? input.platform : DEFAULT_PLATFORM;
  return {
    productDigest: subjectDigest(input.productDigest),
    configurationDigest: subjectDigest(input.configurationDigest),
    environmentDigest: subjectDigest(input.environmentDigest),
    platform,
    surface: stableCode(input.surface, "unknown_surface"),
    provider: stableCode(input.provider, "unknown_provider"),
    model: String(input.model ?? "unavailable").slice(0, 128)
  };
}

function provenanceMetadata(input = {}) {
  const value = input.provenance;
  if (value?.status === "attested") {
    return {
      status: "attested",
      reason: null,
      attestationDigest: value.attestationDigest,
      buildArtifactDigest: value.buildArtifactDigest
    };
  }
  return {
    status: "unavailable",
    reason: value?.reason ?? "durable_subject_attestation_missing",
    attestationDigest: null,
    buildArtifactDigest: null
  };
}

function terminalMetadata(metrics) {
  const status = metrics.terminal?.status;
  const supported = new Set(["completed", "needs_input", "failed", "cancelled", "incomplete"]);
  return {
    status: supported.has(status) ? status : "incomplete",
    code: typeof metrics.terminal?.code === "string"
      ? stableCode(metrics.terminal.code, "unknown_failure")
      : null
  };
}

function episodeFingerprint(episode, platform) {
  const family = stableCode(episode.family, "unknown_infrastructure");
  const diagnosticCodes = [...new Set((episode.codes ?? []).map((item) => stableCode(item, "unknown_failure")))].sort();
  return {
    subsystem: SUBSYSTEM_BY_FAMILY[family] ?? "infrastructure_failure",
    failureFamily: family,
    diagnosticCodes: diagnosticCodes.length > 0 ? diagnosticCodes : ["unknown_failure"],
    toolFamily: stableCode(episode.toolFamily, family.startsWith("execution_") ? "process" : "runtime"),
    effectClass: stableCode(episode.effectClass, family.startsWith("execution_") ? "process_spawn" : "state_transition"),
    platformClass: platform,
    semanticProgress: episode.status === "recovered" ? "recovered" : "none"
  };
}

function evidenceReferences(episode, terminal) {
  const references = [{
    seq: Number.isSafeInteger(episode.firstSeq) ? episode.firstSeq : 0,
    type: "failure_started",
    diagnosticCodes: [...new Set(episode.codes ?? ["unknown_failure"])].map((item) => stableCode(item, "unknown_failure")),
    effectClass: stableCode(episode.effectClass, "process_spawn"),
    semanticProgress: false
  }];
  if (Number.isSafeInteger(episode.eligibleSeq)) references.push({
    seq: episode.eligibleSeq,
    type: "fail_fast_eligible",
    diagnosticCodes: references[0].diagnosticCodes,
    effectClass: references[0].effectClass,
    semanticProgress: false
  });
  if (Number.isSafeInteger(episode.missedSeq)) references.push({
    seq: episode.missedSeq,
    type: "fail_fast_missed",
    diagnosticCodes: references[0].diagnosticCodes,
    effectClass: references[0].effectClass,
    semanticProgress: false
  });
  if (Number.isSafeInteger(episode.terminalSeq ?? terminal.seq)) references.push({
    seq: episode.terminalSeq ?? terminal.seq,
    type: "terminal",
    diagnosticCodes: references[0].diagnosticCodes,
    effectClass: references[0].effectClass,
    semanticProgress: episode.status === "recovered"
  });
  return references;
}

function metricNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function observationMetrics(metrics, episode) {
  const counts = metrics.counts || {};
  const usage = metrics.usageTotals || {};
  const deltas = metrics.workspaceDeltas || {};
  const attempts = metricNumber(episode.attempts);
  return {
    durationMs: metricNumber(metrics.durationMs),
    modelTurns: metricNumber(counts.modelTurns),
    toolCalls: metricNumber(counts.toolCalls),
    toolFailures: metricNumber(counts.toolFailures),
    inputTokens: metricNumber(usage.inputTokens),
    outputTokens: metricNumber(usage.outputTokens),
    costMicroUsd: metricNumber(usage.costMicroUsd),
    sameRootAttempts: attempts,
    overshoot: metricNumber(episode.overshoot, Math.max(0, attempts - 3)),
    workspaceMutations: metricNumber(deltas.count)
  };
}

function isBlocker(metrics, episode) {
  if (["missed", "recovery_failed", "failed"].includes(episode.status)) return true;
  if ((episode.attempts ?? 0) > 3) return true;
  return metrics.terminal?.status === "failed" && (episode.attempts ?? 0) >= 3;
}

function createObservation(metrics, episode, metadata, observedAt) {
  const subject = subjectMetadata(metadata);
  const provenance = provenanceMetadata(metadata);
  const fingerprint = episodeFingerprint(episode, subject.platform);
  const clusterId = sha256(canonicalJson(fingerprint));
  const sourceDigest = stableDigest(metadata.sourceDigest ?? metrics.sessionId ?? metrics.runId ?? observedAt);
  const observation = {
    schemaVersion: 1,
    kind: "sigma.optimizer-observation",
    observationId: sha256(canonicalJson({ sourceDigest, clusterId, observedAt })),
    sourceDigest,
    observedAt,
    sourceKind: metadata.sourceKind === "generic_conformance" ? "generic_conformance" : "real_session",
    subject,
    provenance,
    terminal: terminalMetadata(metrics),
    clusterId,
    fingerprint,
    metrics: observationMetrics(metrics, episode),
    evidence: evidenceReferences(episode, metrics.terminal ?? {}),
    blocker: isBlocker(metrics, episode)
  };
  return assertOptimizerObservationV1(observation);
}

export function createOptimizerObservations(metrics, metadata = {}) {
  const episodes = metrics.failureConvergence?.episodes;
  if (!Array.isArray(episodes)) return [];
  const observedAt = metadata.observedAt ?? metrics.timestamps?.endedAt ?? new Date().toISOString();
  return episodes.flatMap((episode) => {
    const observations = [createObservation(metrics, episode, metadata, observedAt)];
    if (episode.failFastMissed === true || metricNumber(episode.overshoot) > 0) {
      observations.push(createObservation(metrics, {
        ...episode,
        family: "failure_convergence",
        codes: ["fail_fast_missed"],
        status: "missed",
        toolFamily: stableCode(episode.toolFamily, "infrastructure"),
        effectClass: stableCode(episode.effectClass, "state_transition")
      }, metadata, observedAt));
    }
    return observations;
  });
}

function windowedObservations(items, asOf, days) {
  const oldest = Date.parse(asOf) - days * 86_400_000;
  return items.filter((item) => {
    const observed = Date.parse(item.observedAt);
    return Number.isFinite(observed) && observed >= oldest && observed <= Date.parse(asOf);
  });
}

function clusterExperimentState(experiments, clusterId) {
  const matching = experiments.filter((item) => item.clusterId === clusterId);
  const closedAt = matching.map((item) => item.closedAt).filter(Boolean).reduce((latest, item) => (
    latest === null || Date.parse(item) > Date.parse(latest) ? item : latest
  ), null);
  return {
    active: matching.some((item) => isActiveExperimentStatus(item.status)),
    latestClosedAt: closedAt
  };
}

function aggregateMetrics(observations) {
  const sum = (key) => observations.reduce((total, item) => total + item.metrics[key], 0);
  return {
    occurrences: observations.length,
    blockers: observations.filter((item) => item.blocker).length,
    sameRootAttempts: sum("sameRootAttempts"),
    overshoot: sum("overshoot"),
    toolFailures: sum("toolFailures"),
    costMicroUsd: sum("costMicroUsd"),
    workspaceMutations: sum("workspaceMutations")
  };
}

function clusterCard(clusterId, observations, experimentState, asOf, days) {
  const recent = windowedObservations(observations, asOf, days);
  const attested = recent.filter((item) => item.provenance.status === "attested");
  const evidence = experimentState.latestClosedAt === null ? attested : attested.filter(
    (item) => Date.parse(item.observedAt) > Date.parse(experimentState.latestClosedAt)
  );
  const orderedEvidence = [...evidence].sort((left, right) => left.observationId.localeCompare(right.observationId));
  const independent = new Set(orderedEvidence.map((item) => item.sourceDigest)).size;
  const blockers = orderedEvidence.filter((item) => item.blocker).length;
  const eligibleWithoutActive = blockers > 0 || independent >= 3;
  const reason = experimentState.active ? "active_experiment" : blockers > 0
    ? "blocker" : independent >= 3 ? "three_independent_observations"
      : evidence.length === 0 && recent.some((item) => item.provenance.status !== "attested")
        ? "provenance_unavailable"
        : experimentState.latestClosedAt === null ? "insufficient_evidence" : "awaiting_new_evidence";
  const unsigned = {
    schemaVersion: 1,
    kind: "sigma.optimizer-cluster-card",
    clusterId,
    generatedAt: asOf,
    fingerprint: orderedEvidence[0]?.fingerprint ?? recent[0]?.fingerprint ?? observations[0].fingerprint,
    window: {
      days,
      latestClosedAt: experimentState.latestClosedAt,
      independentOccurrences: independent,
      blockerOccurrences: blockers
    },
    eligibility: { eligible: eligibleWithoutActive && !experimentState.active, reason },
    metrics: aggregateMetrics(orderedEvidence),
    observationRefs: orderedEvidence.map((item) => item.observationId)
  };
  return assertOptimizerClusterCardV1({ ...unsigned, cardDigest: optimizerClusterCardDigestV1(unsigned) });
}

export function createOptimizerClusterCards(input, experiments = [], options = {}) {
  const observations = input.map(assertOptimizerObservationV1);
  const registered = experiments.map(assertOptimizationExperimentV1);
  const grouped = new Map();
  for (const observation of observations) {
    const group = grouped.get(observation.clusterId) ?? [];
    group.push(observation);
    grouped.set(observation.clusterId, group);
  }
  const asOf = options.asOf ?? new Date().toISOString();
  const days = options.days ?? 7;
  return [...grouped.entries()].map(([clusterId, items]) => clusterCard(
    clusterId, items, clusterExperimentState(registered, clusterId), asOf, days
  )).sort((left, right) => left.clusterId.localeCompare(right.clusterId));
}
