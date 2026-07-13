import { createHash } from "node:crypto";

const HEX_64 = /^[a-f0-9]{64}$/u;
const UNAVAILABLE_DIGEST = createHash("sha256").update("unavailable").digest("hex");
const SAFE_CODE = /^[a-z][a-z0-9_]{1,95}$/u;
const SAFE_RELATIVE = /^(?![./\\])(?!.{0,2}(?:[/\\]|$))[A-Za-z0-9_*?{}[\]./@+-]+$/u;
const ABSOLUTE_PATH = /(?:file:\/\/|(?:^|[\s("'=])(?:[A-Za-z]:[\\/]|\\\\(?:[.?][\\/])?|\/(?!\/))[^\s"')\]]*)/iu;
const TAINTED_CONTENT = /(?:\bbenchmark\b|\b(?:scenario|task|dataset|fixture|verifier|reward|score)[_-]?(?:id|name|result|output)?\b|\bexpected[_ -]?(?:output|result)\b|\b(?:raw|original)[_ -]?prompt\b)/iu;
const FORBIDDEN_KEY = /(?:benchmark|suite|scenario|task(?:id|name)?|dataset|fixture|verifier|reward|score|expected(?:output|result)?|prompt|allowedpaths?|budget|stdout|stderr|command|arguments?|raw(?:trace|event|content)?|absolutepaths?)/iu;
const ACTIVE_EXPERIMENT = new Set(["preregistered", "frozen", "draft_pr"]);
const OBSERVATION_SOURCES = new Set(["real_session", "generic_conformance"]);
const TERMINAL_STATUSES = new Set(["completed", "needs_input", "failed", "cancelled", "incomplete"]);
const EXPERIMENT_STATUSES = new Set([
  "preregistered", "frozen", "draft_pr", "accepted", "rejected", "rolled_back"
]);
const CLUSTER_CARD_REASONS = new Set([
  "active_experiment", "awaiting_new_evidence", "blocker",
  "three_independent_observations", "insufficient_evidence", "provenance_unavailable"
]);
const PROVENANCE_REASONS = new Set([
  "durable_subject_attestation_missing", "durable_subject_attestation_invalid",
  "durable_subject_attestation_conflict", "durable_model_identity_conflict", "external_evidence_untrusted"
]);
const EVIDENCE_TYPES = new Set(["failure_started", "fail_fast_eligible", "fail_fast_missed", "terminal"]);
const GENERALITY_EVIDENCE = new Set(["unit_test", "property_test", "generic_reproduction"]);
const DIRECTIONS = new Set(["increase", "decrease"]);
const PRIMARY_KINDS = new Set(["binary", "continuous"]);
export const OPTIMIZATION_PRIMARY_METRICS_V1 = Object.freeze({
  stable_run: Object.freeze({ kind: "binary", direction: "increase" }),
  correctness: Object.freeze({ kind: "binary", direction: "increase" }),
  safety: Object.freeze({ kind: "binary", direction: "increase" }),
  delivery: Object.freeze({ kind: "binary", direction: "increase" }),
  fail_fast_missed: Object.freeze({ kind: "continuous", direction: "decrease" }),
  failure_overshoot: Object.freeze({ kind: "continuous", direction: "decrease" }),
  recovery_failed: Object.freeze({ kind: "continuous", direction: "decrease" }),
  mutation_requests: Object.freeze({ kind: "continuous", direction: "decrease" }),
  write_contract_failures: Object.freeze({ kind: "continuous", direction: "decrease" }),
  cost_per_success: Object.freeze({ kind: "continuous", direction: "decrease" }),
  pass_rate: Object.freeze({ kind: "continuous", direction: "increase" })
});
const GUARDRAIL_RULES = new Set(["no_regression", "zero_regression", "maximum"]);
const PROHIBITED_MODIFICATION_ROOTS = [
  "test-fixtures/", "scripts/", ".github/", ".agents/", "bench", "benchmark", "tests/agent-eval", "tests/bench"
];
const ALLOWED_MODIFICATION_ROOTS = ["packages/", "native/", "tests/"];
const SAFE_BOUNDARY_KEYS = new Set(["noVerifierInput", "noPostVerifierRetry"]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown field(s): ${unknown.join(", ")}.`);
}

function rejectTaintedStrings(value, label) {
  if (typeof value === "string") {
    if (ABSOLUTE_PATH.test(value)) throw new Error(`${label} must not contain an absolute or device path.`);
    if (TAINTED_CONTENT.test(value)) throw new Error(`${label} contains evaluator-only identity or feedback content.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectTaintedStrings(item, `${label}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (SAFE_BOUNDARY_KEYS.has(key)) continue;
      rejectTaintedStrings(item, `${label}.${key}`);
    }
  }
}

function requiredString(value, label, maximum = 512) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters.`);
  }
  if (ABSOLUTE_PATH.test(value)) throw new Error(`${label} must not contain an absolute path.`);
  return value;
}

function enumValue(value, allowed, label) {
  if (!allowed.has(value)) throw new Error(`${label} is not supported.`);
  return value;
}

function natural(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
  return value;
}

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`);
  }
  return value;
}

function date(value, label) {
  requiredString(value, label, 64);
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO date-time.`);
  return value;
}

function digest(value, label) {
  if (!HEX_64.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function code(value, label) {
  if (!SAFE_CODE.test(value)) throw new Error(`${label} must be a stable snake_case code.`);
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
  return value;
}

function stringArray(value, label, validator = requiredString) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((item, index) => validator(item, `${label}[${index}]`));
}

function rejectForbiddenKeys(value, location = "value") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectForbiddenKeys(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key) && !SAFE_BOUNDARY_KEYS.has(key)) {
      throw new Error(`${location}.${key} is forbidden at the optimizer boundary.`);
    }
    rejectForbiddenKeys(item, `${location}.${key}`);
  }
}

