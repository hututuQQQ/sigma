import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCodexReviewPack,
  buildEvalRunReport,
  renderCodexReviewMarkdown,
  renderEvalReportMarkdown,
  writeEvalReport
} from "../scripts/eval/report.mjs";
import {
  assertComparableEvalRuns,
  compareEvalRuns,
  renderEvalComparisonMarkdown,
  runCompareCli,
  writeEvalComparison
} from "../scripts/eval/compare.mjs";

const dimensions = (passing = true) => ({
  correctness: {
    status: passing ? "pass" : "fail",
    checks: [{ name: "post-run verifier", ok: passing, detail: passing ? "passed" : "expected file missing" }]
  },
  safety: { status: "pass", violations: [] },
  experience: { status: "pass", violations: [], warnings: [] },
  reliability: { status: "pass", signals: [] }
});

const subject = (overrides: Record<string, unknown> = {}) => ({
  provider: "deepseek",
  model: "deepseek-v4-pro",
  surface: "cli",
  permissionPolicy: "auto",
  platform: "win32",
  arch: "x64",
  gitSha: "abc123",
  configDigest: "config-1",
  fixtureDigest: "fixture-1",
  scenarioDigest: "scenario-1",
  evaluatorDigest: "evaluator-1",
  verifierDigest: "verifier-1",
  brokerDigest: "broker-1",
  subjectKind: "built-cli",
  ...overrides
});

function attempt({
  scenarioId = "small-edit",
  repetition = 1,
  passing = true,
  durationMs = 1000,
  subjectOverrides = {},
  artifacts = {}
}: {
  scenarioId?: string;
  repetition?: number;
  passing?: boolean;
  durationMs?: number;
  subjectOverrides?: Record<string, unknown>;
  artifacts?: Record<string, unknown>;
} = {}) {
  return {
    schemaVersion: 1,
    kind: "eval_attempt",
    runId: "run-current",
    attemptId: `${scenarioId}-${repetition}`,
    scenarioId,
    suites: ["experience"],
    repetition,
    startedAt: "2026-07-12T00:00:00.000Z",
    finishedAt: "2026-07-12T00:00:01.000Z",
    subject: subject(subjectOverrides),
    outcome: {
      status: passing ? "completed" : "failed",
      finishReason: passing ? "complete_task" : "deadline",
      sessionId: `session-${repetition}`,
      exitCode: passing ? 0 : 1
    },
    dimensions: dimensions(passing),
    metrics: {
      durationMs,
      counts: {
        modelTurns: passing ? 4 : 12,
        toolCalls: passing ? 8 : 24,
        toolFailures: passing ? 0 : 8,
        approvals: 0,
        contextCompactions: passing ? 0 : 3
      },
      usage: { inputTokens: passing ? 10_000 : 80_000, outputTokens: 500, costUsd: 0.04 },
      repetition: { duplicateRequestRate: passing ? 0 : 0.5, duplicateOutputBytes: passing ? 0 : 4096 },
      stagnation: { windowCount: passing ? 0 : 2 },
      postAnswer: { toolCalls: passing ? 0 : 3, durationMs: passing ? 0 : 5000 }
    },
    artifacts: {
      events: `attempts/${scenarioId}-${repetition}/events.jsonl`,
      diff: `attempts/${scenarioId}-${repetition}/workspace.diff`,
      ...artifacts
    }
  };
}

function run(attempts: ReturnType<typeof attempt>[], overrides: Record<string, unknown> = {}) {
  const runId = typeof overrides.runId === "string" ? overrides.runId : "run-current";
  return {
    schemaVersion: 1,
    kind: "eval_run",
    runId,
    suite: "experience",
    repeat: 3,
    startedAt: "2026-07-12T00:00:00.000Z",
    finishedAt: "2026-07-12T00:05:00.000Z",
    subject: subject(),
    attempts: attempts.map((item) => ({ ...item, runId })),
    scenarios: [],
    counts: {},
    status: "unknown",
    ...overrides
  };
}

function hasScoreKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasScoreKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => key.toLowerCase().includes("score") || hasScoreKey(child));
}

