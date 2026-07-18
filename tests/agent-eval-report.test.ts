import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHumanAuditPack,
  buildEvalRunReport,
  renderHumanAuditMarkdown,
  renderEvalReportMarkdown,
  runReportCli,
  wilsonPassRate,
  writeEvalReport
} from "../scripts/eval/report.mjs";
import {
  assertComparableEvalRuns,
  compareEvalRuns,
  evaluateFrozenABGate,
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
      finishReason: passing ? "model_stop" : "deadline",
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

function attemptV2({
  scenarioId = "general-case",
  repetition = 1,
  passing = true,
  validity = "valid",
  durationMs = 1000,
  metrics = {},
  subjectOverrides = {}
}: {
  scenarioId?: string;
  repetition?: number;
  passing?: boolean;
  validity?: "valid" | "invalid" | "not_observed";
  durationMs?: number;
  metrics?: Record<string, unknown>;
  subjectOverrides?: Record<string, unknown>;
} = {}) {
  const legacy = attempt({ scenarioId, repetition, passing, durationMs, subjectOverrides });
  const observed = validity === "valid";
  return {
    ...legacy,
    schemaVersion: 2,
    validity,
    ...(observed ? {} : {
      validityDetail: { owner: "evaluator", phase: "observation", code: "observation_unavailable" }
    }),
    failureChain: { primary: null, contributing: [], terminal: null },
    dimensions: {
      correctness: observed ? legacy.dimensions.correctness : { status: "not_observed", checks: [] },
      delivery: observed ? { status: passing ? "pass" : "fail", checks: [] } : { status: "not_observed", checks: [] },
      safety: observed ? legacy.dimensions.safety : { status: "not_observed", violations: [] },
      experience: observed ? legacy.dimensions.experience : { status: "not_observed", violations: [], warnings: [] },
      reliability: observed ? legacy.dimensions.reliability : { status: "not_observed", signals: [] }
    },
    metrics: { ...legacy.metrics, ...metrics }
  };
}

function runV2(attempts: ReturnType<typeof attemptV2>[], overrides: Record<string, unknown> = {}) {
  const runId = typeof overrides.runId === "string" ? overrides.runId : "run-v2";
  return {
    schemaVersion: 2,
    kind: "eval_run",
    runId,
    suite: "quick",
    repeat: 3,
    startedAt: "2026-07-12T00:00:00.000Z",
    finishedAt: "2026-07-12T00:05:00.000Z",
    subject: subject(),
    attempts: attempts.map((item) => ({ ...item, runId })),
    scenarios: [],
    frozenRunPolicy: { repeat: 3 },
    scheduleDigest: "schedule-1",
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
      delivery: "unavailable",
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

  it("rejects legacy attempts mixed into a V2 run", () => {
    const mixed = runV2([attemptV2()]);
    mixed.attempts[0] = attempt() as never;
    expect(() => buildEvalRunReport(mixed)).toThrow(/schemaVersion.*sourceSchemaVersion/);
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
      correctness: "fail", delivery: "unavailable", safety: "fail", experience: "fail", reliability: "fail"
    });
    expect(buildHumanAuditPack(report).topSignals).toContainEqual(expect.objectContaining({
      code: "scenario_not_attempted", severity: "blocker"
    }));
  });

  it("makes evaluator infrastructure failures visible in status, dimensions, and the human audit view", () => {
    const report = buildEvalRunReport(run([attempt()], {
      repeat: 1,
      infrastructureErrors: [{ code: "subject_preparation_failed", phase: "subject_preparation" }]
    }));
    expect(report.status).toBe("fail");
    expect(report.dimensions.reliability).toBe("fail");
    expect(buildHumanAuditPack(report).topSignals).toContainEqual(expect.objectContaining({
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
    const review = buildHumanAuditPack(report);

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

  it("writes a labelled human-only review bundle from the same redacted snapshot", async () => {
    const root = path.join(os.tmpdir(), `sigma-eval-report-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const runDir = path.join(root, "run-current");
    const input = run([
      {
        ...attempt({ artifacts: {
          verifierLog: "attempts/small-edit-1/verifier.log",
          stdoutLog: "attempts/small-edit-1/sk-path-secret-value-12345.log"
        } }),
        apiKey: "sk-this-value-must-never-be-written"
      },
      attempt({ repetition: 2 }),
      attempt({ repetition: 3 })
    ] as ReturnType<typeof attempt>[]);

    const result = await writeEvalReport({ run: input, runDir, evalRootDir: root });
    const persisted = await readFile(result.runPath, "utf8");
    const markdown = await readFile(result.reportPath, "utf8");
    const humanAudit = JSON.parse(await readFile(result.humanAuditJsonPath, "utf8"));
    const humanAuditMarkdown = await readFile(result.humanAuditMarkdownPath, "utf8");
    const published = await Promise.all([
      readFile(result.publishedRunPath, "utf8"),
      readFile(result.publishedReportPath, "utf8"),
      readFile(result.publishedHumanAuditJsonPath, "utf8"),
      readFile(result.publishedHumanAuditMarkdownPath, "utf8")
    ]);
    const latest = JSON.parse(await readFile(result.latestPath, "utf8"));

    expect(persisted).not.toContain("sk-this-value-must-never-be-written");
    expect(persisted).toContain("[REDACTED]");
    expect(markdown).toContain("# Sigma Agent Experience Evaluation");
    expect(JSON.stringify(humanAudit)).not.toContain("sk-this-value-must-never-be-written");
    expect([persisted, markdown, humanAuditMarkdown, ...published].join("\n"))
      .not.toContain("sk-path-secret-value-12345");
    expect(humanAudit).toMatchObject({
      schemaVersion: 2,
      kind: "human_audit_pack",
      audience: "human_only",
      feedbackPolicy: "never_supply_to_solving_or_optimization_agents",
      runId: "run-current"
    });
    expect(humanAuditMarkdown).toContain("must never be supplied to a solving or optimization agent");
    expect(result).not.toHaveProperty("codexReviewPath");
    expect(result).not.toHaveProperty("humanAuditPack");
    expect(latest).toEqual(expect.objectContaining({
      schemaVersion: 2,
      kind: "eval_latest",
      runId: "run-current",
      runDir: "run-current",
      bundleDigest: result.bundleDigest,
      files: {
        run: `run-current/run.${result.bundleDigest}.json`,
        report: `run-current/report.${result.bundleDigest}.md`
      },
      humanReview: {
        schemaVersion: 2,
        kind: "human_audit_pack",
        audience: "human_only",
        feedbackPolicy: "never_supply_to_solving_or_optimization_agents",
        files: {
          audit: `run-current/human-audit.${result.bundleDigest}.json`,
          report: `run-current/human-audit.${result.bundleDigest}.md`
        }
      }
    }));
  });

  it("produces byte-identical human review files across attempt ordering and repeated writes", async () => {
    const root = path.join(os.tmpdir(), `sigma-eval-audit-determinism-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const attempts = [
      attempt({ passing: false, repetition: 1 }),
      attempt({ passing: false, repetition: 2 }),
      attempt({ passing: false, repetition: 3 })
    ];
    const first = await writeEvalReport({
      run: run(attempts), runDir: path.join(root, "first"), evalRootDir: root
    });
    const expectedJson = await readFile(first.humanAuditJsonPath, "utf8");
    const expectedMarkdown = await readFile(first.humanAuditMarkdownPath, "utf8");

    await writeEvalReport({ run: run(attempts), runDir: path.join(root, "first"), evalRootDir: root });
    const reordered = await writeEvalReport({
      run: run([...attempts].reverse()), runDir: path.join(root, "second"), evalRootDir: root
    });

    expect(await readFile(first.humanAuditJsonPath, "utf8")).toBe(expectedJson);
    expect(await readFile(first.humanAuditMarkdownPath, "utf8")).toBe(expectedMarkdown);
    expect(await readFile(reordered.humanAuditJsonPath, "utf8")).toBe(expectedJson);
    expect(await readFile(reordered.humanAuditMarkdownPath, "utf8")).toBe(expectedMarkdown);
    expect(reordered.bundleDigest).toBe(first.bundleDigest);
    expect(path.basename(reordered.publishedHumanAuditJsonPath))
      .toBe(path.basename(first.publishedHumanAuditJsonPath));
  });

  it("exposes the human review bundle through the report-only CLI", async () => {
    const root = path.join(os.tmpdir(), `sigma-eval-report-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const inputPath = path.join(root, "input.json");
    const outputDir = path.join(root, "reviewed-run");
    await mkdir(root, { recursive: true });
    await writeFile(inputPath, JSON.stringify(run([
      attempt({ repetition: 1 }), attempt({ repetition: 2 }), attempt({ repetition: 3 })
    ])), "utf8");

    const result = await runReportCli([
      "--input", inputPath, "--output-dir", outputDir, "--eval-root", root
    ]);
    const canonicalOutputDir = await realpath(outputDir);

    expect(result.humanAuditJsonPath).toBe(path.join(canonicalOutputDir, "human-audit.json"));
    expect(result.humanAuditMarkdownPath).toBe(path.join(canonicalOutputDir, "human-audit.md"));
    await expect(readFile(result.humanAuditJsonPath, "utf8")).resolves.toContain('"audience": "human_only"');
    expect(result.publishedHumanAuditJsonPath)
      .toBe(path.join(canonicalOutputDir, `human-audit.${result.bundleDigest}.json`));
  });

  it("keeps the default report destination inside the configured results root", async () => {
    const root = path.join(os.tmpdir(), `sigma-eval-report-root-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const escaping = run([
      attempt({ repetition: 1 }), attempt({ repetition: 2 }), attempt({ repetition: 3 })
    ], { runId: "../../outside-results" });

    await expect(writeEvalReport({ run: escaping, evalRootDir: root }))
      .rejects.toThrow("inside its results root");
  });

  it("does not publish through a linked directory inside the results root", async () => {
    const root = path.join(os.tmpdir(), `sigma-eval-report-linked-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const outside = path.join(os.tmpdir(), `sigma-eval-report-outside-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const linked = path.join(root, "linked-run");
    await Promise.all([mkdir(root, { recursive: true }), mkdir(outside, { recursive: true })]);
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
    const input = run([
      attempt({ repetition: 1 }), attempt({ repetition: 2 }), attempt({ repetition: 3 })
    ]);

    await expect(writeEvalReport({ run: input, runDir: linked, evalRootDir: root }))
      .rejects.toThrow(/symbolic link|reparse point/iu);
    await expect(readFile(path.join(outside, "run.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes one coherent content-addressed bundle under concurrent rewrites", async () => {
    const root = path.join(os.tmpdir(), `sigma-eval-report-concurrent-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const runDir = path.join(root, "run-current");
    const passing = run([1, 2, 3].map((repetition) => attempt({ repetition })));
    const failing = run([1, 2, 3].map((repetition) => attempt({ repetition, passing: false })));

    const results = await Promise.all([
      writeEvalReport({ run: passing, runDir, evalRootDir: root }),
      writeEvalReport({ run: failing, runDir, evalRootDir: root })
    ]);
    const latest = JSON.parse(await readFile(results[0].latestPath, "utf8"));
    const publishedRun = JSON.parse(await readFile(path.join(root, latest.files.run), "utf8"));
    const publishedAudit = JSON.parse(await readFile(
      path.join(root, latest.humanReview.files.audit), "utf8"
    ));

    expect(latest.files.run).toContain(latest.bundleDigest);
    expect(latest.files.report).toContain(latest.bundleDigest);
    expect(latest.humanReview.files.audit).toContain(latest.bundleDigest);
    expect(latest.humanReview.files.report).toContain(latest.bundleDigest);
    expect(publishedRun.status).toBe(latest.status);
    expect(publishedAudit.runStatus).toBe(latest.status);
  });

  it("keeps the deterministic detailed audit as an explicit human-only API", () => {
    const failed = run([
      attempt({ passing: false, repetition: 1 }),
      attempt({ passing: false, repetition: 2 }),
      attempt({ passing: false, repetition: 3 })
    ]);
    const pack = buildHumanAuditPack(failed);

    expect(pack.topSignals.some((signal: { code: string }) => signal.code === "correctness_failure")).toBe(true);
    expect(pack.topSignals.some((signal: { code: string }) => signal.code === "incomplete_outcome")).toBe(true);
    expect(pack.evidence[0].paths).toContain("attempts/small-edit-1/events.jsonl");
    expect(renderHumanAuditMarkdown(pack)).toContain("must never be supplied to a solving or optimization agent");
  });

  it("separates valid, invalid, not-observed, and missing V2 samples without charging correctness", () => {
    const valid = attemptV2({ repetition: 1 });
    const invalid = attemptV2({ repetition: 2, validity: "invalid" });
    const report = buildEvalRunReport(runV2([valid, invalid]));

    expect(report).toMatchObject({
      schemaVersion: 2,
      sourceSchemaVersion: 2,
      status: "inconclusive",
      validity: { valid: 1, invalid: 1, notObserved: 0, missing: 1 },
      counts: { attempts: { total: 2, valid: 1, invalid: 1, passed: 1, failed: 0 } }
    });
    expect(report.scenarios[0]).toMatchObject({
      status: "inconclusive",
      passedAttempts: 1,
      failedAttempts: 0,
      invalidAttempts: 1,
      missingAttempts: 1,
      dimensions: { correctness: { passed: 1, failed: 0, status: "inconclusive" } }
    });
    expect(report.statistics.passRate).toMatchObject({ passed: 1, total: 1, rate: 1 });
    expect(report.statistics.costPerSuccessUsd).toBe(0.04);
    expect(renderEvalReportMarkdown(report)).toContain("valid 1, invalid 1, not observed 0, missing 1");
  });

  it("keeps correctness passed when a correct subject fails only the delivery protocol", () => {
    const value = attemptV2();
    value.outcome = { status: "failed", finishReason: "terminal_protocol_failed", sessionId: "session", exitCode: 1 };
    value.dimensions.correctness = { status: "pass", checks: [{ name: "result", ok: true }] };
    value.dimensions.delivery = { status: "fail", checks: [{ name: "terminal", ok: false }] };
    const report = buildEvalRunReport(runV2([value], { repeat: 1 }));

    expect(report.validity).toEqual({ valid: 1, invalid: 0, notObserved: 0, missing: 0 });
    expect(report.dimensions).toMatchObject({ correctness: "stable", delivery: "fail" });
    expect(report.counts.attempts).toMatchObject({ passed: 0, failed: 1 });
  });

  it("reports Wilson intervals, cost per success, convergence, and mutation discipline without a composite", () => {
    const attempts = [1, 2, 3].map((repetition) => attemptV2({
      repetition,
      metrics: {
        failureConvergence: {
          episodeCount: 1, failFastEligibleEpisodes: 1, failFastTriggeredOnTime: 0,
          failFastLate: 0, failFastMissed: 1, recoverySucceeded: 0, recoveryBypassed: 0,
          recoveryFailed: 1, totalOvershoot: repetition, maxAttemptsWithoutRecovery: repetition + 3,
          byCode: { sandbox_setup_failed: 1 }, byFamily: { execution_sandbox: 1 }
        },
        mutationDiscipline: {
          mutationRequests: 1, failedMutationRequests: 1, writeContractFailures: 1,
          checkpointLimitFailures: 0, checkpointsCreated: 1, checkpointsSealed: 1,
          checkpointsRestored: 0, emptyCheckpoints: 1, openCheckpointsAtTerminal: 0,
          invalidCheckpointActions: 0, mutationFallbacksAfterInfrastructureFailure: 0,
          workspaceDeltaEvents: 0
        }
      }
    }));
    const report = buildEvalRunReport(runV2(attempts));

    expect(wilsonPassRate(2, 3)).toMatchObject({ passed: 2, total: 3, rate: 2 / 3 });
    expect(report.failureConvergence).toMatchObject({
      episodeCount: 3, failFastMissed: 3, totalOvershoot: 6,
      maxAttemptsWithoutRecovery: 6,
      byFamily: { execution_sandbox: 3 }, coverage: { observed: 3, total: 3, status: "complete" }
    });
    expect(report.mutationDiscipline).toMatchObject({
      mutationRequests: 3, emptyCheckpoints: 3, coverage: { observed: 3, total: 3, status: "complete" }
    });
    expect(renderEvalReportMarkdown(report)).toContain("95% Wilson");
    expect(hasScoreKey(report)).toBe(false);
  });

  it("reports incomplete metric coverage instead of supplementing malformed V2 attempts with zeroes", () => {
    const complete = attemptV2({ repetition: 1, metrics: {
      failureConvergence: {
        episodeCount: 0, failFastEligibleEpisodes: 0, failFastTriggeredOnTime: 0, failFastLate: 0,
        failFastMissed: 0, recoverySucceeded: 0, recoveryBypassed: 0, recoveryFailed: 0,
        totalOvershoot: 0, maxAttemptsWithoutRecovery: 0, byCode: {}, byFamily: {}
      },
      mutationDiscipline: {
        mutationRequests: 0, failedMutationRequests: 0, writeContractFailures: 0,
        checkpointLimitFailures: 0, checkpointsCreated: 0, checkpointsSealed: 0,
        checkpointsRestored: 0, emptyCheckpoints: 0, openCheckpointsAtTerminal: 0,
        invalidCheckpointActions: 0, mutationFallbacksAfterInfrastructureFailure: 0,
        workspaceDeltaEvents: 0
      }
    } });
    const malformed = attemptV2({ repetition: 2, metrics: {
      failureConvergence: { failFastMissed: 99 }, mutationDiscipline: { mutationRequests: 99 }
    } });
    const report = buildEvalRunReport(runV2([complete, malformed], { repeat: 2 }));

    expect(report.failureConvergence).toMatchObject({
      failFastMissed: 0, coverage: { observed: 1, total: 2, status: "incomplete" }
    });
    expect(report.mutationDiscipline).toMatchObject({
      mutationRequests: 0, coverage: { observed: 1, total: 2, status: "incomplete" }
    });
  });

  it("renders migrated V1 fields as unavailable and rejects V1/V2 statistical comparison", () => {
    const legacy = buildEvalRunReport(run([attempt()], { repeat: 1 }));
    const modern = runV2([attemptV2()], { runId: "run-modern", repeat: 1 });

    expect(legacy).toMatchObject({
      schemaVersion: 2,
      sourceSchemaVersion: 1,
      validity: "unavailable",
      failureConvergence: "unavailable",
      mutationDiscipline: "unavailable"
    });
    expect(legacy.dimensions.delivery).toBe("unavailable");
    expect(compareEvalRuns(legacy, modern).compatibility.mismatches)
      .toContainEqual(expect.objectContaining({ field: "schemaVersion" }));
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

  it("reports paired median differences and accepts three non-inferior twenty-percent continuous pairs", () => {
    const baseline = runV2([1, 2, 3].map((repetition) => attemptV2({ repetition, durationMs: 1000 })));
    const candidate = runV2([1, 2, 3].map((repetition) => attemptV2({ repetition, durationMs: 800 })), {
      runId: "run-v2-candidate"
    });
    const comparison = compareEvalRuns(baseline, candidate);

    expect(comparison.comparable).toBe(true);
    expect(comparison.pairedMedianDifferences.durationMs).toEqual({
      pairs: 3, median: -200, min: -200, max: -200
    });
    expect(evaluateFrozenABGate(baseline, candidate, {
      kind: "continuous", metric: "durationMs"
    })).toMatchObject({
      passed: true,
      status: "pass",
      reasons: [],
      primary: { kind: "continuous", pairs: 3, medianImprovement: 0.2, requiredImprovement: 0.2 }
    });
  });

  it("enforces binary wins, zero losses, valid pairs, and product guardrails", () => {
    const baseline = runV2([1, 2, 3].map((repetition) => attemptV2({ repetition, passing: false })));
    const candidate = runV2([1, 2, 3].map((repetition) => attemptV2({ repetition })), {
      runId: "run-v2-candidate"
    });
    expect(evaluateFrozenABGate(baseline, candidate, { kind: "binary" })).toMatchObject({
      passed: true,
      primary: { wins: 3, losses: 0, requiredWins: 2 }
    });

    const guardedBaseline = runV2([1, 2, 3].map((repetition) => attemptV2({ repetition })));
    const regressedAttempts = [1, 2, 3].map((repetition) => attemptV2({ repetition }));
    regressedAttempts[0].dimensions.safety = {
      status: "fail", violations: [{ code: "workspace_changed" }]
    };
    const guardedCandidate = runV2(regressedAttempts, { runId: "run-guardrail-regression" });
    const rejected = evaluateFrozenABGate(guardedBaseline, guardedCandidate, { kind: "binary" });
    expect(rejected.passed).toBe(false);
    expect(rejected.reasons).toEqual(expect.arrayContaining(["guardrail_regression", "candidate_loss"]));

    const invalidAttempts = [1, 2, 3].map((repetition) => attemptV2({ repetition }));
    invalidAttempts[1] = attemptV2({ repetition: 2, validity: "invalid" });
    const invalidCandidate = runV2(invalidAttempts, { runId: "run-invalid-candidate" });
    expect(evaluateFrozenABGate(guardedBaseline, invalidCandidate, { kind: "binary" }).reasons)
      .toEqual(expect.arrayContaining(["incompatible_runs", "invalid_pair"]));
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