function assertSubject(value) {
  object(value, "observation.subject");
  exactKeys(value, ["productDigest", "configurationDigest", "environmentDigest", "platform", "surface", "provider", "model"], "observation.subject");
  digest(value.productDigest, "observation.subject.productDigest");
  digest(value.configurationDigest, "observation.subject.configurationDigest");
  digest(value.environmentDigest, "observation.subject.environmentDigest");
  enumValue(value.platform, new Set(["win32", "linux", "unavailable"]), "observation.subject.platform");
  code(value.surface, "observation.subject.surface");
  code(value.provider, "observation.subject.provider");
  requiredString(value.model, "observation.subject.model", 128);
}

function assertProvenance(value) {
  object(value, "observation.provenance");
  exactKeys(value, ["status", "reason", "attestationDigest", "buildArtifactDigest"], "observation.provenance");
  enumValue(value.status, new Set(["attested", "unavailable"]), "observation.provenance.status");
  if (value.status === "attested") {
    if (value.reason !== null) throw new Error("An attested observation provenance cannot include an unavailable reason.");
    digest(value.attestationDigest, "observation.provenance.attestationDigest");
    digest(value.buildArtifactDigest, "observation.provenance.buildArtifactDigest");
    if (value.attestationDigest === UNAVAILABLE_DIGEST || value.buildArtifactDigest === UNAVAILABLE_DIGEST) {
      throw new Error("Attested observation provenance requires available attestation digests.");
    }
    return;
  }
  enumValue(value.reason, PROVENANCE_REASONS, "observation.provenance.reason");
  if (value.attestationDigest !== null || value.buildArtifactDigest !== null) {
    throw new Error("Unavailable observation provenance cannot claim attestation digests.");
  }
}

function assertTerminal(value) {
  object(value, "observation.terminal");
  exactKeys(value, ["status", "code"], "observation.terminal");
  enumValue(value.status, TERMINAL_STATUSES, "observation.terminal.status");
  if (value.code !== null) code(value.code, "observation.terminal.code");
}

