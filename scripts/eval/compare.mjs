#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVAL_DIMENSIONS,
  EVAL_METRIC_PATHS,
  buildEvalRunReport,
  summarizeEvalMetrics
} from "./report.mjs";

export const EVAL_COMPARISON_SCHEMA_VERSION = 1;
export const EVAL_COMPATIBILITY_FIELDS = Object.freeze([
  "scenarioDigest",
  "evaluatorDigest",
  "verifierDigest",
  "model",
  "platform",
  "surface",
  "environmentDigest"
]);

const LEGACY_COMPATIBILITY_FIELDS = Object.freeze([
  "scenarioDigest", "evaluatorDigest", "verifierDigest", "brokerDigest",
  "model", "platform", "surface", "configDigest"
]);

const LOWER_IS_BETTER = new Set([
  "durationMs", "firstVisibleResponseMs", "firstSuccessfulToolMs", "firstMutationMs", "firstValidationMs",
  "modelTurns", "modelFailures", "toolCalls", "toolFailures", "toolFailureRate", "longestToolFailureStreak", "inputTokens", "outputTokens", "costUsd",
  "costMicroUsd", "providerLatencyMs", "reviewerRecords", "reviewerInputTokens", "reviewerOutputTokens",
  "reviewerCostMicroUsd", "reviewerCostUsd", "reviewerLatencyMs", "approvals", "userInteractions",
  "extraUserInteractions", "contextCompactions", "duplicateRequestRate",
  "duplicateRequests", "duplicateOutputBytes", "stagnationWindows", "longestStagnationMs",
  "postAnswerDurationMs", "postAnswerToolCalls", "steerStopLatencyMs", "staleActionsAfterSteer"
]);

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))].sort();
}

function scenarioAttempts(run, scenarioId) {
  return run.attempts.filter((attempt) => attempt.scenarioId === scenarioId);
}

function subjectValues(run, scenarioId, field) {
  if (field === "scenarioDigest") {
    const summary = run.scenarios.find((scenario) => scenario.scenarioId === scenarioId);
    const attemptDigests = uniqueStrings(scenarioAttempts(run, scenarioId)
      .map((attempt) => attempt.subject?.scenarioDigest));
    if (attemptDigests.length > 0) return attemptDigests;
    return uniqueStrings([summary?.scenarioDigest, run.subject?.scenarioDigest]);
  }
  const attemptValues = uniqueStrings(scenarioAttempts(run, scenarioId)
    .map((attempt) => attempt.subject?.[field]));
  // Mixed-surface runs intentionally summarize the root as `mixed`. Scenario
  // compatibility must use the concrete attempt configuration and only fall
  // back to the run-level value when attempt evidence is unavailable.
  return attemptValues.length > 0 ? attemptValues : uniqueStrings([run.subject?.[field]]);
}

function comparisonValue(values) {
  if (values.length === 0) return null;
  return values.length === 1 ? values[0] : values;
}

function infrastructureValidity(run) {
  const runErrors = Array.isArray(run.infrastructureErrors) ? run.infrastructureErrors.length : 0;
  const invalidCodes = new Set([
    "evaluator_infrastructure_error", "sandbox_cleanup_failed", "missing_durable_events",
    "event_store_read_failed", "incomplete_event_data", "invalid_run_boundary"
  ]);
  const attemptErrors = run.attempts.reduce((count, attempt) => count + (attempt.dimensions?.reliability?.signals ?? [])
    .filter((signal) => invalidCodes.has(signal?.code)).length, 0);
  const expectedSamples = run.scenarios.reduce((total, scenario) => total + Number(scenario.expectedAttempts ?? run.repeat ?? 0), 0);
  const actualSamples = run.attempts.length;
  const sampleMismatch = expectedSamples !== actualSamples;
  return { valid: runErrors === 0 && attemptErrors === 0 && !sampleMismatch, runErrors, attemptErrors, expectedSamples, actualSamples };
}

