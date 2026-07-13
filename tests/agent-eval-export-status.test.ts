import { describe, expect, it } from "vitest";
import {
  buildSanitizedEvaluationStatus,
  sanitizeEvaluationStatusReport
} from "../scripts/eval/export-status.mjs";

function report(overrides: Record<string, unknown> = {}) {
  return {
    sourceSchemaVersion: 2,
    suite: "quick",
    repeat: 1,
    status: "stable",
    subject: { platform: "linux", arch: "x64" },
    validity: { valid: 3, invalid: 0, notObserved: 0, missing: 0 },
    dimensions: Object.fromEntries([
      "correctness", "delivery", "safety", "experience", "reliability"
    ].map((name) => [name, { status: "pass" }])),
    statistics: {
      passRate: { rate: 1, lower: 0.56, upper: 1, passed: 3, total: 3 },
      costPerSuccessUsd: 0.01
    },
    failureConvergence: {
      coverage: { observed: 3, total: 3, status: "complete" },
      failFastMissed: 0, totalOvershoot: 0, recoveryFailed: 0
    },
    mutationDiscipline: {
      coverage: { observed: 3, total: 3, status: "complete" },
      mutationRequests: 0, writeContractFailures: 0, checkpointLimitFailures: 1,
      emptyCheckpoints: 2, openCheckpointsAtTerminal: 3
    },
    scenarios: [{ scenarioId: "must-never-leave-the-runner" }],
    attempts: [{ evidence: "private/raw.log", prompt: "private prompt" }],
    ...overrides
  };
}

describe("sanitized evaluation status export", () => {
  it("exports aggregate canary data without raw, scenario, prompt, verifier, or evidence fields", () => {
    const result = buildSanitizedEvaluationStatus([report()], {
      mode: "nightly", generatedAt: "2026-07-14T00:00:00.000Z"
    });
    expect(result).toMatchObject({
      mode: "nightly",
      interpretation: "canary_alert_only_no_improvement_or_regression_claim",
      complete: true
    });
    const encoded = JSON.stringify(result);
    expect(encoded).not.toMatch(/scenario|attempt|prompt|verifier|evidence|private/iu);
    expect(result.reports[0]?.statistics.passRate).toMatchObject({ rate: 1, passed: 3, total: 3 });
    expect(result.reports[0]?.mutationDiscipline).toMatchObject({
      checkpointLimitFailures: 1, emptyCheckpoints: 2, openCheckpointsAtTerminal: 3
    });
  });

  it("marks weekly samples inconclusive unless every aggregate is V2 repeat-three and valid", () => {
    expect(buildSanitizedEvaluationStatus([report()], { mode: "weekly" }).interpretation).toBe("inconclusive");
    const complete = report({ suite: "repo-scale", repeat: 3 });
    const experience = report({ suite: "experience", repeat: 3 });
    expect(buildSanitizedEvaluationStatus([experience, complete], { mode: "weekly" })).toMatchObject({
      complete: true, interpretation: "trend_sample_observed"
    });
    expect(buildSanitizedEvaluationStatus([complete], { mode: "weekly" })).toMatchObject({
      complete: false, interpretation: "inconclusive"
    });
    const incompleteMetrics = report({
      suite: "experience", repeat: 3,
      failureConvergence: { coverage: { observed: 2, total: 3, status: "incomplete" } }
    });
    expect(buildSanitizedEvaluationStatus([incompleteMetrics, complete], { mode: "weekly" }))
      .toMatchObject({ complete: false, interpretation: "inconclusive" });
  });

  it("does not copy unknown report fields", () => {
    expect(sanitizeEvaluationStatusReport(report())).not.toHaveProperty("scenarios");
    expect(sanitizeEvaluationStatusReport(report())).not.toHaveProperty("attempts");
  });
});