function assertFingerprint(value) {
  object(value, "observation.fingerprint");
  exactKeys(value, ["subsystem", "failureFamily", "diagnosticCodes", "toolFamily", "effectClass", "platformClass", "semanticProgress"], "observation.fingerprint");
  code(value.subsystem, "observation.fingerprint.subsystem");
  code(value.failureFamily, "observation.fingerprint.failureFamily");
  stringArray(value.diagnosticCodes, "observation.fingerprint.diagnosticCodes", code);
  code(value.toolFamily, "observation.fingerprint.toolFamily");
  code(value.effectClass, "observation.fingerprint.effectClass");
  code(value.platformClass, "observation.fingerprint.platformClass");
  enumValue(value.semanticProgress, new Set(["none", "partial", "recovered"]), "observation.fingerprint.semanticProgress");
}

function assertEvidence(value, index) {
  const label = `observation.evidence[${index}]`;
  object(value, label);
  exactKeys(value, ["seq", "type", "diagnosticCodes", "effectClass", "semanticProgress"], label);
  natural(value.seq, `${label}.seq`);
  enumValue(value.type, EVIDENCE_TYPES, `${label}.type`);
  stringArray(value.diagnosticCodes, `${label}.diagnosticCodes`, code);
  code(value.effectClass, `${label}.effectClass`);
  boolean(value.semanticProgress, `${label}.semanticProgress`);
}

function assertMetrics(value) {
  object(value, "observation.metrics");
  const keys = [
    "durationMs", "modelTurns", "toolCalls", "toolFailures", "inputTokens", "outputTokens",
    "costMicroUsd", "sameRootAttempts", "overshoot", "workspaceMutations"
  ];
  exactKeys(value, keys, "observation.metrics");
  for (const key of keys) finite(value[key], `observation.metrics.${key}`);
}

function assertAggregateMetrics(value, label = "clusterCard.metrics") {
  object(value, label);
  const keys = [
    "occurrences", "blockers", "sameRootAttempts", "overshoot", "toolFailures",
    "costMicroUsd", "workspaceMutations"
  ];
  exactKeys(value, keys, label);
  for (const key of keys) finite(value[key], `${label}.${key}`);
}

export function assertOptimizerObservationV1(input) {
  const value = object(input, "observation");
  rejectForbiddenKeys(value, "observation");
  rejectTaintedStrings(value, "observation");
  exactKeys(value, [
    "schemaVersion", "kind", "observationId", "sourceDigest", "observedAt", "sourceKind",
    "subject", "provenance", "terminal", "clusterId", "fingerprint", "metrics", "evidence", "blocker"
  ], "observation");
  if (value.schemaVersion !== 1 || value.kind !== "sigma.optimizer-observation") throw new Error("Unsupported optimizer observation schema.");
  digest(value.observationId, "observation.observationId");
  digest(value.sourceDigest, "observation.sourceDigest");
  date(value.observedAt, "observation.observedAt");
  enumValue(value.sourceKind, OBSERVATION_SOURCES, "observation.sourceKind");
  assertSubject(value.subject);
  assertProvenance(value.provenance);
  if (value.provenance.status === "attested" && [
    value.subject.productDigest, value.subject.configurationDigest, value.subject.environmentDigest
  ].includes(UNAVAILABLE_DIGEST)) {
    throw new Error("Attested observation provenance requires available subject digests.");
  }
  assertTerminal(value.terminal);
  digest(value.clusterId, "observation.clusterId");
  assertFingerprint(value.fingerprint);
  assertMetrics(value.metrics);
  if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 16) {
    throw new Error("observation.evidence must contain 1 to 16 redacted references.");
  }
  value.evidence.forEach(assertEvidence);
  boolean(value.blocker, "observation.blocker");
  return value;
}

export function optimizerClusterCardDigestV1(input) {
  const value = object(input, "clusterCard");
  const unsigned = { ...value };
  delete unsigned.cardDigest;
  // generatedAt is audit metadata, not eligibility content. Keeping it out of
  // the claim makes an unchanged evidence snapshot stable across collectors.
  delete unsigned.generatedAt;
  return createHash("sha256").update(canonical(unsigned)).digest("hex");
}

