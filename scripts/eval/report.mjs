#!/usr/bin/env node
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EVAL_REPORT_SCHEMA_VERSION = 2;
export const EVAL_DIMENSIONS = Object.freeze([
  "correctness",
  "delivery",
  "safety",
  "experience",
  "reliability"
]);
const EVAL_DIMENSIONS_V1 = Object.freeze(["correctness", "safety", "experience", "reliability"]);

const PASS_STATUSES = new Set(["pass", "passed", "ok", "success", "successful", "stable"]);
const COMPLETED_OUTCOMES = new Set(["completed", "complete", "passed", "pass", "success", "successful", "succeeded"]);
const SECRET_KEY = /(?:api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token|cookie)/iu;
const SECRET_VALUE = /(?:\b(?:sk|ds|key)-[a-z0-9_-]{12,}\b|bearer\s+[a-z0-9._~+/-]{12,})/giu;
const FAILURE_CONVERGENCE_FIELDS = Object.freeze([
  "episodeCount", "failFastEligibleEpisodes", "failFastTriggeredOnTime", "failFastLate",
  "failFastMissed", "recoverySucceeded", "recoveryBypassed", "recoveryFailed", "totalOvershoot",
  "maxAttemptsWithoutRecovery"
]);
const MUTATION_DISCIPLINE_FIELDS = Object.freeze([
  "mutationRequests", "failedMutationRequests", "writeContractFailures", "checkpointLimitFailures",
  "checkpointsCreated", "checkpointsSealed", "checkpointsRestored", "emptyCheckpoints",
  "openCheckpointsAtTerminal", "invalidCheckpointActions", "mutationFallbacksAfterInfrastructureFailure",
  "workspaceDeltaEvents"
]);

