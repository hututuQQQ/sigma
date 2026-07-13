#!/usr/bin/env node
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIMENSIONS = ["correctness", "delivery", "safety", "experience", "reliability"];

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statusOrUnavailable(value) {
  const status = typeof value === "string" ? value : value?.status;
  return typeof status === "string" ? status : "unavailable";
}

function countOrUnavailable(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : "unavailable";
}

function coverageOrUnavailable(value) {
  return {
    observed: countOrUnavailable(value?.observed),
    total: countOrUnavailable(value?.total),
    status: value?.status === "complete" || value?.status === "incomplete" ? value.status : "unavailable"
  };
}

// Explicit allowlisting is intentionally verbose: unknown/raw report fields
// must never flow into an uploadable status artifact.
// eslint-disable-next-line complexity
export function sanitizeEvaluationStatusReport(report) {
  const validity = report?.validity && typeof report.validity === "object" ? report.validity : {};
  const passRate = report?.statistics?.passRate && typeof report.statistics.passRate === "object"
    ? report.statistics.passRate : {};
  const failure = report?.failureConvergence ?? {};
  const mutation = report?.mutationDiscipline ?? {};
  return {
    schemaVersion: 1,
    sourceSchemaVersion: report?.sourceSchemaVersion ?? "unavailable",
    suite: typeof report?.suite === "string" ? report.suite : "unavailable",
    repeat: countOrUnavailable(report?.repeat),
    status: typeof report?.status === "string" ? report.status : "unavailable",
    platform: typeof report?.subject?.platform === "string" ? report.subject.platform : "unavailable",
    arch: typeof report?.subject?.arch === "string" ? report.subject.arch : "unavailable",
    validity: {
      valid: countOrUnavailable(validity.valid),
      invalid: countOrUnavailable(validity.invalid),
      notObserved: countOrUnavailable(validity.notObserved),
      missing: countOrUnavailable(validity.missing)
    },
    dimensions: Object.fromEntries(DIMENSIONS.map((name) => [name, statusOrUnavailable(report?.dimensions?.[name])])),
    statistics: {
      passRate: {
        rate: finiteOrNull(passRate.rate),
        lower: finiteOrNull(passRate.lower),
        upper: finiteOrNull(passRate.upper),
        passed: countOrUnavailable(passRate.passed),
        total: countOrUnavailable(passRate.total)
      },
      costPerSuccessUsd: finiteOrNull(report?.statistics?.costPerSuccessUsd)
    },
    failureConvergence: {
      coverage: coverageOrUnavailable(failure.coverage),
      failFastMissed: finiteOrNull(failure.failFastMissed),
      totalOvershoot: finiteOrNull(failure.totalOvershoot),
      recoveryFailed: finiteOrNull(failure.recoveryFailed)
    },
    mutationDiscipline: {
      coverage: coverageOrUnavailable(mutation.coverage),
      mutationRequests: finiteOrNull(mutation.mutationRequests),
      writeContractFailures: finiteOrNull(mutation.writeContractFailures),
      checkpointLimitFailures: finiteOrNull(mutation.checkpointLimitFailures),
      emptyCheckpoints: finiteOrNull(mutation.emptyCheckpoints),
      openCheckpointsAtTerminal: finiteOrNull(mutation.openCheckpointsAtTerminal)
    }
  };
}

function metricCoverageComplete(report, validAttempts) {
  return [report?.failureConvergence, report?.mutationDiscipline].every((metrics) =>
    metrics?.coverage?.status === "complete"
      && metrics.coverage.observed === validAttempts
      && metrics.coverage.total === validAttempts);
}

function weeklyReportConclusive(report) {
  const validity = report.validity;
  const dimensionStatuses = DIMENSIONS.map((name) => statusOrUnavailable(report?.dimensions?.[name]));
  return report.sourceSchemaVersion === 2
    && report.repeat === 3
    && Number.isSafeInteger(validity?.valid) && validity.valid > 0
    && validity.invalid === 0 && validity.notObserved === 0 && validity.missing === 0
    && report.status !== "inconclusive"
    && dimensionStatuses.every((status) => status !== "inconclusive" && status !== "unavailable")
    && report.statistics?.passRate?.total === validity.valid
    && metricCoverageComplete(report, validity.valid);
}

export function buildSanitizedEvaluationStatus(reports, options = {}) {
  const mode = options.mode === "weekly" ? "weekly" : "nightly";
  const summaries = reports.map(sanitizeEvaluationStatusReport);
  const expectedSuites = options.expectedSuites ?? (mode === "nightly" ? ["quick"] : ["experience", "repo-scale"]);
  const observedSuites = reports.map((report) => report?.suite).filter((value) => typeof value === "string").sort();
  const suitesComplete = reports.length === expectedSuites.length
    && JSON.stringify(observedSuites) === JSON.stringify([...expectedSuites].sort());
  const platforms = new Set(reports.map((report) => `${report?.subject?.platform ?? ""}:${report?.subject?.arch ?? ""}`));
  const complete = suitesComplete && platforms.size === 1 && (mode === "nightly"
    ? reports.every((report) => report?.sourceSchemaVersion === 2 && report?.repeat === 1)
    : reports.every(weeklyReportConclusive));
  return {
    schemaVersion: 1,
    kind: "sigma.sanitized-evaluation-status",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    mode,
    interpretation: mode === "nightly"
      ? "canary_alert_only_no_improvement_or_regression_claim"
      : complete ? "trend_sample_observed" : "inconclusive",
    complete,
    reports: summaries
  };
}

async function findRunReports(root) {
  const found = [];
  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name === "run.json") {
        const [report, details] = await Promise.all([
          readFile(target, "utf8").then(JSON.parse), stat(target)
        ]);
        found.push({ report, modifiedMs: details.mtimeMs });
      }
    }
  }
  await visit(path.resolve(root));
  return found.sort((left, right) => right.modifiedMs - left.modifiedMs).map((item) => item.report);
}

function parseArgs(argv) {
  const result = { inputs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[++index];
    if (!value) throw new Error("Usage: export-status.mjs --mode <nightly|weekly> --output <file> --input <directory> [...]");
    if (key === "--input") result.inputs.push(value);
    else if (key === "--mode" || key === "--output") result[key.slice(2)] = value;
    else throw new Error(`Unknown argument ${key}.`);
  }
  if (!new Set(["nightly", "weekly"]).has(result.mode) || !result.output || result.inputs.length === 0) {
    throw new Error("Usage: export-status.mjs --mode <nightly|weekly> --output <file> --input <directory> [...]");
  }
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const reports = [];
  for (const input of options.inputs) reports.push((await findRunReports(input))[0] ?? null);
  const status = buildSanitizedEvaluationStatus(reports, { mode: options.mode });
  const output = path.resolve(options.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  process.stdout.write(`${status.interpretation}: ${reports.length} aggregate report(s)\n`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