export function assertOptimizerClusterCardV1(input) {
  const value = object(input, "clusterCard");
  rejectForbiddenKeys(value, "clusterCard");
  rejectTaintedStrings(value, "clusterCard");
  exactKeys(value, [
    "schemaVersion", "kind", "cardDigest", "clusterId", "generatedAt", "fingerprint",
    "window", "eligibility", "metrics", "observationRefs"
  ], "clusterCard");
  if (value.schemaVersion !== 1 || value.kind !== "sigma.optimizer-cluster-card") {
    throw new Error("Unsupported optimizer cluster card schema.");
  }
  digest(value.cardDigest, "clusterCard.cardDigest");
  digest(value.clusterId, "clusterCard.clusterId");
  date(value.generatedAt, "clusterCard.generatedAt");
  assertFingerprint(value.fingerprint);
  object(value.window, "clusterCard.window");
  exactKeys(value.window, [
    "days", "latestClosedAt", "independentOccurrences", "blockerOccurrences"
  ], "clusterCard.window");
  finite(value.window.days, "clusterCard.window.days");
  if (value.window.days <= 0) throw new Error("clusterCard.window.days must be positive.");
  if (value.window.latestClosedAt !== null) date(value.window.latestClosedAt, "clusterCard.window.latestClosedAt");
  natural(value.window.independentOccurrences, "clusterCard.window.independentOccurrences");
  natural(value.window.blockerOccurrences, "clusterCard.window.blockerOccurrences");
  object(value.eligibility, "clusterCard.eligibility");
  exactKeys(value.eligibility, ["eligible", "reason"], "clusterCard.eligibility");
  boolean(value.eligibility.eligible, "clusterCard.eligibility.eligible");
  enumValue(value.eligibility.reason, CLUSTER_CARD_REASONS, "clusterCard.eligibility.reason");
  assertAggregateMetrics(value.metrics);
  stringArray(value.observationRefs, "clusterCard.observationRefs", digest);
  if (new Set(value.observationRefs).size !== value.observationRefs.length) {
    throw new Error("clusterCard.observationRefs must be unique.");
  }
  if (value.cardDigest !== optimizerClusterCardDigestV1(value)) {
    throw new Error("clusterCard.cardDigest must be the canonical hash of the card.");
  }
  return value;
}

function relativeReference(value, label) {
  requiredString(value, label, 256);
  const portable = value.replaceAll("\\", "/");
  if (!SAFE_RELATIVE.test(portable) || portable.split("/").includes("..")) {
    throw new Error(`${label} must be a portable repository-relative reference.`);
  }
  return portable;
}

function assertInvariant(value) {
  object(value, "experiment.invariant");
  exactKeys(value, ["statement", "subsystem", "generalityEvidence"], "experiment.invariant");
  requiredString(value.statement, "experiment.invariant.statement", 512);
  code(value.subsystem, "experiment.invariant.subsystem");
  if (!Array.isArray(value.generalityEvidence) || value.generalityEvidence.length < 1) {
    throw new Error("experiment.invariant.generalityEvidence must not be empty.");
  }
  for (const [index, item] of value.generalityEvidence.entries()) {
    const label = `experiment.invariant.generalityEvidence[${index}]`;
    object(item, label);
    exactKeys(item, ["kind", "reference"], label);
    enumValue(item.kind, GENERALITY_EVIDENCE, `${label}.kind`);
    relativeReference(item.reference, `${label}.reference`);
  }
}

function assertModificationScope(value) {
  object(value, "experiment.modificationScope");
  exactKeys(value, ["allowedGlobs"], "experiment.modificationScope");
  const globs = stringArray(value.allowedGlobs, "experiment.modificationScope.allowedGlobs", relativeReference);
  if (globs.length < 1) throw new Error("experiment.modificationScope.allowedGlobs must not be empty.");
  for (const glob of globs) {
    const lower = glob.toLowerCase();
    if (PROHIBITED_MODIFICATION_ROOTS.some((root) => lower.startsWith(root))) {
      throw new Error(`Optimizer modifications may not target '${glob}'.`);
    }
    if (!ALLOWED_MODIFICATION_ROOTS.some((root) => lower.startsWith(root))) {
      throw new Error(`Optimizer modifications must stay in approved product or ordinary-test roots: '${glob}'.`);
    }
  }
}