function compatibilityFields(baseline, candidate) {
  const scenarioIds = [...new Set([
    ...baseline.scenarios.map((scenario) => scenario.scenarioId),
    ...candidate.scenarios.map((scenario) => scenario.scenarioId)
  ])];
  const hasEnvironmentDigest = scenarioIds.every((scenarioId) =>
    subjectValues(baseline, scenarioId, "environmentDigest").length > 0
    && subjectValues(candidate, scenarioId, "environmentDigest").length > 0);
  return hasEnvironmentDigest ? EVAL_COMPATIBILITY_FIELDS : LEGACY_COMPATIBILITY_FIELDS;
}

function compatibilityMismatches(baseline, candidate, requiredFields) {
  const mismatches = [];
  if (baseline.runId === candidate.runId) {
    mismatches.push({
      scope: "run", field: "runId", baseline: baseline.runId, candidate: candidate.runId,
      reason: "A run cannot be compared with itself."
    });
  }
  if (baseline.repeat !== candidate.repeat) {
    mismatches.push({
      scope: "run", field: "repeat", baseline: baseline.repeat, candidate: candidate.repeat,
      reason: "Both runs must use the same planned repetition count."
    });
  }
  const baselineInfrastructure = infrastructureValidity(baseline);
  const candidateInfrastructure = infrastructureValidity(candidate);
  if (!baselineInfrastructure.valid || !candidateInfrastructure.valid) {
    mismatches.push({
      scope: "run",
      field: "infrastructureValidity",
      baseline: baselineInfrastructure,
      candidate: candidateInfrastructure,
      reason: "Metric deltas are invalid when either run contains evaluator infrastructure failures."
    });
  }
  const baselineIds = baseline.scenarios.map((scenario) => scenario.scenarioId).sort();
  const candidateIds = candidate.scenarios.map((scenario) => scenario.scenarioId).sort();
  if (JSON.stringify(baselineIds) !== JSON.stringify(candidateIds)) {
    mismatches.push({
      scope: "run", field: "scenarioSet", baseline: baselineIds, candidate: candidateIds,
      reason: "Both runs must contain exactly the same scenario IDs."
    });
  }
  for (const scenarioId of [...new Set([...baselineIds, ...candidateIds])].sort()) {
    for (const field of requiredFields) {
      const baselineValues = subjectValues(baseline, scenarioId, field);
      const candidateValues = subjectValues(candidate, scenarioId, field);
      const equal = baselineValues.length === 1 && candidateValues.length === 1
        && baselineValues[0] === candidateValues[0];
      if (!equal) {
        mismatches.push({
          scope: scenarioId,
          field,
          baseline: comparisonValue(baselineValues),
          candidate: comparisonValue(candidateValues),
          reason: baselineValues.length === 0 || candidateValues.length === 0
            ? "Comparable evidence is missing."
            : baselineValues.length > 1 || candidateValues.length > 1
              ? "A run contains conflicting compatibility values."
              : "Compatibility values differ."
        });
      }
    }
    const baselineMetrics = summarizeEvalMetrics(scenarioAttempts(baseline, scenarioId));
    const candidateMetrics = summarizeEvalMetrics(scenarioAttempts(candidate, scenarioId));
    for (const name of Object.keys(EVAL_METRIC_PATHS)) {
      const baselineSamples = baselineMetrics[name]?.samples ?? 0;
      const candidateSamples = candidateMetrics[name]?.samples ?? 0;
      if (baselineSamples === candidateSamples) continue;
      mismatches.push({
        scope: scenarioId,
        field: `metricSamples.${name}`,
        baseline: baselineSamples,
        candidate: candidateSamples,
        reason: "Both runs must contain the same number of valid samples for each metric."
      });
    }
  }
  return mismatches;
}

