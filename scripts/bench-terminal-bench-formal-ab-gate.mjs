#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadFormalABPreregistration,
  validateFormalABPreregistration
} from "./bench-terminal-bench-formal-ab-preregistration.mjs";

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function normalizedResult(value, index, allowedIndexes) {
  const item = record(value, `records[${index}]`);
  const fields = Object.keys(item).sort();
  const expected = ["arm", "cost_usd", "infra_failure", "passed", "task_index", "timeout"].sort();
  if (JSON.stringify(fields) !== JSON.stringify(expected)
    || !allowedIndexes.has(item.task_index)
    || !["baseline", "candidate"].includes(item.arm)
    || typeof item.passed !== "boolean"
    || typeof item.infra_failure !== "boolean"
    || typeof item.timeout !== "boolean"
    || typeof item.cost_usd !== "number"
    || !Number.isFinite(item.cost_usd)
    || item.cost_usd < 0) {
    throw new Error(`records[${index}] is malformed or outside the sealed stage.`);
  }
  return item;
}

function aggregate(items) {
  return {
    passes: items.filter((item) => item.passed).length,
    infra_failures: items.filter((item) => item.infra_failure).length,
    timeouts: items.filter((item) => item.timeout).length,
    cost_usd: items.reduce((sum, item) => sum + item.cost_usd, 0)
  };
}

function withinCost(candidate, baseline, ratio) {
  return baseline === 0 ? candidate === 0 : candidate <= baseline * ratio + 1e-9;
}

export function evaluateFormalABGate(
  manifestValue,
  stage,
  recordsValue,
  checks = {}
) {
  const manifest = validateFormalABPreregistration(manifestValue);
  if (stage !== "canary" && stage !== "release") {
    throw new Error("Formal A/B gate stage must be canary or release.");
  }
  const indexes = stage === "canary"
    ? manifest.execution.canary_task_indexes
    : [
        ...manifest.execution.canary_task_indexes,
        ...manifest.execution.remaining_task_indexes
      ];
  const allowedIndexes = new Set(indexes);
  if (!Array.isArray(recordsValue)) throw new Error("records must be an array.");
  const records = recordsValue.map((item, index) =>
    normalizedResult(item, index, allowedIndexes));
  const expectedKeys = new Set(indexes.flatMap((taskIndex) => [
    `${taskIndex}:baseline`, `${taskIndex}:candidate`
  ]));
  const observedKeys = records.map((item) => `${item.task_index}:${item.arm}`);
  if (records.length !== expectedKeys.size
    || new Set(observedKeys).size !== observedKeys.length
    || observedKeys.some((key) => !expectedKeys.has(key))) {
    throw new Error("Every sealed stage task must have exactly one result per arm.");
  }
  const baselineItems = records.filter((item) => item.arm === "baseline");
  const candidateItems = records.filter((item) => item.arm === "candidate");
  const baseline = aggregate(baselineItems);
  const candidate = aggregate(candidateItems);
  const resultByKey = new Map(observedKeys.map((key, index) => [key, records[index]]));
  let pairedWins = 0;
  let pairedLosses = 0;
  for (const taskIndex of indexes) {
    const baselinePass = resultByKey.get(`${taskIndex}:baseline`).passed;
    const candidatePass = resultByKey.get(`${taskIndex}:candidate`).passed;
    if (candidatePass && !baselinePass) pairedWins += 1;
    if (baselinePass && !candidatePass) pairedLosses += 1;
  }
  const gate = stage === "canary" ? manifest.gates.canary : manifest.gates.release;
  const reasons = [];
  if (candidate.passes < baseline.passes + gate.minimum_pass_delta) {
    reasons.push("pass_delta");
  }
  if (gate.candidate_infra_failures_lte_baseline
    && candidate.infra_failures > baseline.infra_failures) reasons.push("infra_regression");
  if (Number.isInteger(gate.candidate_infra_failures)
    && candidate.infra_failures !== gate.candidate_infra_failures) reasons.push("candidate_infra_failure");
  if (gate.candidate_timeouts_lte_baseline
    && candidate.timeouts > baseline.timeouts) reasons.push("timeout_regression");
  if (!withinCost(candidate.cost_usd, baseline.cost_usd, gate.maximum_cost_ratio)) {
    reasons.push("cost_regression");
  }
  if (gate.paired_wins_must_exceed_losses && pairedWins <= pairedLosses) {
    reasons.push("paired_outcome");
  }
  if (gate.require_safety_and_fairness
    && (checks.safetyPassed !== true || checks.fairnessPassed !== true)) {
    reasons.push("safety_or_fairness");
  }
  return {
    schemaVersion: 1,
    kind: "SigmaFormalABGateResult",
    formal_ab_id: manifest.formal_ab_id,
    consumption_identity_sha256: manifest.consumption_identity_sha256,
    stage,
    status: reasons.length === 0 ? "passed" : "failed",
    candidate_lifecycle: reasons.length === 0
      ? stage === "canary" ? "frozen_continue" : "released"
      : "closed",
    baseline,
    candidate,
    paired: { wins: pairedWins, losses: pairedLosses, ties: indexes.length - pairedWins - pairedLosses },
    checks: {
      safety_passed: checks.safetyPassed === true,
      fairness_passed: checks.fairnessPassed === true
    },
    failure_reasons: reasons
  };
}

async function main(argv) {
  const [manifestPath, expectedSha256, stage, recordsPath] = argv;
  if (!manifestPath || !expectedSha256 || !stage || !recordsPath) {
    throw new Error("Usage: node scripts/bench-terminal-bench-formal-ab-gate.mjs <manifest> <sha256> <canary|release> <aggregate-records.json>");
  }
  const { manifest } = await loadFormalABPreregistration(manifestPath, expectedSha256);
  const input = JSON.parse(await readFile(path.resolve(recordsPath), "utf8"));
  const records = Array.isArray(input) ? input : input.records;
  const checks = Array.isArray(input) ? {} : {
    safetyPassed: input.safety_passed,
    fairnessPassed: input.fairness_passed
  };
  process.stdout.write(`${JSON.stringify(
    evaluateFormalABGate(manifest, stage, records, checks), null, 2
  )}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