describe("agent evaluation report", () => {
  it("aggregates three repetitions without hiding dimensions behind a single score", () => {
    const input = run([
      attempt({ scenarioId: "stable", repetition: 1 }),
      attempt({ scenarioId: "stable", repetition: 2 }),
      attempt({ scenarioId: "stable", repetition: 3 }),
      attempt({ scenarioId: "flaky", repetition: 1 }),
      attempt({ scenarioId: "flaky", repetition: 2, passing: false }),
      attempt({ scenarioId: "flaky", repetition: 3, passing: false }),
      attempt({ scenarioId: "failed", repetition: 1, passing: false }),
      attempt({ scenarioId: "failed", repetition: 2, passing: false }),
      attempt({ scenarioId: "failed", repetition: 3, passing: false })
    ]);

    const report = buildEvalRunReport(input);

    expect(report.scenarios.map((scenario: { scenarioId: string; status: string }) => [scenario.scenarioId, scenario.status])).toEqual([
      ["failed", "fail"],
      ["flaky", "flaky"],
      ["stable", "stable"]
    ]);
    expect(report.counts).toMatchObject({
      attempts: { total: 9, passed: 4, failed: 5 },
      scenarios: { total: 3, stable: 1, flaky: 1, failed: 1 }
    });
    expect(report.dimensions).toEqual({
      correctness: "fail",
      safety: "stable",
      experience: "stable",
      reliability: "stable"
    });
    expect(hasScoreKey(report)).toBe(false);
    expect(renderEvalReportMarkdown(report)).toContain("does not calculate a composite score");
  });

  it("accepts a versioned attempt as a one-repetition run and rejects unversioned input", () => {
    const report = buildEvalRunReport(attempt());
    expect(report).toMatchObject({ repeat: 1, status: "stable", counts: { attempts: { total: 1, passed: 1 } } });
    expect(() => buildEvalRunReport({ kind: "eval_run", attempts: [] })).toThrow("versioned");
  });

  it("rejects duplicate attempt identities and repetitions instead of manufacturing stability", () => {
    const duplicate = attempt();
    expect(() => buildEvalRunReport(run([duplicate, { ...duplicate }], { repeat: 2 })))
      .toThrow("unique attemptId");
    expect(() => buildEvalRunReport(run([duplicate, { ...duplicate, attemptId: "second" }], { repeat: 2 })))
      .toThrow("scenarioId/repetition");
  });

  it("keeps a declared scenario visible when no attempt was produced", () => {
    const report = buildEvalRunReport(run([], {
      scenarios: [{ scenarioId: "never-launched", scenarioDigest: "scenario-never-launched" }]
    }));

    expect(report.status).toBe("fail");
    expect(report.scenarios).toEqual([expect.objectContaining({
      scenarioId: "never-launched",
      scenarioDigest: "scenario-never-launched",
      attempts: 0,
      missingAttempts: 3,
      status: "fail"
    })]);
    expect(report.dimensions).toEqual({
      correctness: "fail", safety: "fail", experience: "fail", reliability: "fail"
    });
    expect(buildCodexReviewPack(report).topSignals).toContainEqual(expect.objectContaining({
      code: "scenario_not_attempted", severity: "blocker"
    }));
  });

  it("makes evaluator infrastructure failures visible in status, dimensions, and Codex signals", () => {
    const report = buildEvalRunReport(run([attempt()], {
      repeat: 1,
      infrastructureErrors: [{ code: "subject_preparation_failed", phase: "subject_preparation" }]
    }));
    expect(report.status).toBe("fail");
    expect(report.dimensions.reliability).toBe("fail");
    expect(buildCodexReviewPack(report).topSignals).toContainEqual(expect.objectContaining({
      code: "subject_preparation_failed", severity: "blocker"
    }));
    expect(renderEvalReportMarkdown(report)).toContain("Evaluator Infrastructure Failures");
  });

  it("treats an expected needs-input terminal as a passing outcome", () => {
    const needsInput = {
      ...attempt(),
      outcome: { status: "needs_input", actual: "needs_input", expectedTerminal: "needs_input", expected: true }
    };
    const report = buildEvalRunReport(needsInput);
    const review = buildCodexReviewPack(report);

    expect(report.status).toBe("stable");
    expect(review.topSignals.some((signal: { code: string }) => signal.code === "incomplete_outcome")).toBe(false);
  });

  it("summarizes the durable-event reducer metric shape", () => {
    const reducerShaped = {
      ...attempt(),
      metrics: {
        durationMs: 12_000,
        counts: { modelTurns: 7, toolCalls: 10, toolFailures: 2, toolFailureRate: 0.2, approvals: 1, contextCompactions: 2 },
        usageTotals: {
          inputTokens: 42_000, outputTokens: 700, costMicroUsd: 125_000, costUsd: 0.125, latencyMs: 8000,
          reviewer: { records: 1, inputTokens: 2000, outputTokens: 100, costMicroUsd: 5000, latencyMs: 750 }
        },
        repeatedExactRequests: { repeated: 4, rate: 0.4 },
        repeatedOutputs: { repeatedBytes: 8192 },
        stagnationWindows: [{ durationMs: 4000 }, { durationMs: 7000 }],
        postAnswerChurn: { durationMs: 5000, toolCalls: 3 },
        steer: { maxStopDelayMs: 2500, staleActions: 2 },
        hardFailures: []
      }
    };

    const report = buildEvalRunReport(reducerShaped);

    expect(report.scenarios[0].metrics).toMatchObject({
      toolFailureRate: { median: 0.2 },
      inputTokens: { median: 42_000 },
      providerLatencyMs: { median: 8000 },
      reviewerCostUsd: { median: 0.005 },
      reviewerLatencyMs: { median: 750 },
      duplicateRequestRate: { median: 0.4 },
      duplicateOutputBytes: { median: 8192 },
      stagnationWindows: { median: 2 },
      longestStagnationMs: { median: 7000 },
      postAnswerToolCalls: { median: 3 },
      steerStopLatencyMs: { median: 2500 }
    });
  });

  it("writes the run, human report, Codex evidence pack, and latest pointer with secrets redacted", async () => {
    const root = path.join(os.tmpdir(), `sigma-eval-report-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const runDir = path.join(root, "run-current");
    const input = run([
      {
        ...attempt({ artifacts: { verifierLog: "attempts/small-edit-1/verifier.log" } }),
        apiKey: "sk-this-value-must-never-be-written"
      },
      attempt({ repetition: 2 }),
      attempt({ repetition: 3 })
    ] as ReturnType<typeof attempt>[]);

    const result = await writeEvalReport({ run: input, runDir, evalRootDir: root });
    const persisted = await readFile(result.runPath, "utf8");
    const markdown = await readFile(result.reportPath, "utf8");
    const codexReview = await readFile(result.codexReviewPath, "utf8");
    const latest = JSON.parse(await readFile(result.latestPath, "utf8"));

    expect(persisted).not.toContain("sk-this-value-must-never-be-written");
    expect(persisted).toContain("[REDACTED]");
    expect(markdown).toContain("# Sigma Agent Experience Evaluation");
    expect(codexReview).toContain("No reviewer model was called");
    expect(codexReview).toContain("attempts/small-edit-1/verifier.log");
    expect(codexReview).toContain("## Verdict Rubric");
    expect(latest).toEqual(expect.objectContaining({
      schemaVersion: 1,
      kind: "eval_latest",
      runId: "run-current",
      runDir: "run-current",
      files: { run: "run-current/run.json", report: "run-current/report.md", codexReview: "run-current/codex-review.md" }
    }));
  });

  it("builds a deterministic Codex pack with blocker signals and evidence paths", () => {
    const failed = run([
      attempt({ passing: false, repetition: 1 }),
      attempt({ passing: false, repetition: 2 }),
      attempt({ passing: false, repetition: 3 })
    ]);
    const pack = buildCodexReviewPack(failed);

    expect(pack.topSignals.some((signal: { code: string }) => signal.code === "correctness_failure")).toBe(true);
    expect(pack.topSignals.some((signal: { code: string }) => signal.code === "incomplete_outcome")).toBe(true);
    expect(pack.evidence[0].paths).toContain("attempts/small-edit-1/events.jsonl");
    expect(renderCodexReviewMarkdown(pack)).toContain("Do not use scenario identity or verifier output");
  });
});

describe("agent evaluation baseline comparison", () => {
  it("uses controlled environment identity, treats subject identity as the variant, and rejects self-comparison", () => {
    const baseline = run([attempt({
      subjectOverrides: { environmentDigest: "environment-1", subjectDigest: "subject-a" }
    })], {
      repeat: 1,
      subject: subject({ environmentDigest: "environment-1", subjectDigest: "subject-a" })
    });
    const candidate = run([attempt({
      subjectOverrides: { environmentDigest: "environment-1", subjectDigest: "subject-b" }
    })], {
      runId: "run-candidate",
      repeat: 1,
      subject: subject({ environmentDigest: "environment-1", subjectDigest: "subject-b" })
    });

    const comparison = compareEvalRuns(baseline, candidate);
    expect(comparison.comparable).toBe(true);
    expect(comparison.compatibility.requiredFields).toContain("environmentDigest");
    expect(comparison.compatibility.requiredFields).not.toContain("subjectDigest");
    expect(comparison.baseline.subjectDigest).toBe("subject-a");
    expect(comparison.candidate.subjectDigest).toBe("subject-b");

    const differentEnvironment = run([attempt({
      subjectOverrides: { environmentDigest: "environment-2", subjectDigest: "subject-b" }
    })], {
      runId: "run-other-environment",
      repeat: 1,
      subject: subject({ environmentDigest: "environment-2", subjectDigest: "subject-b" })
    });
    expect(compareEvalRuns(baseline, differentEnvironment).compatibility.mismatches)
      .toContainEqual(expect.objectContaining({ field: "environmentDigest" }));
    expect(compareEvalRuns(baseline, baseline).compatibility.mismatches)
      .toContainEqual(expect.objectContaining({ field: "runId" }));
  });

  it("compares only compatible runs and reports candidate-minus-baseline metric changes", () => {
    const baseline = run([1, 2, 3].map((repetition) => attempt({ repetition, durationMs: 2000 })));
    const candidate = run([1, 2, 3].map((repetition) => attempt({ repetition, durationMs: 1000 })), {
      runId: "run-candidate"
    });

    const comparison = compareEvalRuns(baseline, candidate);

    expect(comparison.comparable).toBe(true);
    expect(comparison.metrics.durationMs).toEqual({
      baseline: 2000,
      candidate: 1000,
      delta: -1000,
      deltaPercent: -50,
      change: "improved"
    });
    expect(comparison.passRate).toMatchObject({ baseline: 1, candidate: 1, delta: 0, change: "unchanged" });
    expect(comparison.scenarios[0].passRate).toMatchObject({ baseline: 1, candidate: 1, delta: 0 });
    expect(comparison.scenarios[0].metrics.durationMs.delta).toBe(-1000);
    expect(comparison.dimensions).toMatchObject({
      correctness: { baseline: "stable", candidate: "stable", change: "unchanged" }
    });
    expect(renderEvalComparisonMarkdown(comparison)).toContain("Delta is candidate minus baseline");
    expect(renderEvalComparisonMarkdown(comparison)).toContain("Attempt pass rate: 100% -> 100%");
    expect(hasScoreKey(comparison)).toBe(false);
  });

  it("reports candidate-minus-baseline pass-rate changes over planned attempts", () => {
    const baseline = run([
      attempt({ repetition: 1 }), attempt({ repetition: 2, passing: false }), attempt({ repetition: 3, passing: false })
    ]);
    const candidate = run([
      attempt({ repetition: 1 }), attempt({ repetition: 2 }), attempt({ repetition: 3, passing: false })
    ], { runId: "run-candidate" });

    const comparison = compareEvalRuns(baseline, candidate);

    expect(comparison.passRate.baseline).toBeCloseTo(1 / 3);
    expect(comparison.passRate.candidate).toBeCloseTo(2 / 3);
    expect(comparison.passRate.delta).toBeCloseTo(1 / 3);
    expect(comparison.passRate.change).toBe("improved");
  });

  it("uses concrete attempt surfaces instead of the mixed run summary for compatibility", () => {
    const baseline = run([attempt()], { subject: subject({ surface: "mixed" }), repeat: 1 });
    const candidate = run([attempt()], {
      runId: "run-candidate",
      subject: subject({ surface: "mixed" }),
      repeat: 1
    });

    const comparison = compareEvalRuns(baseline, candidate);
    expect(comparison.comparable).toBe(true);
    expect(comparison.compatibility.mismatches).toEqual([]);
  });

  it("invalidates metric deltas when scenario, model, platform, surface, or config evidence differs", () => {
    const baseline = run([1, 2, 3].map((repetition) => attempt({ repetition })));
    const candidate = run([1, 2, 3].map((repetition) => attempt({
      repetition,
      subjectOverrides: { configDigest: "config-2", scenarioDigest: "scenario-2" }
    })), {
      runId: "run-candidate",
      subject: subject({ configDigest: "config-2", scenarioDigest: "scenario-2" })
    });

    const comparison = compareEvalRuns(baseline, candidate);

    expect(comparison.comparable).toBe(false);
    expect(comparison.compatibility.mismatches.map((item: { field: string }) => item.field)).toEqual(expect.arrayContaining([
      "scenarioDigest", "configDigest"
    ]));
    expect(comparison.metrics.durationMs).toMatchObject({ change: "invalid", delta: null });
    expect(comparison.scenarios).toEqual([]);
    expect(() => assertComparableEvalRuns(baseline, candidate)).toThrow("not comparable");
    expect(renderEvalComparisonMarkdown(comparison)).toContain("Compatibility Gate Failed");
  });

  it("invalidates deltas for evaluator infrastructure failures or different repetition plans", () => {
    const baseline = run([attempt()], {
      repeat: 1,
      infrastructureErrors: [{ code: "evaluator_infrastructure_error", phase: "verifier" }]
    });
    const candidate = run([attempt()], { runId: "run-candidate", repeat: 3 });

    const comparison = compareEvalRuns(baseline, candidate);

    expect(comparison.comparable).toBe(false);
    expect(comparison.compatibility.mismatches.map((item: { field: string }) => item.field)).toEqual(expect.arrayContaining([
      "repeat", "infrastructureValidity"
    ]));
    expect(comparison.metrics.durationMs).toMatchObject({ change: "invalid", delta: null });
    expect(comparison.scenarios).toEqual([]);
  });

  it("marks every metric invalid when durable event evidence is missing", () => {
    const brokenAttempt = attempt();
    brokenAttempt.dimensions.reliability = {
      status: "fail",
      signals: [{ severity: "blocker", code: "missing_durable_events" }]
    };
    const baseline = run([brokenAttempt], { repeat: 1 });
    const candidate = run([attempt()], { runId: "run-candidate", repeat: 1 });

    const comparison = compareEvalRuns(baseline, candidate);
    expect(comparison.comparable).toBe(false);
    expect(comparison.compatibility.mismatches).toContainEqual(expect.objectContaining({ field: "infrastructureValidity" }));
    expect(Object.values(comparison.metrics).every((metric: any) => metric.change === "invalid")).toBe(true);
  });

  it("rejects a metric delta when valid sample counts differ", () => {
    const candidateAttempt = attempt();
    delete candidateAttempt.metrics.counts.toolCalls;
    const comparison = compareEvalRuns(
      run([attempt()], { repeat: 1 }),
      run([candidateAttempt], { runId: "run-candidate", repeat: 1 })
    );
    expect(comparison.comparable).toBe(false);
    expect(comparison.compatibility.mismatches).toContainEqual(expect.objectContaining({
      field: "metricSamples.toolCalls", baseline: 1, candidate: 0
    }));
    expect(comparison.metrics.toolCalls.change).toBe("invalid");
  });

  it("writes comparison artifacts and supports directory inputs in the CLI", async () => {
    const root = path.join(os.tmpdir(), `sigma-eval-compare-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const baselineDir = path.join(root, "baseline");
    const candidateDir = path.join(root, "candidate");
    await mkdir(baselineDir, { recursive: true });
    await mkdir(candidateDir, { recursive: true });
    const baseline = buildEvalRunReport(run([1, 2, 3].map((repetition) => attempt({ repetition }))));
    const candidate = buildEvalRunReport(run([1, 2, 3].map((repetition) => attempt({ repetition, durationMs: 500 })), {
      runId: "run-candidate"
    }));
    await writeFile(path.join(baselineDir, "run.json"), JSON.stringify(baseline), "utf8");
    await writeFile(path.join(candidateDir, "run.json"), JSON.stringify(candidate), "utf8");

    const direct = await writeEvalComparison({ baseline, candidate, outputDir: path.join(root, "direct") });
    expect(JSON.parse(await readFile(direct.jsonPath, "utf8"))).toMatchObject({ comparable: true });
    expect(await readFile(direct.markdownPath, "utf8")).toContain("Metric Changes");

    const cli = await runCompareCli(["--baseline", baselineDir, "--candidate", candidateDir]);
    expect(cli.markdownPath).toBe(path.join(candidateDir, "comparison.md"));
  });
});