function deltaRecord(name, baseline, candidate) {
  if (!Number.isFinite(baseline) || !Number.isFinite(candidate)) {
    return { baseline: baseline ?? null, candidate: candidate ?? null, delta: null, deltaPercent: null, change: "unavailable" };
  }
  const delta = candidate - baseline;
  const deltaPercent = baseline === 0 ? null : (delta / Math.abs(baseline)) * 100;
  const direction = delta === 0 ? "unchanged"
    : LOWER_IS_BETTER.has(name) ? (delta < 0 ? "improved" : "regressed")
      : (delta > 0 ? "improved" : "regressed");
  return { baseline, candidate, delta, deltaPercent, change: direction };
}

function metricDeltas(baselineMetrics, candidateMetrics) {
  return Object.fromEntries(Object.keys(EVAL_METRIC_PATHS).flatMap((name) => {
    const baseline = baselineMetrics[name]?.median;
    const candidate = candidateMetrics[name]?.median;
    if (baseline === undefined && candidate === undefined) return [];
    return [[name, deltaRecord(name, baseline, candidate)]];
  }));
}

function statusChange(baseline, candidate) {
  const rank = { fail: 0, flaky: 1, stable: 2 };
  const delta = (rank[candidate] ?? -1) - (rank[baseline] ?? -1);
  return delta > 0 ? "improved" : delta < 0 ? "regressed" : "unchanged";
}

function scenarioPassRate(scenario) {
  const expected = Number(scenario?.expectedAttempts ?? 0);
  return expected > 0 ? Number(scenario?.passedAttempts ?? 0) / expected : null;
}

function runPassRate(run) {
  const expected = run.scenarios.reduce((total, scenario) => total + Number(scenario.expectedAttempts ?? 0), 0);
  const passed = run.scenarios.reduce((total, scenario) => total + Number(scenario.passedAttempts ?? 0), 0);
  return expected > 0 ? passed / expected : null;
}

function compareScenario(baselineRun, candidateRun, scenarioId) {
  const baseline = baselineRun.scenarios.find((scenario) => scenario.scenarioId === scenarioId);
  const candidate = candidateRun.scenarios.find((scenario) => scenario.scenarioId === scenarioId);
  if (!baseline || !candidate) return null;
  return {
    scenarioId,
    scenarioDigest: baseline.scenarioDigest,
    stability: {
      baseline: baseline.status,
      candidate: candidate.status,
      change: statusChange(baseline.status, candidate.status)
    },
    passRate: deltaRecord("passRate", scenarioPassRate(baseline), scenarioPassRate(candidate)),
    dimensions: Object.fromEntries(EVAL_DIMENSIONS.map((dimension) => {
      const baselineStatus = baseline.dimensions[dimension].status;
      const candidateStatus = candidate.dimensions[dimension].status;
      return [dimension, {
        baseline: baselineStatus,
        candidate: candidateStatus,
        change: statusChange(baselineStatus, candidateStatus)
      }];
    })),
    metrics: metricDeltas(baseline.metrics, candidate.metrics)
  };
}

function runIdentity(run) {
  return {
    runId: run.runId,
    suite: run.suite ?? null,
    repeat: run.repeat,
    status: run.status,
    model: run.subject?.model ?? null,
    platform: run.subject?.platform ?? null,
    surface: run.subject?.surface ?? null,
    subjectDigest: run.subject?.subjectDigest ?? null,
    environmentDigest: run.subject?.environmentDigest ?? null,
    configDigest: run.subject?.configDigest ?? null
  };
}