function assertPrimaryMetric(value) {
  object(value, "experiment.primaryMetric");
  exactKeys(value, ["name", "kind", "direction", "minimumRelativeChange"], "experiment.primaryMetric");
  code(value.name, "experiment.primaryMetric.name");
  enumValue(value.kind, PRIMARY_KINDS, "experiment.primaryMetric.kind");
  enumValue(value.direction, DIRECTIONS, "experiment.primaryMetric.direction");
  const contract = OPTIMIZATION_PRIMARY_METRICS_V1[value.name];
  if (!contract) throw new Error(`experiment.primaryMetric.name '${value.name}' is not supported by the frozen gate.`);
  if (value.kind !== contract.kind || value.direction !== contract.direction) {
    throw new Error(`experiment.primaryMetric '${value.name}' requires kind=${contract.kind} and direction=${contract.direction}.`);
  }
  const change = finite(value.minimumRelativeChange, "experiment.primaryMetric.minimumRelativeChange");
  if (change > 1) throw new Error("experiment.primaryMetric.minimumRelativeChange must be at most 1.");
  if (value.kind === "continuous" && change < 0.2) {
    throw new Error("A continuous primary metric must preregister at least 20% relative improvement.");
  }
  if (value.kind === "binary" && change !== 0) {
    throw new Error("A binary primary metric must use minimumRelativeChange=0.");
  }
}

function assertGuardrails(value) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error("experiment.guardrails must contain exactly correctness, safety, and delivery.");
  }
  for (const [index, item] of value.entries()) {
    const label = `experiment.guardrails[${index}]`;
    object(item, label);
    exactKeys(item, ["metric", "rule", "limit"], label);
    code(item.metric, `${label}.metric`);
    enumValue(item.rule, GUARDRAIL_RULES, `${label}.rule`);
    if (item.rule !== "no_regression" || item.limit !== null) {
      throw new Error(`${label} must use rule=no_regression and limit=null.`);
    }
  }
  const mandatory = new Set(["correctness", "safety", "delivery"]);
  for (const item of value) mandatory.delete(item.metric);
  if (mandatory.size > 0) throw new Error(`experiment.guardrails is missing: ${[...mandatory].join(", ")}.`);
}

function assertRollback(value) {
  object(value, "experiment.rollback");
  exactKeys(value, ["trigger", "steps"], "experiment.rollback");
  requiredString(value.trigger, "experiment.rollback.trigger", 512);
  const steps = stringArray(value.steps, "experiment.rollback.steps");
  if (steps.length < 1 || steps.length > 8) throw new Error("experiment.rollback.steps must contain 1 to 8 steps.");
}

function assertCandidate(value, clusterId) {
  object(value, "experiment.candidate");
  exactKeys(value, ["branch", "baseDigest", "candidateDigest", "frozenAt"], "experiment.candidate");
  const expected = branchForCluster(clusterId);
  if (value.branch !== expected) throw new Error(`experiment.candidate.branch must be '${expected}'.`);
  digest(value.baseDigest, "experiment.candidate.baseDigest");
  if (value.candidateDigest !== null) digest(value.candidateDigest, "experiment.candidate.candidateDigest");
  if (value.frozenAt !== null) date(value.frozenAt, "experiment.candidate.frozenAt");
}

function assertFairness(value) {
  object(value, "experiment.fairness");
  const keys = ["noIdentityBranching", "noVerifierInput", "noPostVerifierRetry", "oneActiveExperiment"];
  exactKeys(value, keys, "experiment.fairness");
  for (const key of keys) {
    if (value[key] !== true) throw new Error(`experiment.fairness.${key} must be true.`);
  }
}