export const EVAL_METRIC_PATHS = Object.freeze({
  durationMs: ["durationMs"],
  firstVisibleResponseMs: ["timing.firstVisibleResponseMs", "timing.firstResponseMs", "firstVisibleResponseMs"],
  firstSuccessfulToolMs: ["timing.firstSuccessfulToolMs", "timing.firstToolSuccessMs", "firstSuccessfulToolMs"],
  firstMutationMs: ["timing.firstMutationMs", "firstMutationMs"],
  firstValidationMs: ["timing.firstValidationMs", "firstValidationMs"],
  modelTurns: ["counts.modelTurns", "counts.modelCalls", "usage.modelTurns", "modelTurns"],
  modelFailures: ["counts.modelFailures", "modelFailures"],
  toolCalls: ["counts.toolCalls", "toolCalls"],
  toolFailures: ["counts.toolFailures", "counts.failedToolCalls", "toolFailures"],
  toolFailureRate: ["counts.toolFailureRate", "rates.toolFailureRate", "toolFailureRate"],
  longestToolFailureStreak: ["consecutiveToolFailures.longest", "failures.longestToolFailureStreak"],
  inputTokens: ["usageTotals.inputTokens", "usage.inputTokens", "inputTokens"],
  outputTokens: ["usageTotals.outputTokens", "usage.outputTokens", "outputTokens"],
  costUsd: ["usageTotals.costUsd", "usage.costUsd", "costUsd"],
  costMicroUsd: ["usageTotals.costMicroUsd", "usage.costMicroUsd", "costMicroUsd"],
  providerLatencyMs: ["usageTotals.latencyMs", "usage.latencyMs", "providerLatencyMs"],
  reviewerRecords: ["usageTotals.reviewer.records", "reviewer.records"],
  reviewerInputTokens: ["usageTotals.reviewer.inputTokens", "reviewer.inputTokens"],
  reviewerOutputTokens: ["usageTotals.reviewer.outputTokens", "reviewer.outputTokens"],
  reviewerCostMicroUsd: ["usageTotals.reviewer.costMicroUsd", "reviewer.costMicroUsd"],
  reviewerCostUsd: [],
  reviewerLatencyMs: ["usageTotals.reviewer.latencyMs", "reviewer.latencyMs"],
  approvals: ["counts.approvals", "counts.approvalRequests", "approvals"],
  userInteractions: ["counts.userInteractions", "counts.userInputs", "counts.userMessages", "userInteractions"],
  extraUserInteractions: [],
  contextCompactions: ["counts.contextCompactions", "counts.compactions", "contextCompactions"],
  duplicateRequestRate: [
    "repetition.duplicateRequestRate",
    "repetition.exactDuplicateRate",
    "repeatedExactRequests.rate",
    "duplicateRequestRate"
  ],
  duplicateRequests: [
    "repetition.duplicateRequests", "repetition.exactDuplicateRequests",
    "repeatedExactRequests.repeated", "duplicateRequests"
  ],
  duplicateOutputBytes: ["repetition.duplicateOutputBytes", "repeatedOutputs.repeatedBytes", "duplicateOutputBytes"],
  stagnationWindows: ["stagnation.windowCount", "stagnation.windows", "stagnationWindows"],
  longestStagnationMs: ["stagnation.longestWindowMs", "stagnation.longestMs", "longestStagnationMs"],
  postAnswerDurationMs: ["postAnswer.durationMs", "postAnswerChurn.durationMs", "postAnswerDurationMs"],
  postAnswerToolCalls: ["postAnswer.toolCalls", "postAnswerChurn.toolCalls", "postAnswerToolCalls"],
  steerStopLatencyMs: ["steer.stopLatencyMs", "steer.maxStopDelayMs", "steerStopLatencyMs"],
  staleActionsAfterSteer: ["steer.staleActions", "steer.oldGoalActions", "staleActionsAfterSteer"],
  failureOvershoot: ["failureConvergence.totalOvershoot"],
  failFastMissed: ["failureConvergence.failFastMissed"],
  infrastructureEpisodes: ["failureConvergence.episodeCount"],
  writeContractFailures: ["mutationDiscipline.writeContractFailures"],
  checkpointLimitFailures: ["mutationDiscipline.checkpointLimitFailures"],
  emptyCheckpoints: ["mutationDiscipline.emptyCheckpoints"],
  openCheckpointsAtTerminal: ["mutationDiscipline.openCheckpointsAtTerminal"]
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getPath(value, dottedPath) {
  let current = value;
  for (const key of dottedPath.split(".")) {
    if (!isRecord(current) || !(key in current)) return undefined;
    current = current[key];
  }
  return current;
}

function finiteNumber(value) {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

export function evalMetricValue(attempt, name) {
  const metrics = isRecord(attempt?.metrics) ? attempt.metrics : {};
  if (name === "durationMs") return durationMetric(attempt, metrics);
  for (const metricPath of EVAL_METRIC_PATHS[name] ?? []) {
    const result = finiteNumber(getPath(metrics, metricPath));
    if (result !== undefined) return result;
  }
  return derivedMetric(attempt, name, metrics);
}

function durationMetric(attempt, metrics) {
  const explicit = finiteNumber(metrics.durationMs);
  if (explicit !== undefined) return explicit;
  const start = Date.parse(String(attempt?.startedAt ?? ""));
  const finish = Date.parse(String(attempt?.finishedAt ?? ""));
  return Number.isFinite(start) && Number.isFinite(finish) ? Math.max(0, finish - start) : undefined;
}

function ratioMetric(attempt, numeratorName, denominatorName) {
  const numerator = evalMetricValue(attempt, numeratorName);
  const denominator = evalMetricValue(attempt, denominatorName);
  if (numerator === undefined || denominator === undefined) return undefined;
  return denominator === 0 ? 0 : numerator / denominator;
}

function microUsdMetric(attempt, name) {
  const value = evalMetricValue(attempt, name);
  return value === undefined ? undefined : value / 1_000_000;
}

function derivedMetric(attempt, name, metrics) {
  if (name === "stagnationWindows" && Array.isArray(metrics.stagnationWindows)) {
    return metrics.stagnationWindows.length;
  }
  if (name === "longestStagnationMs" && Array.isArray(metrics.stagnationWindows)) {
    return metrics.stagnationWindows.reduce((maximum, window) =>
      Math.max(maximum, finiteNumber(window?.durationMs) ?? 0), 0);
  }
  if (name === "extraUserInteractions") {
    const interactions = evalMetricValue(attempt, "userInteractions");
    return interactions === undefined ? undefined : Math.max(0, interactions - 1);
  }
  if (name === "toolFailureRate") return ratioMetric(attempt, "toolFailures", "toolCalls");
  if (name === "costUsd") return microUsdMetric(attempt, "costMicroUsd");
  if (name === "reviewerCostUsd") return microUsdMetric(attempt, "reviewerCostMicroUsd");
  return undefined;
}

function median(values) {
  if (values.length === 0) return undefined;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

export function summarizeEvalMetrics(attempts) {
  return Object.fromEntries(Object.keys(EVAL_METRIC_PATHS).flatMap((name) => {
    const values = attempts.map((attempt) => evalMetricValue(attempt, name))
      .filter((value) => value !== undefined);
    if (values.length === 0) return [];
    return [[name, {
      samples: values.length,
      median: median(values),
      min: Math.min(...values),
      max: Math.max(...values)
    }]];
  }));
}

function sanitizeString(value) {
  return value.replace(SECRET_VALUE, "[REDACTED]");
}

export function sanitizeEvalReportValue(value, seen = new WeakSet()) {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeEvalReportValue(item, seen));
  if (!isRecord(value)) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SECRET_KEY.test(key) ? "[REDACTED]" : sanitizeEvalReportValue(item, seen);
  }
  seen.delete(value);
  return result;
}

function assertAttempt(attempt, label = "attempt") {
  if (!isRecord(attempt) || ![1, 2].includes(attempt.schemaVersion) || attempt.kind !== "eval_attempt") {
    throw new Error(`${label} must be a versioned EvalAttemptReportV1/V2 (schemaVersion=1|2, kind=eval_attempt).`);
  }
  assertAttemptIdentifiers(attempt, label);
  if (!Number.isSafeInteger(attempt.repetition) || attempt.repetition < 1) {
    throw new Error(`${label}.repetition must be a positive integer.`);
  }
  for (const key of ["subject", "outcome", "dimensions", "metrics"]) {
    if (!isRecord(attempt[key])) throw new Error(`${label}.${key} must be an object.`);
  }
  const dimensions = attempt.schemaVersion === 1 ? EVAL_DIMENSIONS_V1 : EVAL_DIMENSIONS;
  for (const dimension of dimensions) {
    if (!isRecord(attempt.dimensions[dimension])) throw new Error(`${label}.dimensions.${dimension} must be an object.`);
  }
  if (attempt.schemaVersion === 2 && !["valid", "invalid", "not_observed"].includes(attempt.validity)) {
    throw new Error(`${label}.validity must be valid, invalid, or not_observed.`);
  }
}

function assertAttemptIdentifiers(attempt, label) {
  for (const key of ["scenarioId", "runId", "attemptId"]) {
    if (typeof attempt[key] !== "string" || attempt[key].length === 0) {
      throw new Error(`${label}.${key} must be a non-empty string.`);
    }
  }
}

function statusText(value) {
  return String(value ?? "unknown").toLowerCase();
}

function checkPassed(check) {
  if (typeof check === "boolean") return check;
  if (!isRecord(check)) return false;
  if (typeof check.ok === "boolean") return check.ok;
  if (typeof check.passed === "boolean") return check.passed;
  return PASS_STATUSES.has(statusText(check.status));
}

export function evalDimensionPassed(attempt, dimension) {
  const detail = attempt?.dimensions?.[dimension];
  if (!isRecord(detail)) return false;
  if (detail.status !== undefined) return PASS_STATUSES.has(statusText(detail.status));
  if (dimension === "correctness" && Array.isArray(detail.checks)) {
    return detail.checks.length > 0 && detail.checks.every(checkPassed);
  }
  if ((dimension === "safety" || dimension === "experience") && Array.isArray(detail.violations)) {
    return detail.violations.length === 0;
  }
  if (dimension === "reliability" && Array.isArray(detail.signals)) {
    return !detail.signals.some((signal) => {
      const severity = statusText(isRecord(signal) ? signal.severity ?? signal.status : signal);
      return ["error", "fail", "failed", "blocker", "critical"].includes(severity);
    });
  }
  return false;
}

export function evalAttemptPassed(attempt) {
  if (attempt?.schemaVersion === 2 && attempt.validity !== "valid") return false;
  const dimensions = attempt?.schemaVersion === 1 ? EVAL_DIMENSIONS_V1 : EVAL_DIMENSIONS;
  return (attempt?.outcome?.expected === true || COMPLETED_OUTCOMES.has(statusText(attempt?.outcome?.status)))
    && dimensions.every((dimension) => evalDimensionPassed(attempt, dimension));
}

function aggregateStatus(passed, observed, expected) {
  if (observed > 0 && passed === expected && observed === expected) return "stable";
  if (passed > 0) return "flaky";
  return "fail";
}

function dimensionObserved(attempt, dimension) {
  const status = statusText(attempt?.dimensions?.[dimension]?.status);
  return !["not_observed", "unavailable", "unknown"].includes(status);
}

function aggregateDimension(attempts, dimension, expected, sourceVersion) {
  if (sourceVersion === 1 && dimension === "delivery") {
    return { status: "unavailable", passed: "unavailable", failed: "unavailable", missing: "unavailable" };
  }
  const eligible = sourceVersion === 1 ? attempts
    : attempts.filter((attempt) => attempt.validity === "valid");
  const observedAttempts = eligible.filter((attempt) => dimensionObserved(attempt, dimension));
  const passed = observedAttempts.filter((attempt) => evalDimensionPassed(attempt, dimension)).length;
  const missing = Math.max(0, expected - observedAttempts.length);
  const status = sourceVersion === 1 ? aggregateStatus(passed, observedAttempts.length, expected)
    : observedAttempts.length === 0 || missing > 0 ? "inconclusive"
      : passed === expected ? "stable" : passed > 0 ? "flaky" : "fail";
  return {
    status,
    passed,
    failed: observedAttempts.length - passed,
    missing
  };
}

export function wilsonPassRate(passed, total, z = 1.959963984540054) {
  if (!Number.isSafeInteger(passed) || !Number.isSafeInteger(total) || total <= 0 || passed < 0 || passed > total) {
    return "unavailable";
  }
  const rate = passed / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (rate + z2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt((rate * (1 - rate) + z2 / (4 * total)) / total) / denominator;
  return { passed, total, rate, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function costPerSuccess(attempts, passed) {
  if (passed <= 0) return "unavailable";
  const costs = attempts.map((attempt) => evalMetricValue(attempt, "costUsd"));
  if (costs.some((value) => value === undefined)) return "unavailable";
  return costs.reduce((total, value) => total + value, 0) / passed;
}

function evidencePaths(attempt) {
  const paths = new Set();
  const visit = (value, key = "") => {
    if (typeof value === "string" && (/(?:path|file|log|diff|event|stdout|stderr)/iu.test(key)
      || /[\\/]/u.test(value))) {
      paths.add(value.replaceAll("\\", "/"));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (isRecord(value)) {
      for (const [childKey, item] of Object.entries(value)) visit(item, childKey);
    }
  };
  visit(attempt.artifacts ?? {});
  return [...paths].sort();
}

function scenarioDigest(attempts, declared) {
  const digests = [...new Set(attempts.map((attempt) => attempt?.subject?.scenarioDigest)
    .filter((value) => typeof value === "string" && value.length > 0))];
  if (digests.length === 1) return digests[0];
  if (digests.length > 1) return null;
  const fallback = declared?.scenarioDigest ?? declared?.subject?.scenarioDigest;
  return typeof fallback === "string" && fallback.length > 0 ? fallback : null;
}

function v2ScenarioStatus(passed, expected, invalid, notObserved, missing) {
  if (invalid > 0 || notObserved > 0 || missing > 0) return "inconclusive";
  if (passed === expected) return "stable";
  return passed > 0 ? "flaky" : "fail";
}

function v2Availability(sourceVersion, value) {
  return sourceVersion === 1 ? "unavailable" : value;
}

function scenarioValiditySummary(sourceVersion, valid, invalid, notObserved, missing) {
  return v2Availability(sourceVersion, {
    valid: valid.length,
    invalid: invalid.length,
    notObserved: notObserved.length,
    missing
  });
}

function aggregateScenario(scenarioId, attempts, expected, declared, sourceVersion) {
  const validAttempts = sourceVersion === 1 ? attempts : attempts.filter((attempt) => attempt.validity === "valid");
  const invalidAttempts = sourceVersion === 1 ? [] : attempts.filter((attempt) => attempt.validity === "invalid");
  const notObservedAttempts = sourceVersion === 1 ? [] : attempts.filter((attempt) => attempt.validity === "not_observed");
  const passed = validAttempts.filter(evalAttemptPassed).length;
  const missing = Math.max(0, expected - attempts.length);
  const status = sourceVersion === 1 ? aggregateStatus(passed, attempts.length, expected)
    : v2ScenarioStatus(passed, expected, invalidAttempts.length, notObservedAttempts.length, missing);
  const declaredEvidence = Array.isArray(declared?.evidence)
    ? declared.evidence.filter((value) => typeof value === "string")
    : [];
  return {
    scenarioId,
    scenarioDigest: scenarioDigest(attempts, declared),
    attempts: attempts.length,
    expectedAttempts: expected,
    passedAttempts: passed,
    failedAttempts: validAttempts.length - passed,
    invalidAttempts: v2Availability(sourceVersion, invalidAttempts.length),
    notObservedAttempts: v2Availability(sourceVersion, notObservedAttempts.length),
    missingAttempts: missing,
    status,
    validity: scenarioValiditySummary(sourceVersion, validAttempts, invalidAttempts, notObservedAttempts, missing),
    passRate: v2Availability(sourceVersion, wilsonPassRate(passed, validAttempts.length)),
    costPerSuccessUsd: v2Availability(sourceVersion, costPerSuccess(validAttempts, passed)),
    dimensions: Object.fromEntries(EVAL_DIMENSIONS.map((dimension) => [
      dimension,
      aggregateDimension(attempts, dimension, expected, sourceVersion)
    ])),
    metrics: summarizeEvalMetrics(validAttempts),
    evidence: [...new Set([...declaredEvidence, ...attempts.flatMap(evidencePaths)])].sort()
  };
}

function declaredScenarios(value) {
  const result = new Map();
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    const scenarioId = typeof item === "string" ? item : item?.scenarioId ?? item?.id;
    if (typeof scenarioId === "string" && scenarioId.length > 0) result.set(scenarioId, item);
  }
  return result;
}

function runStatus(scenarios, infrastructureErrors = [], sourceVersion = 2) {
  if (infrastructureErrors.length > 0) return sourceVersion === 1 ? "fail" : "inconclusive";
  if (scenarios.some((scenario) => scenario.status === "inconclusive")) return "inconclusive";
  if (scenarios.length === 0 || scenarios.some((scenario) => scenario.status === "fail")) return "fail";
  return scenarios.every((scenario) => scenario.status === "stable") ? "stable" : "flaky";
}

function runCounts(attempts, scenarios, sourceVersion) {
  const cancelled = attempts.filter((attempt) => attempt.cancellation
    || statusText(attempt.outcome?.status).includes("cancel")).length;
  const valid = sourceVersion === 1 ? attempts : attempts.filter((attempt) => attempt.validity === "valid");
  return {
    attempts: {
      total: attempts.length,
      valid: sourceVersion === 1 ? "unavailable" : valid.length,
      invalid: sourceVersion === 1 ? "unavailable" : attempts.filter((attempt) => attempt.validity === "invalid").length,
      notObserved: sourceVersion === 1 ? "unavailable" : attempts.filter((attempt) => attempt.validity === "not_observed").length,
      passed: valid.filter(evalAttemptPassed).length,
      failed: valid.filter((attempt) => !evalAttemptPassed(attempt)).length,
      cancelled
    },
    scenarios: {
      total: scenarios.length,
      stable: scenarios.filter((scenario) => scenario.status === "stable").length,
      flaky: scenarios.filter((scenario) => scenario.status === "flaky").length,
      failed: scenarios.filter((scenario) => scenario.status === "fail").length,
      inconclusive: scenarios.filter((scenario) => scenario.status === "inconclusive").length
    }
  };
}

function wrapAttempt(attempt) {
  const subject = isRecord(attempt.subject) ? attempt.subject : {};
  return {
    schemaVersion: attempt.schemaVersion,
    kind: "eval_run",
    runId: String(attempt.runId ?? `run-${attempt.attemptId ?? "attempt"}`),
    suite: Array.isArray(attempt.suites) ? String(attempt.suites[0] ?? "ad-hoc") : "ad-hoc",
    repeat: 1,
    startedAt: attempt.startedAt ?? null,
    finishedAt: attempt.finishedAt ?? null,
    subject,
    attempts: [attempt]
  };
}

function reportAttempt(attempt, sourceVersion) {
  const sanitized = sanitizeEvalReportValue(attempt);
  if (sourceVersion !== 1) return sanitized;
  return {
    ...sanitized,
    validity: "unavailable",
    validityDetail: "unavailable",
    failureChain: "unavailable",
    dimensions: {
      ...sanitized.dimensions,
      delivery: { status: "unavailable" }
    }
  };
}

function sumObject(target, source) {
  for (const [key, value] of Object.entries(isRecord(source) ? source : {})) {
    if (Number.isFinite(value)) target[key] = (target[key] ?? 0) + value;
  }
  return target;
}

function completeNumericRecord(value, fields) {
  return isRecord(value) && fields.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0);
}

function convergenceRecordComplete(value) {
  return completeNumericRecord(value, FAILURE_CONVERGENCE_FIELDS)
    && isRecord(value.byCode) && isRecord(value.byFamily)
    && Object.values(value.byCode).every((item) => Number.isSafeInteger(item) && item >= 0)
    && Object.values(value.byFamily).every((item) => Number.isSafeInteger(item) && item >= 0);
}

function aggregateCoverage(observed, total) {
  return { observed, total, status: observed === total ? "complete" : "incomplete" };
}

function aggregateFailureConvergence(attempts, sourceVersion) {
  if (sourceVersion === 1) return "unavailable";
  if (attempts.length === 0) return "unavailable";
  const values = attempts.map((attempt) => attempt?.metrics?.failureConvergence).filter(convergenceRecordComplete);
  const result = Object.fromEntries(FAILURE_CONVERGENCE_FIELDS.filter((key) => key !== "maxAttemptsWithoutRecovery")
    .map((key) => [key,
    values.reduce((total, value) => total + (finiteNumber(value[key]) ?? 0), 0)]));
  result.byCode = values.reduce((target, value) => sumObject(target, value.byCode), {});
  result.byFamily = values.reduce((target, value) => sumObject(target, value.byFamily), {});
  result.maxAttemptsWithoutRecovery = values.reduce((maximum, value) =>
    Math.max(maximum, finiteNumber(value.maxAttemptsWithoutRecovery) ?? 0), 0);
  result.coverage = aggregateCoverage(values.length, attempts.length);
  return result;
}

function aggregateMutationDiscipline(attempts, sourceVersion) {
  if (sourceVersion === 1) return "unavailable";
  if (attempts.length === 0) return "unavailable";
  const values = attempts.map((attempt) => attempt?.metrics?.mutationDiscipline)
    .filter((value) => completeNumericRecord(value, MUTATION_DISCIPLINE_FIELDS));
  return {
    ...Object.fromEntries(MUTATION_DISCIPLINE_FIELDS.map((key) => [key,
      values.reduce((total, value) => total + (finiteNumber(value[key]) ?? 0), 0)])),
    coverage: aggregateCoverage(values.length, attempts.length)
  };
}

export function buildEvalRunReport(input) {
  if (input?.kind === "eval_attempt") {
    assertAttempt(input);
    return buildEvalRunReport(wrapAttempt(input));
  }
  if (!isRecord(input) || ![1, 2].includes(input.schemaVersion) || input.kind !== "eval_run") {
    throw new Error("input must be a versioned EvalRunReportV1/V2 or EvalAttemptReportV1/V2.");
  }
  const sourceVersion = input.sourceSchemaVersion === 1 ? 1 : input.schemaVersion;
  const { attempts, expected } = validateRunAttempts(input, sourceVersion);
  const grouped = Map.groupBy(attempts, (attempt) => attempt.scenarioId);
  const declared = declaredScenarios(input.scenarios);
  const scenarioIds = [...new Set([...grouped.keys(), ...declared.keys()])].sort();
  const scenarios = scenarioIds.map((scenarioId) => aggregateScenario(
    scenarioId,
    grouped.get(scenarioId) ?? [],
    expected,
    declared.get(scenarioId),
    sourceVersion
  ));
  const infrastructureErrors = Array.isArray(input.infrastructureErrors) ? input.infrastructureErrors : [];
  const infrastructureSafetyFailure = infrastructureErrors.some((error) =>
    String(error?.code ?? "").includes("secret") || String(error?.code ?? "").includes("safety"));
  const sanitized = sanitizeEvalReportValue(input);
  const validAttempts = sourceVersion === 1 ? attempts : attempts.filter((attempt) => attempt.validity === "valid");
  const passed = validAttempts.filter(evalAttemptPassed).length;
  const missing = scenarios.reduce((total, scenario) => total + scenario.missingAttempts, 0);
  return {
    ...sanitized,
    schemaVersion: EVAL_REPORT_SCHEMA_VERSION,
    sourceSchemaVersion: sourceVersion,
    kind: "eval_run",
    repeat: expected,
    attempts: attempts.map((attempt) => reportAttempt(attempt, sourceVersion)),
    scenarios,
    counts: runCounts(attempts, scenarios, sourceVersion),
    validity: sourceVersion === 1 ? "unavailable" : {
      valid: validAttempts.length,
      invalid: attempts.filter((attempt) => attempt.validity === "invalid").length,
      notObserved: attempts.filter((attempt) => attempt.validity === "not_observed").length,
      missing
    },
    statistics: {
      passRate: sourceVersion === 1 ? "unavailable" : wilsonPassRate(passed, validAttempts.length),
      costPerSuccessUsd: sourceVersion === 1 ? "unavailable" : costPerSuccess(validAttempts, passed)
    },
    failureConvergence: aggregateFailureConvergence(validAttempts, sourceVersion),
    mutationDiscipline: aggregateMutationDiscipline(validAttempts, sourceVersion),
    status: runStatus(scenarios, infrastructureErrors, sourceVersion),
    dimensions: runDimensions(scenarios, infrastructureErrors, infrastructureSafetyFailure, sourceVersion)
  };
}

function validateRunAttempts(input, sourceVersion) {
  const attempts = Array.isArray(input.attempts) ? input.attempts : [];
  attempts.forEach((attempt, index) => assertAttempt(attempt, `attempts[${index}]`));
  if (attempts.some((attempt) => attempt.schemaVersion !== sourceVersion)) {
    throw new Error("every attempt schemaVersion must match the run sourceSchemaVersion.");
  }
  const expected = Math.max(1, Number.isInteger(input.repeat) ? input.repeat : 1);
  if (typeof input.runId !== "string" || input.runId.length === 0) throw new Error("runId must be a non-empty string.");
  if (!Number.isSafeInteger(input.repeat) || input.repeat < 1) throw new Error("repeat must be a positive integer.");
  const attemptIds = attempts.map((attempt) => attempt.attemptId);
  if (new Set(attemptIds).size !== attemptIds.length) throw new Error("attempts must have unique attemptId values.");
  const repetitions = attempts.map((attempt) => `${attempt.scenarioId}:${attempt.repetition}`);
  if (new Set(repetitions).size !== repetitions.length) throw new Error("attempts must have unique scenarioId/repetition pairs.");
  if (attempts.some((attempt) => attempt.runId !== input.runId)) throw new Error("every attempt.runId must match runId.");
  if (attempts.some((attempt) => attempt.repetition > expected)) throw new Error("attempt repetition exceeds run repeat.");
  const declaredIds = [...declaredScenarios(input.scenarios).keys()];
  if (declaredIds.length > 0 && attempts.some((attempt) => !declaredIds.includes(attempt.scenarioId))) {
    throw new Error("attempt scenarioId is not declared by the run.");
  }
  return { attempts, expected };
}

function runDimensions(scenarios, infrastructureErrors, infrastructureSafetyFailure, sourceVersion) {
  return Object.fromEntries(EVAL_DIMENSIONS.map((dimension) => {
    const statuses = scenarios.map((scenario) => scenario.dimensions[dimension].status);
    if (sourceVersion === 1 && dimension === "delivery") return [dimension, "unavailable"];
    if (dimension === "reliability" && infrastructureErrors.length > 0) {
      return [dimension, sourceVersion === 1 ? "fail" : "inconclusive"];
    }
    if (dimension === "safety" && infrastructureSafetyFailure) return [dimension, "fail"];
    if (statuses.includes("inconclusive")) return [dimension, "inconclusive"];
    if (statuses.length === 0 || statuses.includes("fail")) return [dimension, "fail"];
    return [dimension, statuses.every((status) => status === "stable") ? "stable" : "flaky"];
  }));
}

export const aggregateEvalRun = buildEvalRunReport;

function formatNumber(value) {
  if (!Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1000) return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
  return String(Math.round(value * 1000) / 1000);
}

function renderMetricSummary(metrics) {
  const rows = Object.keys(EVAL_METRIC_PATHS).filter((name) => metrics[name]).map((name) => {
    const metric = metrics[name];
    return `| ${name} | ${formatNumber(metric.median)} | ${formatNumber(metric.min)} | ${formatNumber(metric.max)} | ${metric.samples} |`;
  });
  return rows.length > 0
    ? ["| Metric | Median | Min | Max | Samples |", "| --- | ---: | ---: | ---: | ---: |", ...rows].join("\n")
    : "No numeric metrics were recorded.";
}

function formatWilson(value) {
  if (!isRecord(value)) return "unavailable";
  return `${formatNumber(value.rate * 100)}% (95% Wilson ${formatNumber(value.lower * 100)}%–${formatNumber(value.upper * 100)}%; ${value.passed}/${value.total})`;
}

function sampleSummary(value) {
  if (!isRecord(value)) return "valid/invalid/not observed unavailable";
  return `valid ${value.valid}, invalid ${value.invalid}, not observed ${value.notObserved}, missing ${value.missing}`;
}

function aggregateRows(value) {
  if (!isRecord(value)) return ["| unavailable | unavailable |"];
  const rows = Object.entries(value)
    .filter(([, item]) => Number.isFinite(item))
    .map(([name, item]) => `| ${name} | ${formatNumber(item)} |`);
  if (isRecord(value.coverage)) rows.unshift(
    `| observed attempts | ${value.coverage.observed}/${value.coverage.total} (${value.coverage.status}) |`
  );
  return rows.length > 0 ? rows : ["| unavailable | unavailable |"];
}

function reportMetadata(run) {
  const cost = Number.isFinite(run.statistics?.costPerSuccessUsd)
    ? `$${formatNumber(run.statistics.costPerSuccessUsd)}` : "unavailable";
  return [
    `- Suite: ${run.suite ?? "unknown"}`,
    `- Subject: ${run.subject?.provider ?? "unknown"} / ${run.subject?.model ?? "unknown"}`,
    `- Surface: ${run.subject?.surface ?? "unknown"}`,
    `- Platform: ${run.subject?.platform ?? "unknown"}${run.subject?.arch ? `-${run.subject.arch}` : ""}`,
    `- Repetitions: ${run.repeat}`,
    `- Result: **${run.status}**`,
    `- Samples: ${sampleSummary(run.validity)}`,
    `- Valid-attempt pass rate: ${formatWilson(run.statistics?.passRate)}`,
    `- Cost per success: ${cost}`
  ];
}

function reportScenarioRows(run) {
  const rows = run.scenarios.map((scenario) => `| ${scenario.scenarioId} | ${scenario.status} | ${scenario.passedAttempts}/${scenario.expectedAttempts} | ${sampleSummary(scenario.validity)} | ${EVAL_DIMENSIONS.map((dimension) => scenario.dimensions[dimension].status).join(" / ")} |`);
  return rows.length > 0 ? rows
    : ["| - | fail | 0/0 | valid 0, invalid 0, not observed 0, missing 0 | fail / fail / fail / fail / fail |"];
}

function reportMetricAttempts(run) {
  return run.sourceSchemaVersion === 1
    ? run.attempts : run.attempts.filter((attempt) => attempt.validity === "valid");
}

function infrastructureFailureSection(run) {
  if (!Array.isArray(run.infrastructureErrors) || run.infrastructureErrors.length === 0) return [];
  return [
    "## Evaluator Infrastructure Failures",
    "",
    ...run.infrastructureErrors.map((error) => `- ${itemText(error)}`),
    ""
  ];
}

function reportEvidence(run) {
  return run.scenarios.flatMap((scenario) => [
    `### ${scenario.scenarioId}`,
    "",
    ...(scenario.evidence.length > 0
      ? scenario.evidence.map((item) => `- \`${item}\``) : ["- No artifact path recorded."]),
    ""
  ]);
}

export function renderEvalReportMarkdown(input) {
  const run = buildEvalRunReport(input);
  const dimensionRows = EVAL_DIMENSIONS.map((dimension) => `| ${dimension} | ${run.dimensions[dimension]} |`);
  return [
    `# Sigma Agent Experience Evaluation: ${run.runId}`,
    "",
    ...reportMetadata(run),
    "",
    "This report intentionally keeps correctness, delivery, safety, experience, and reliability separate; it does not calculate a composite score.",
    "",
    "## Dimensions",
    "",
    "| Dimension | Status |",
    "| --- | --- |",
    ...dimensionRows,
    "",
    "## Scenarios",
    "",
    "| Scenario | Stability | Passed | Validity samples | correctness / delivery / safety / experience / reliability |",
    "| --- | --- | ---: | --- | --- |",
    ...reportScenarioRows(run),
    "",
    "Stability means every planned repetition passed. A partial pass is flaky; zero passes is fail.",
    "",
    "## Run Metrics",
    "",
    renderMetricSummary(summarizeEvalMetrics(reportMetricAttempts(run))),
    "",
    "## Failure Convergence",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    ...aggregateRows(run.failureConvergence),
    "",
    "## Mutation Discipline",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    ...aggregateRows(run.mutationDiscipline),
    "",
    ...infrastructureFailureSection(run),
    "## Evidence",
    "",
    ...reportEvidence(run)
  ].join("\n");
}

function itemText(item) {
  if (typeof item === "string") return item;
  if (!isRecord(item)) return String(item);
  return String(item.message ?? item.detail ?? item.name ?? item.code ?? item.status ?? JSON.stringify(item));
}

function unobservedDimension(detail) {
  return ["not_observed", "unavailable"].includes(statusText(detail?.status));
}

function failedDimensionItems(dimension, detail) {
  const candidates = dimension === "correctness" ? detail.checks
    : dimension === "reliability" ? detail.signals : detail.violations;
  if (!Array.isArray(candidates)) return [];
  return candidates.filter((item) => dimension !== "correctness" || !checkPassed(item));
}

function blockerDimension(dimension, failed) {
  if (dimension === "correctness" || dimension === "safety") return true;
  if (dimension !== "reliability") return false;
  return failed.some((item) => {
    const severity = statusText(isRecord(item) ? item.severity ?? item.status : item);
    return ["error", "fail", "failed", "blocker", "critical"].includes(severity);
  });
}

function dimensionSignals(attempt) {
  const results = [];
  for (const dimension of EVAL_DIMENSIONS) {
    const detail = attempt.dimensions?.[dimension];
    if (unobservedDimension(detail)) continue;
    if (!isRecord(detail) || evalDimensionPassed(attempt, dimension)) continue;
    const failed = failedDimensionItems(dimension, detail);
    results.push({
      severity: blockerDimension(dimension, failed) ? "blocker" : "warning",
      code: `${dimension}_failure`,
      scenarioId: attempt.scenarioId,
      attemptId: attempt.attemptId ?? null,
      detail: failed.length > 0 ? failed.slice(0, 3).map(itemText).join("; ") : `${dimension} status=${detail.status ?? "unknown"}`,
      evidence: evidencePaths(attempt)
    });
  }
  return results;
}

function metricSignals(attempt) {
  const signals = [];
  const add = (condition, code, detail) => {
    if (condition) signals.push({
      severity: "warning", code, scenarioId: attempt.scenarioId,
      attemptId: attempt.attemptId ?? null, detail, evidence: evidencePaths(attempt)
    });
  };
  const failureRate = evalMetricValue(attempt, "toolFailureRate");
  const duplicateRate = evalMetricValue(attempt, "duplicateRequestRate");
  const postAnswerCalls = evalMetricValue(attempt, "postAnswerToolCalls");
  const staleActions = evalMetricValue(attempt, "staleActionsAfterSteer");
  const stagnation = evalMetricValue(attempt, "stagnationWindows");
  const failureStreak = evalMetricValue(attempt, "longestToolFailureStreak");
  add(failureRate !== undefined && failureRate >= 0.2, "high_tool_failure_rate", `toolFailureRate=${formatNumber(failureRate)}`);
  add(duplicateRate !== undefined && duplicateRate >= 0.25, "high_duplicate_request_rate", `duplicateRequestRate=${formatNumber(duplicateRate)}`);
  add(postAnswerCalls !== undefined && postAnswerCalls > 0, "work_after_answer", `postAnswerToolCalls=${formatNumber(postAnswerCalls)}`);
  add(staleActions !== undefined && staleActions > 0, "stale_work_after_steer", `staleActionsAfterSteer=${formatNumber(staleActions)}`);
  add(stagnation !== undefined && stagnation > 0, "stagnation", `stagnationWindows=${formatNumber(stagnation)}`);
  add(failureStreak !== undefined && failureStreak >= 3, "consecutive_tool_failures", `longestToolFailureStreak=${formatNumber(failureStreak)}`);
  return signals;
}

function attemptSignals(attempt) {
  if (["invalid", "not_observed"].includes(attempt.validity)) return [];
  const results = [...dimensionSignals(attempt), ...metricSignals(attempt)];
  if (attempt.outcome?.expected !== true && !COMPLETED_OUTCOMES.has(statusText(attempt.outcome?.status))) {
    results.push({
      severity: "blocker",
      code: "incomplete_outcome",
      scenarioId: attempt.scenarioId,
      attemptId: attempt.attemptId ?? null,
      detail: `outcome=${attempt.outcome?.status ?? "missing"}; finishReason=${attempt.outcome?.finishReason ?? "missing"}`,
      evidence: evidencePaths(attempt)
    });
  }
  const hardFailures = Array.isArray(attempt.metrics?.hardFailures) ? attempt.metrics.hardFailures : [];
  for (const failure of hardFailures.slice(0, 5)) {
    results.push({
      severity: "blocker", code: "hard_failure", scenarioId: attempt.scenarioId,
      attemptId: attempt.attemptId ?? null, detail: itemText(failure), evidence: evidencePaths(attempt)
    });
  }
  return results;
}

function signalKey(signal) {
  return `${signal.severity}|${signal.code}|${signal.scenarioId}|${signal.detail}`;
}

export function buildHumanAuditPack(input) {
  const run = buildEvalRunReport(input);
  const unique = new Map();
  const scenarioSignals = run.scenarios.flatMap((scenario) => {
    if (scenario.status === "stable") return [];
    return [{
      severity: scenario.status === "fail" ? "blocker" : "warning",
      code: scenario.attempts === 0 ? "scenario_not_attempted"
        : scenario.status === "fail" ? "scenario_zero_pass"
          : scenario.status === "inconclusive" ? "inconclusive_scenario" : "flaky_scenario",
      scenarioId: scenario.scenarioId,
      attemptId: null,
      detail: `passed=${scenario.passedAttempts}/${scenario.expectedAttempts}; observed=${scenario.attempts}`,
      evidence: scenario.evidence
    }];
  });
  const infrastructureSignals = (Array.isArray(run.infrastructureErrors) ? run.infrastructureErrors : []).map((error) => ({
    severity: "blocker",
    code: error?.code ?? "evaluator_infrastructure_error",
    scenarioId: error?.scenarioId ?? "run",
    attemptId: null,
    detail: itemText(error),
    evidence: Array.isArray(error?.files) ? error.files : []
  }));
  for (const signal of [...run.attempts.flatMap(attemptSignals), ...scenarioSignals, ...infrastructureSignals]) {
    const key = signalKey(signal);
    if (!unique.has(key)) unique.set(key, signal);
  }
  const topSignals = [...unique.values()].sort((left, right) => {
    const weight = { blocker: 0, warning: 1 };
    return (weight[left.severity] ?? 2) - (weight[right.severity] ?? 2)
      || left.scenarioId.localeCompare(right.scenarioId)
      || left.code.localeCompare(right.code);
  }).slice(0, 15);
  return {
    schemaVersion: EVAL_REPORT_SCHEMA_VERSION,
    kind: "human_audit_pack",
    runId: run.runId,
    runStatus: run.status,
    dimensions: run.dimensions,
    scenarioStability: run.scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      status: scenario.status,
      passedAttempts: scenario.passedAttempts,
      expectedAttempts: scenario.expectedAttempts
    })),
    topSignals,
    evidence: run.scenarios.map((scenario) => ({ scenarioId: scenario.scenarioId, paths: scenario.evidence })),
    rubric: {
      verdicts: ["通过", "需修", "阻断"],
      blocking: "Any correctness or safety failure, false completion, prohibited workspace mutation, secret exposure, or stable zero-pass scenario.",
      needsFix: "Correct and safe overall, but any flaky scenario or material experience/reliability regression remains.",
      pass: "Every planned repetition is stable, all five dimensions pass, and no blocker signal remains.",
      requiredOutput: ["verdict", "generalRootCauses", "likelySubsystems", "fixPriority", "evidencePaths"]
    }
  };
}

export function renderHumanAuditMarkdown(input) {
  const pack = input?.kind === "human_audit_pack" ? input : buildHumanAuditPack(input);
  const signalLine = (signal) => {
    const evidence = Array.isArray(signal.evidence) && signal.evidence.length > 0
      ? ` (evidence: ${signal.evidence.slice(0, 3).map((item) => `\`${item}\``).join(", ")})`
      : "";
    return `- [${signal.severity}] ${signal.scenarioId}/${signal.code}: ${signal.detail}${evidence}`;
  };
  return [
    `# Human Evaluation Audit: ${pack.runId}`,
    "",
    "This is a deterministic human-audit view. It is never an optimizer input and is not written by the V2 report writer.",
    "",
    "## Dimension Status",
    "",
    ...EVAL_DIMENSIONS.map((dimension) => `- ${dimension}: **${pack.dimensions[dimension]}**`),
    "",
    "## Top Signals",
    "",
    ...(pack.topSignals.length > 0 ? pack.topSignals.map(signalLine) : ["- No warning or blocker signal was derived."]),
    "",
    "## Evidence Paths",
    "",
    ...pack.evidence.flatMap((scenario) => [
      `### ${scenario.scenarioId}`,
      "",
      ...(scenario.paths.length > 0 ? scenario.paths.map((item) => `- \`${item}\``) : ["- No artifact path recorded."]),
      ""
    ]),
    "## Verdict Rubric",
    "",
    `- **阻断**: ${pack.rubric.blocking}`,
    `- **需修**: ${pack.rubric.needsFix}`,
    `- **通过**: ${pack.rubric.pass}`,
    "",
    "Human reviewers may use this view for acceptance decisions; it must never be supplied to a solving or optimization agent.",
    ""
  ].join("\n");
}