export function compareEvalRuns(baselineInput, candidateInput) {
  const baseline = buildEvalRunReport(baselineInput);
  const candidate = buildEvalRunReport(candidateInput);
  const requiredFields = compatibilityFields(baseline, candidate);
  const mismatches = compatibilityMismatches(baseline, candidate, requiredFields);
  const comparable = mismatches.length === 0;
  const sharedIds = baseline.scenarios.map((scenario) => scenario.scenarioId)
    .filter((scenarioId) => candidate.scenarios.some((scenario) => scenario.scenarioId === scenarioId))
    .sort();
  return {
    schemaVersion: EVAL_COMPARISON_SCHEMA_VERSION,
    kind: "eval_comparison",
    comparable,
    compatibility: {
      requiredFields,
      mismatches
    },
    baseline: runIdentity(baseline),
    candidate: runIdentity(candidate),
    stability: {
      baseline: baseline.status,
      candidate: candidate.status,
      change: comparable ? statusChange(baseline.status, candidate.status) : "invalid"
    },
    passRate: comparable
      ? deltaRecord("passRate", runPassRate(baseline), runPassRate(candidate))
      : { baseline: null, candidate: null, delta: null, deltaPercent: null, change: "invalid" },
    dimensions: Object.fromEntries(EVAL_DIMENSIONS.map((dimension) => [dimension, {
      baseline: baseline.dimensions[dimension],
      candidate: candidate.dimensions[dimension],
      change: comparable ? statusChange(baseline.dimensions[dimension], candidate.dimensions[dimension]) : "invalid"
    }])),
    metrics: comparable
      ? metricDeltas(summarizeEvalMetrics(baseline.attempts), summarizeEvalMetrics(candidate.attempts))
      : Object.fromEntries(Object.keys(EVAL_METRIC_PATHS).map((name) => [name, {
        baseline: null, candidate: null, delta: null, deltaPercent: null, change: "invalid"
      }])),
    scenarios: comparable ? sharedIds.map((scenarioId) => compareScenario(baseline, candidate, scenarioId)) : []
  };
}

export function assertComparableEvalRuns(baseline, candidate) {
  const comparison = compareEvalRuns(baseline, candidate);
  if (!comparison.comparable) {
    const details = comparison.compatibility.mismatches
      .map((mismatch) => `${mismatch.scope}.${mismatch.field}: ${JSON.stringify(mismatch.baseline)} != ${JSON.stringify(mismatch.candidate)}`)
      .join("; ");
    const error = new Error(`Evaluation runs are not comparable: ${details}`);
    error.comparison = comparison;
    throw error;
  }
  return comparison;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "-";
  return String(Math.round(value * 1000) / 1000);
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${formatNumber(value * 100)}%` : "-";
}

function metricRows(metrics) {
  return Object.entries(metrics).map(([name, metric]) => `| ${name} | ${formatNumber(metric.baseline)} | ${formatNumber(metric.candidate)} | ${formatNumber(metric.delta)} | ${formatNumber(metric.deltaPercent)} | ${metric.change} |`);
}

function incompatibilityRows(mismatches) {
  return mismatches.map((mismatch) => `| ${mismatch.scope} | ${mismatch.field} | \`${JSON.stringify(mismatch.baseline)}\` | \`${JSON.stringify(mismatch.candidate)}\` | ${mismatch.reason} |`);
}