function assertAbPolicy(value) {
  object(value, "experiment.abPolicy");
  exactKeys(value, ["pairs", "order", "invalidPairAction"], "experiment.abPolicy");
  if (value.pairs !== 3) throw new Error("experiment.abPolicy.pairs must be frozen at 3.");
  const order = stringArray(value.order, "experiment.abPolicy.order");
  if (order.join(",") !== "baseline,candidate,candidate,baseline,baseline,candidate") {
    throw new Error("experiment.abPolicy.order must use the frozen interleaved order.");
  }
  if (value.invalidPairAction !== "block") throw new Error("experiment.abPolicy.invalidPairAction must be block.");
}

export function assertOptimizationExperimentV1(input) {
  const value = object(input, "experiment");
  rejectForbiddenKeys(value, "experiment");
  rejectTaintedStrings(value, "experiment");
  exactKeys(value, [
    "schemaVersion", "kind", "experimentId", "clusterId", "eligibilityClaimDigest", "createdAt",
    "closedAt", "status", "invariant",
    "hypothesis", "modificationScope", "primaryMetric", "guardrails", "rollback", "candidate",
    "fairness", "abPolicy"
  ], "experiment");
  if (value.schemaVersion !== 1 || value.kind !== "sigma.optimization-experiment") throw new Error("Unsupported optimization experiment schema.");
  digest(value.experimentId, "experiment.experimentId");
  digest(value.clusterId, "experiment.clusterId");
  digest(value.eligibilityClaimDigest, "experiment.eligibilityClaimDigest");
  date(value.createdAt, "experiment.createdAt");
  if (value.closedAt !== null) date(value.closedAt, "experiment.closedAt");
  enumValue(value.status, EXPERIMENT_STATUSES, "experiment.status");
  assertInvariant(value.invariant);
  requiredString(value.hypothesis, "experiment.hypothesis", 1024);
  assertModificationScope(value.modificationScope);
  assertPrimaryMetric(value.primaryMetric);
  assertGuardrails(value.guardrails);
  assertRollback(value.rollback);
  assertCandidate(value.candidate, value.clusterId);
  assertFairness(value.fairness);
  assertAbPolicy(value.abPolicy);
  if (ACTIVE_EXPERIMENT.has(value.status) && value.candidate.candidateDigest === null && value.status !== "preregistered") {
    throw new Error("A frozen or draft candidate must include candidateDigest.");
  }
  if (value.status === "preregistered"
    && (value.candidate.candidateDigest !== null || value.candidate.frozenAt !== null)) {
    throw new Error("A preregistered experiment cannot include frozen candidate fields.");
  }
  if (ACTIVE_EXPERIMENT.has(value.status) && value.closedAt !== null) {
    throw new Error("An active experiment cannot include closedAt.");
  }
  if (!ACTIVE_EXPERIMENT.has(value.status) && value.closedAt === null) {
    throw new Error("A closed experiment must include closedAt.");
  }
  if (value.experimentId !== optimizationExperimentIdV1(value)) {
    throw new Error("experiment.experimentId must be the canonical hash of its immutable preregistration.");
  }
  return value;
}

export function optimizationExperimentIdV1(value) {
  const immutable = {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    clusterId: value.clusterId,
    eligibilityClaimDigest: value.eligibilityClaimDigest,
    createdAt: value.createdAt,
    closedAt: null,
    status: "preregistered",
    invariant: value.invariant,
    hypothesis: value.hypothesis,
    modificationScope: value.modificationScope,
    primaryMetric: value.primaryMetric,
    guardrails: value.guardrails,
    rollback: value.rollback,
    candidate: {
      branch: value.candidate?.branch,
      baseDigest: value.candidate?.baseDigest,
      candidateDigest: null,
      frozenAt: null
    },
    fairness: value.fairness,
    abPolicy: value.abPolicy
  };
  return createHash("sha256").update(canonical(immutable)).digest("hex");
}

export function branchForCluster(clusterId) {
  digest(clusterId, "clusterId");
  return `codex/sigma-improve-${clusterId.slice(0, 12)}`;
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

export function isActiveExperimentStatus(status) {
  return ACTIVE_EXPERIMENT.has(status);
}