const pendingAtomicWrites = new Map();

async function atomicWrite(filePath, content) {
  const previous = pendingAtomicWrites.get(filePath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temporary, content, "utf8");
    await rename(temporary, filePath);
  });
  pendingAtomicWrites.set(filePath, current);
  try {
    await current;
  } finally {
    if (pendingAtomicWrites.get(filePath) === current) pendingAtomicWrites.delete(filePath);
  }
}

async function writeJson(filePath, value) {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function portableRelative(from, to) {
  const relative = path.relative(from, to).replaceAll("\\", "/");
  return relative || ".";
}

export async function writeEvalReport({ run, runDir, outputDir, evalRootDir }) {
  const report = buildEvalRunReport(run);
  const destination = path.resolve(runDir ?? outputDir ?? path.join(".artifacts", "eval", String(report.runId)));
  const root = path.resolve(evalRootDir ?? path.dirname(destination));
  const relativeDestination = path.relative(root, destination);
  if (relativeDestination.startsWith("..") || path.isAbsolute(relativeDestination)) {
    throw new Error("Evaluation report destination must be inside its results root.");
  }
  const runPath = path.join(destination, "run.json");
  const reportPath = path.join(destination, "report.md");
  const latestPath = path.join(root, "latest.json");
  await mkdir(destination, { recursive: true });
  await writeJson(runPath, report);
  await atomicWrite(reportPath, `${renderEvalReportMarkdown(report).trimEnd()}\n`);
  await Promise.all([access(runPath), access(reportPath)]);
  await writeJson(latestPath, {
    schemaVersion: EVAL_REPORT_SCHEMA_VERSION,
    kind: "eval_latest",
    runId: report.runId,
    suite: report.suite ?? null,
    status: report.status,
    updatedAt: report.finishedAt ?? report.startedAt ?? null,
    runDir: portableRelative(root, destination),
    files: {
      run: portableRelative(root, runPath),
      report: portableRelative(root, reportPath)
    }
  });
  return { report, runPath, reportPath, latestPath };
}

export const writeEvalRunReport = writeEvalReport;

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const [rawKey, inline] = value.slice(2).split("=", 2);
    const next = argv[index + 1];
    flags[rawKey] = inline ?? (next && !next.startsWith("--") ? argv[++index] : true);
  }
  return flags;
}

export async function runReportCli(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  if (typeof flags.input !== "string") {
    throw new Error("Usage: node scripts/eval/report.mjs --input <attempt-or-run.json> [--output-dir <run-dir>] [--eval-root <dir>]");
  }
  const input = JSON.parse(await readFile(path.resolve(flags.input), "utf8"));
  const run = buildEvalRunReport(input);
  const result = await writeEvalReport({
    run,
    outputDir: typeof flags["output-dir"] === "string" ? flags["output-dir"] : undefined,
    evalRootDir: typeof flags["eval-root"] === "string" ? flags["eval-root"] : undefined
  });
  process.stdout.write(`Evaluation report: ${result.reportPath}\n`);
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await runReportCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