export function renderEvalComparisonMarkdown(input) {
  const comparison = input?.kind === "eval_comparison"
    ? input
    : compareEvalRuns(input.baseline, input.candidate);
  const metricTableRows = metricRows(comparison.metrics);
  const scenarioRows = comparison.scenarios.map((scenario) => `| ${scenario.scenarioId} | ${scenario.stability.baseline} | ${scenario.stability.candidate} | ${formatPercent(scenario.passRate.baseline)} | ${formatPercent(scenario.passRate.candidate)} | ${formatPercent(scenario.passRate.delta)} | ${scenario.stability.change} |`);
  return [
    `# Sigma Agent Evaluation Comparison: ${comparison.baseline.runId} -> ${comparison.candidate.runId}`,
    "",
    `- Comparable: **${comparison.comparable ? "yes" : "no"}**`,
    `- Stability: ${comparison.stability.baseline} -> ${comparison.stability.candidate} (${comparison.stability.change})`,
    `- Attempt pass rate: ${formatPercent(comparison.passRate.baseline)} -> ${formatPercent(comparison.passRate.candidate)} (delta ${formatPercent(comparison.passRate.delta)})`,
    "",
    "The comparison keeps the four evaluation dimensions separate and does not calculate a composite score.",
    "",
    ...(comparison.comparable ? [
      "## Dimensions",
      "",
      "| Dimension | Baseline | Candidate | Change |",
      "| --- | --- | --- | --- |",
      ...EVAL_DIMENSIONS.map((dimension) => {
        const value = comparison.dimensions[dimension];
        return `| ${dimension} | ${value.baseline} | ${value.candidate} | ${value.change} |`;
      }),
      "",
      "## Metric Changes",
      "",
      "Delta is candidate minus baseline. Percentage is unavailable when the baseline is zero.",
      "",
      "| Metric | Baseline median | Candidate median | Delta | Delta % | Interpretation |",
      "| --- | ---: | ---: | ---: | ---: | --- |",
      ...(metricTableRows.length > 0 ? metricTableRows : ["| - | - | - | - | - | unavailable |"]),
      "",
      "## Scenarios",
      "",
      "| Scenario | Baseline | Candidate | Baseline pass rate | Candidate pass rate | Delta | Change |",
      "| --- | --- | --- | ---: | ---: | ---: | --- |",
      ...scenarioRows,
      ""
    ] : [
      "## Compatibility Gate Failed",
      "",
      "No metric delta is valid until all required compatibility evidence matches.",
      "",
      "| Scope | Field | Baseline | Candidate | Reason |",
      "| --- | --- | --- | --- | --- |",
      ...incompatibilityRows(comparison.compatibility.mismatches),
      ""
    ])
  ].join("\n");
}

async function atomicWrite(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, filePath);
}

export async function writeEvalComparison({ baseline, candidate, outputDir, requireComparable = true }) {
  const comparison = compareEvalRuns(baseline, candidate);
  const destination = path.resolve(outputDir ?? ".");
  const jsonPath = path.join(destination, "comparison.json");
  const markdownPath = path.join(destination, "comparison.md");
  await atomicWrite(jsonPath, `${JSON.stringify(comparison, null, 2)}\n`);
  await atomicWrite(markdownPath, `${renderEvalComparisonMarkdown(comparison).trimEnd()}\n`);
  if (requireComparable && !comparison.comparable) {
    const error = new Error(`Evaluation runs are not comparable; inspect ${markdownPath}.`);
    error.comparison = comparison;
    error.jsonPath = jsonPath;
    error.markdownPath = markdownPath;
    throw error;
  }
  return { comparison, jsonPath, markdownPath };
}

async function resolveRunPath(value) {
  const resolved = path.resolve(value);
  const details = await stat(resolved);
  return details.isDirectory() ? path.join(resolved, "run.json") : resolved;
}

async function readRun(value) {
  const filePath = await resolveRunPath(value);
  return { filePath, run: JSON.parse(await readFile(filePath, "utf8")) };
}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const [key, inline] = argument.slice(2).split("=", 2);
    const next = argv[index + 1];
    flags[key] = inline ?? (next && !next.startsWith("--") ? argv[++index] : true);
  }
  return flags;
}

export async function runCompareCli(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  if (typeof flags.baseline !== "string" || typeof flags.candidate !== "string") {
    throw new Error("Usage: node scripts/eval/compare.mjs --baseline <run-dir-or-json> --candidate <run-dir-or-json> [--output-dir <dir>]");
  }
  const baseline = await readRun(flags.baseline);
  const candidate = await readRun(flags.candidate);
  const outputDir = typeof flags["output-dir"] === "string"
    ? flags["output-dir"]
    : path.dirname(candidate.filePath);
  const result = await writeEvalComparison({ baseline: baseline.run, candidate: candidate.run, outputDir });
  process.stdout.write(`Evaluation comparison: ${result.markdownPath}\n`);
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await runCompareCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
