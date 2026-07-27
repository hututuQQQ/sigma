import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateFormalReports,
  assertFormalArchive,
  runFormalBenchmark
} from "../scripts/bench-terminal-bench-formal.mjs";
import {
  assertFrozenBatchControls,
  canonicalJson,
  formalPreregistrationConsumptionIdentity,
  loadFormalPreregistration,
  sha256,
  sigmaFormalRunPreregistration,
  validateFormalPreregistration,
  writeFormalPreregistration
} from "../scripts/bench-terminal-bench-formal-preregistration.mjs";

const taskCommit = "a".repeat(40);
const sourceRevision = "c".repeat(40);
const archiveSha256 = "b".repeat(64);

function draft(overrides: Record<string, unknown> = {}) {
  return {
    formal_run_id: "generic-formal-run",
    source: { revision: sourceRevision, dirty: false, diff_sha256: null },
    archive_sha256: archiveSha256,
    model: { provider: "provider-fixture", name: "model-fixture" },
    task_selection: {
      dataset: "generic-conformance",
      terminal_bench_revision: taskCommit,
      tasks: ["one", "two", "three"].map((name) => ({
        path: `tasks/${name}`,
        git_url: "https://example.test/tasks.git",
        git_commit_id: taskCommit,
        provenance_source: "frozen-catalog"
      }))
    },
    solver_controls: {
      benchmark_class: "standard",
      agent_profile: "standard",
      max_turns: 73,
      command_timeout_sec: 41,
      cleanup_grace_sec: 17
    },
    execution: {
      network_mode: "full",
      execution_mode: "sandboxed",
      write_scope: "auto",
      managed_environment_mode: "disabled",
      harbor_topology: "main_only",
      concurrency: 2,
      attempts_per_task: 1,
      retries: 0,
      package_mode: "reuse",
      batches: [
        {
          id: "001",
          task_indexes: [0, 1],
          timeout_cohorts: [
            { id: "short", task_indexes: [0, 1], effective_solver_timeout_sec: 900 }
          ]
        },
        {
          id: "002",
          task_indexes: [2],
          timeout_cohorts: [
            { id: "long", task_indexes: [2], effective_solver_timeout_sec: 1200 }
          ]
        }
      ]
    },
    ...overrides
  };
}

function manifest(overrides: Record<string, unknown> = {}) {
  return sigmaFormalRunPreregistration(draft(overrides));
}

function report(taskCount: number, passed: number, blocker = false) {
  const tasks = Array.from({ length: taskCount }, (_unused, index) => {
    const didPass = index < passed;
    const structuredBlocker = !didPass && blocker;
    return {
      task_id: `task-${index}`,
      status: didPass ? "passed" : "failed",
      validity: "valid",
      verifier_outcome: didPass ? "passed" : structuredBlocker ? "not_run" : "failed",
      failure_category: didPass ? null : structuredBlocker ? "structured_blocker" : "verifier_failed",
      input_tokens: 10,
      cache_tokens: 8,
      output_tokens: 2,
      cost_usd: 0.01
    };
  });
  return {
    agent_profile: "standard",
    evaluation_lane: "solving",
    incomplete_reason: null,
    trial_accounting: {
      expected: taskCount,
      observed: taskCount,
      scored: blocker ? passed : taskCount,
      errored: 0,
      missing: 0,
      meanReward: passed / Math.max(1, blocker ? passed : taskCount)
    },
    counts: {
      passed,
      failed: blocker ? 0 : taskCount - passed,
      structured_blocker: blocker ? taskCount - passed : 0,
      infra_failed: 0
    },
    usage: {
      input_tokens: taskCount * 10,
      cache_tokens: taskCount * 8,
      output_tokens: taskCount * 2
    },
    cost_usd: taskCount * 0.01,
    tasks
  };
}

function reportWithValidAgentTimeout(taskCount: number, passed: number) {
  const value = report(taskCount, passed);
  const timedOut = taskCount - passed;
  for (let index = passed; index < taskCount; index += 1) {
    value.tasks[index] = {
      ...value.tasks[index],
      verifier_outcome: "not_run",
      failure_category: "agent_timeout"
    };
  }
  value.trial_accounting.scored = passed;
  value.trial_accounting.errored = timedOut;
  value.trial_accounting.meanReward = passed > 0 ? 1 : null;
  value.counts.failed = 0;
  (value.counts as Record<string, number>).timeout = timedOut;
  return value;
}

async function frozenManifest(directory: string, value = manifest()) {
  const file = path.join(directory, "preregistration.json");
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(file, bytes, "utf8");
  return { file, sha256: sha256(bytes), value };
}

const verificationDeps = {
  assertFormalSource: async () => undefined,
  assertFormalArchive: async () => undefined
};

describe("formal benchmark preregistration", () => {
  it("derives every digest without supplying policy defaults", () => {
    const value = manifest();
    expect(value).toMatchObject({
      kind: "SigmaFormalRunPreregistration",
      model: { provider: "provider-fixture", name: "model-fixture" },
      solver_controls: { max_turns: 73, command_timeout_sec: 41, cleanup_grace_sec: 17 },
      execution: { concurrency: 2, attempts_per_task: 1, retries: 0 }
    });
    expect(value.task_selection.task_selection_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(value.consumption_identity_sha256).toBe(
      formalPreregistrationConsumptionIdentity(value)
    );
    expect(canonicalJson({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');

    const missingModel = draft();
    delete (missingModel as Record<string, unknown>).model;
    expect(() => sigmaFormalRunPreregistration(missingModel)).toThrow(/field set/u);
    const missingConcurrency = draft();
    delete (missingConcurrency.execution as Record<string, unknown>).concurrency;
    expect(() => sigmaFormalRunPreregistration(missingConcurrency)).toThrow(/field set/u);
    const excessiveCommandTimeout = draft();
    (excessiveCommandTimeout.solver_controls as Record<string, unknown>).command_timeout_sec = 601;
    expect(() => sigmaFormalRunPreregistration(excessiveCommandTimeout)).toThrow(/at most 600/u);
  });

  it("rejects score thresholds, mutable task sources, and stale digests", () => {
    const value = manifest() as Record<string, unknown>;
    expect(() => validateFormalPreregistration({ ...value, minimum_passes: 2 }))
      .toThrow(/invalid field set/u);

    const mutable = draft();
    (mutable.task_selection as { tasks: Array<Record<string, unknown>> }).tasks[0]
      .git_commit_id = "d".repeat(40);
    expect(() => sigmaFormalRunPreregistration(mutable)).toThrow(/pinned/u);

    const tampered = structuredClone(value) as Record<string, unknown>;
    (tampered.model as { name: string }).name = "different-model";
    expect(() => validateFormalPreregistration(tampered)).toThrow(/consumption_identity/u);

    const contradictoryTopology = draft();
    (contradictoryTopology.execution as Record<string, unknown>).harbor_topology = "managed_three_role";
    expect(() => sigmaFormalRunPreregistration(contradictoryTopology))
      .toThrow(/requires managed_environment_mode=required/u);
  });

  it("requires the active SHA-bound file instead of a passive digest", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-formal-prereg-"));
    try {
      const frozen = await frozenManifest(directory);
      const loaded = await loadFormalPreregistration(frozen.file, frozen.sha256);
      expect(loaded.manifest.formal_run_id).toBe("generic-formal-run");
      await expect(loadFormalPreregistration(frozen.file, "f".repeat(64)))
        .rejects.toThrow(/expected SHA-256/u);
      await expect(runFormalBenchmark([
        "--preregistration-sha256", frozen.sha256,
        "--batch", "001"
      ], verificationDeps)).rejects.toThrow(/Unsupported formal runner arguments|preregistration-file/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes the explicit draft once without adding hidden controls", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-formal-draft-"));
    const draftPath = path.join(directory, "draft.json");
    const outputPath = path.join(directory, "manifest.json");
    try {
      await writeFile(draftPath, `${JSON.stringify(draft(), null, 2)}\n`, "utf8");
      const written = await writeFormalPreregistration(draftPath, outputPath);
      expect(written.manifest.model).toEqual({
        provider: "provider-fixture", name: "model-fixture"
      });
      expect(sha256(await readFile(outputPath))).toBe(written.sha256);
      await expect(writeFormalPreregistration(draftPath, outputPath))
        .rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("binds resolved task, network, timeout, and runner controls before launch", () => {
    const value = manifest();
    const batch = value.execution.batches[0];
    const tasks = batch.task_indexes.map((index: number) => value.task_selection.tasks[index]);
    const options = {
      dataset: "generic-conformance",
      provider: "provider-fixture",
      model: "model-fixture",
      benchmarkClass: "standard",
      agentProfile: "standard",
      maxTurns: 73,
      commandTimeoutSec: 41,
      agentTimeoutGraceSec: 17,
      networkMode: "full",
      executionMode: "sandboxed",
      writeScope: "auto",
      managedEnvironmentMode: "disabled",
      harborTopology: "main_only",
      nConcurrentTrials: 2,
      attemptsPerTask: 1,
      retries: 0
    };
    const slots = tasks.map((task: Record<string, unknown>) => ({
      task,
      resolvedTask: task,
      taskProbe: { tasks: [{ network_mode: "public" }] },
      timeoutPlan: { agent_wall_time_sec: 900 },
      jobConfig: {
        agents: [{ kwargs: { max_turns: 73, command_timeout_sec: 41 } }]
      },
      jobConfigSha256: "e".repeat(64)
    }));
    expect(() => assertFrozenBatchControls(value, batch, { options, slots })).not.toThrow();
    expect(() => assertFrozenBatchControls(value, batch, {
      options,
      slots: [{ ...slots[0], timeoutPlan: { agent_wall_time_sec: 899 } }, slots[1]]
    })).toThrow(/timeout metadata/u);
    expect(() => assertFrozenBatchControls(value, batch, {
      options,
      slots: [{ ...slots[0], taskProbe: { tasks: [{ network_mode: "no-network" }] } }, slots[1]]
    })).toThrow(/network metadata/u);
    expect(() => assertFrozenBatchControls(value, batch, {
      options,
      slots: [{ ...slots[0], resolvedTask: null }, slots[1]]
    })).toThrow(/resolved task identity/u);
    expect(() => assertFrozenBatchControls(value, batch, {
      options,
      slots: [{ ...slots[0], jobConfigSha256: null }, slots[1]]
    })).toThrow(/JobConfig digest/u);
    expect(() => assertFrozenBatchControls(value, batch, {
      options,
      slots: [{
        ...slots[0],
        jobConfig: { agents: [{ kwargs: { max_turns: 72, command_timeout_sec: 41 } }] }
      }, slots[1]]
    })).toThrow(/agent controls/u);
  });
});

describe("formal benchmark controller", () => {
  it("reports factual completion and keeps structured blockers distinct without a score gate", () => {
    const value = manifest();
    const aggregate = aggregateFormalReports(value, [
      {
        batch: "001",
        report: report(2, 1, true),
        docker_cleanup: { clean: true }
      },
      {
        batch: "002",
        report: report(1, 1),
        docker_cleanup: { clean: true }
      }
    ]);
    expect(aggregate).toMatchObject({
      status: "complete",
      trial_accounting: { expected: 3, observed: 3, scored: 2 },
      counts: { passed: 2, structured_blocker: 1 },
      failure_categories: { structured_blocker: 1 },
      lane_metrics: { verifier_reached: 2, verifier_passed: 2 }
    });
    expect(aggregate).not.toHaveProperty("acceptance");
    expect(aggregate).not.toHaveProperty("minimum_passes");
  });

  it("treats fully observed valid agent timeouts as completed outcomes", () => {
    const value = manifest();
    const aggregate = aggregateFormalReports(value, [
      {
        batch: "001",
        report: reportWithValidAgentTimeout(2, 1),
        docker_cleanup: { clean: true }
      },
      {
        batch: "002",
        report: report(1, 1),
        docker_cleanup: { clean: true }
      }
    ]);
    expect(aggregate).toMatchObject({
      status: "complete",
      trial_accounting: { expected: 3, observed: 3, scored: 2, errored: 1, missing: 0 },
      counts: { passed: 2, timeout: 1 },
      failure_categories: { agent_timeout: 1 }
    });
  });

  it("runs each frozen batch once and derives every CLI control from the manifest", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-formal-controller-"));
    const output = path.join(directory, "output");
    try {
      const frozen = await frozenManifest(directory);
      const invocations: string[][] = [];
      const runner = async (argv: string[], runnerDeps: { beforeHarborDispatch: () => Promise<void> }) => {
        invocations.push(argv);
        await runnerDeps.beforeHarborDispatch();
        const tasksPath = argv[argv.indexOf("--tasks-file") + 1];
        const tasks = JSON.parse(await readFile(tasksPath, "utf8"));
        return {
          exitCode: tasks.length === 2 ? 1 : 0,
          runDir: `run-${invocations.length}`,
          dockerCleanup: { clean: true },
          report: report(tasks.length, tasks.length - (tasks.length === 2 ? 1 : 0))
        };
      };
      const first = await runFormalBenchmark([
        "--preregistration-file", frozen.file,
        "--expected-preregistration-sha256", frozen.sha256,
        "--output", output,
        "--batch", "001"
      ], { ...verificationDeps, runTerminalBenchCli: runner });
      const second = await runFormalBenchmark([
        "--preregistration-file", frozen.file,
        "--expected-preregistration-sha256", frozen.sha256,
        "--output", output,
        "--batch", "002",
        "--resume"
      ], { ...verificationDeps, runTerminalBenchCli: runner });

      expect(first.exitCode).toBe(0);
      expect(first.report.status).toBe("running");
      expect(second.exitCode).toBe(0);
      expect(second.report).toMatchObject({
        status: "complete",
        counts: { passed: 2, failed: 1 },
        trial_accounting: { expected: 3, observed: 3 }
      });
      expect(invocations).toHaveLength(2);
      expect(invocations[0]).toEqual(expect.arrayContaining([
        "--dataset", "generic-conformance",
        "--provider", "provider-fixture",
        "--model", "model-fixture",
        "--max-turns", "73",
        "--command-timeout-sec", "41",
        "--agent-timeout-grace-sec", "17",
        "--concurrency", "2",
        "--attempts", "1",
        "--retries", "0",
        "--network", "full",
        "--execution-mode", "sandboxed",
        "--managed-environment-mode", "disabled",
        "--harbor-topology", "main_only"
      ]));
      expect(invocations.flat()).not.toContain("minimum-passes");
      expect(JSON.parse(await readFile(path.join(output, "state.json"), "utf8")))
        .toMatchObject({
          status: "complete",
          preregistration_sha256: frozen.sha256,
          completed_batches: ["001", "002"]
        });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("makes a started marker an irreversible no-retry boundary", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-formal-started-"));
    const output = path.join(directory, "output");
    try {
      const frozen = await frozenManifest(directory);
      const args = [
        "--preregistration-file", frozen.file,
        "--expected-preregistration-sha256", frozen.sha256,
        "--output", output,
        "--batch", "001"
      ];
      await expect(runFormalBenchmark(args, {
        ...verificationDeps,
        runBatch: async (_manifest, _batch, _options, deps) => {
          await deps.beforeHarborDispatch();
          throw new Error("simulated interruption");
        }
      })).rejects.toThrow("simulated interruption");
      await expect(runFormalBenchmark([...args, "--resume"], {
        ...verificationDeps,
        runBatch: async () => { throw new Error("must not dispatch"); }
      })).rejects.toThrow(/retrying a consumed batch is prohibited/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not consume a batch that fails before Harbor dispatch", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-formal-preflight-"));
    const output = path.join(directory, "output");
    try {
      const frozen = await frozenManifest(directory);
      const args = [
        "--preregistration-file", frozen.file,
        "--expected-preregistration-sha256", frozen.sha256,
        "--output", output,
        "--batch", "001"
      ];
      await expect(runFormalBenchmark(args, {
        ...verificationDeps,
        runBatch: async () => { throw new Error("preflight failed"); }
      })).rejects.toThrow("preflight failed");
      await expect(readFile(path.join(output, "batch-001.started.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });

      const result = await runFormalBenchmark(args, {
        ...verificationDeps,
        runBatch: async (_manifest, _batch, _options, deps) => {
          await deps.beforeHarborDispatch();
          return {
            exitCode: 0,
            runDir: "recovered-run",
            dockerCleanup: { clean: true },
            report: report(2, 2)
          };
        }
      });
      expect(result.report.status).toBe("running");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails incomplete infrastructure accounting instead of treating it as a score", () => {
    const value = manifest();
    const incomplete = report(2, 1);
    incomplete.incomplete_reason = "missing Harbor result" as unknown as null;
    const aggregate = aggregateFormalReports(value, [
      { batch: "001", report: incomplete, docker_cleanup: { clean: false } },
      { batch: "002", report: report(1, 1), docker_cleanup: { clean: true } }
    ]);
    expect(aggregate.status).toBe("incomplete");
  });

  it("does not accept an infrastructure-invalid task even when accounting has no errors", () => {
    const value = manifest();
    const invalid = report(2, 1);
    invalid.tasks[1] = {
      ...invalid.tasks[1],
      status: "infra_failed",
      validity: "infra_failed",
      verifier_outcome: "infra_failed",
      failure_category: "verifier_setup_failed"
    };
    const aggregate = aggregateFormalReports(value, [
      { batch: "001", report: invalid, docker_cleanup: { clean: true } },
      { batch: "002", report: report(1, 1), docker_cleanup: { clean: true } }
    ]);
    expect(aggregate.status).toBe("incomplete");
  });

  it("does not continue after a completed batch has infrastructure gaps", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-formal-incomplete-prefix-"));
    const output = path.join(directory, "output");
    try {
      const frozen = await frozenManifest(directory);
      const incomplete = report(2, 1);
      incomplete.incomplete_reason = "missing structured result" as unknown as null;
      const first = await runFormalBenchmark([
        "--preregistration-file", frozen.file,
        "--expected-preregistration-sha256", frozen.sha256,
        "--output", output,
        "--batch", "001"
      ], {
        ...verificationDeps,
        runBatch: async (_manifest, _batch, _options, deps) => {
          await deps.beforeHarborDispatch();
          return {
            exitCode: 1,
            runDir: "incomplete-run",
            dockerCleanup: { clean: true },
            report: incomplete
          };
        }
      });
      expect(first.exitCode).toBe(1);
      await expect(runFormalBenchmark([
        "--preregistration-file", frozen.file,
        "--expected-preregistration-sha256", frozen.sha256,
        "--output", output,
        "--batch", "002",
        "--resume"
      ], {
        ...verificationDeps,
        runBatch: async () => { throw new Error("must not dispatch"); }
      })).rejects.toThrow(/infrastructure gaps/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("continues only the unconsumed suffix after a SHA-bound neutral infrastructure recovery", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-formal-infra-recovery-"));
    const output = path.join(directory, "output");
    try {
      const frozen = await frozenManifest(directory);
      const invalid = report(2, 1);
      invalid.tasks[1] = {
        ...invalid.tasks[1],
        status: "infra_failed",
        validity: "infra_failed",
        verifier_outcome: "infra_failed",
        failure_category: "verifier_setup_failed"
      };
      invalid.counts.failed = 0;
      invalid.counts.infra_failed = 1;
      const dispatched: string[] = [];
      await runFormalBenchmark([
        "--preregistration-file", frozen.file,
        "--expected-preregistration-sha256", frozen.sha256,
        "--output", output,
        "--batch", "001"
      ], {
        ...verificationDeps,
        runBatch: async (_manifest, batch, _options, deps) => {
          dispatched.push(batch.id);
          await deps.beforeHarborDispatch();
          return {
            exitCode: 1,
            runDir: "infra-invalid-run",
            dockerCleanup: { clean: true },
            report: invalid
          };
        }
      });

      const completedPath = path.join(output, "batch-001.completed.json");
      const recovery = {
        schemaVersion: 1,
        kind: "SigmaFormalInfrastructureRecoveryReceipt",
        formal_run_id: frozen.value.formal_run_id,
        consumption_identity_sha256: frozen.value.consumption_identity_sha256,
        preregistration_sha256: frozen.sha256,
        decision: "continue_unconsumed_suffix",
        rerun_consumed_tasks: false,
        verifier_feedback_to_agent: false,
        recoveries: [
          {
            batch: "001",
            completed_batch_sha256: sha256(await readFile(completedPath)),
            repair_scope: "neutral_infrastructure",
            recovered_at: "2026-01-02T03:04:05.000Z",
            recovery_checks: [
              {
                kind: "generic-network-probe",
                status: "passed",
                observed_at: "2026-01-02T03:03:05.000Z"
              }
            ]
          }
        ]
      };
      const recoveryPath = path.join(directory, "infrastructure-recovery.json");
      const recoveryBytes = `${JSON.stringify(recovery, null, 2)}\n`;
      await writeFile(recoveryPath, recoveryBytes, "utf8");
      const recoverySha256 = sha256(recoveryBytes);

      await expect(runFormalBenchmark([
        "--preregistration-file", frozen.file,
        "--expected-preregistration-sha256", frozen.sha256,
        "--output", output,
        "--batch", "002",
        "--resume",
        "--infrastructure-recovery-file", recoveryPath,
        "--expected-infrastructure-recovery-sha256", "f".repeat(64)
      ], {
        ...verificationDeps,
        runBatch: async () => { throw new Error("must not dispatch"); }
      })).rejects.toThrow(/does not match/u);

      const second = await runFormalBenchmark([
        "--preregistration-file", frozen.file,
        "--expected-preregistration-sha256", frozen.sha256,
        "--output", output,
        "--batch", "002",
        "--resume",
        "--infrastructure-recovery-file", recoveryPath,
        "--expected-infrastructure-recovery-sha256", recoverySha256
      ], {
        ...verificationDeps,
        runBatch: async (_manifest, batch, _options, deps) => {
          dispatched.push(batch.id);
          await deps.beforeHarborDispatch();
          return {
            exitCode: 0,
            runDir: "following-run",
            dockerCleanup: { clean: true },
            report: report(1, 1)
          };
        }
      });

      expect(dispatched).toEqual(["001", "002"]);
      expect(second.report).toMatchObject({
        status: "incomplete",
        batches: { expected: 2, completed: 2 },
        trial_accounting: { expected: 3, observed: 3, missing: 0 },
        counts: { passed: 2, infra_failed: 1 }
      });
      await expect(readFile(
        path.join(output, `infrastructure-recovery-${recoverySha256}.json`),
        "utf8"
      )).resolves.toContain("SigmaFormalInfrastructureRecoveryReceipt");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("continues after a completed batch contains a valid agent timeout", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-formal-valid-timeout-"));
    const output = path.join(directory, "output");
    try {
      const frozen = await frozenManifest(directory);
      const first = await runFormalBenchmark([
        "--preregistration-file", frozen.file,
        "--expected-preregistration-sha256", frozen.sha256,
        "--output", output,
        "--batch", "001"
      ], {
        ...verificationDeps,
        runBatch: async (_manifest, _batch, _options, deps) => {
          await deps.beforeHarborDispatch();
          return {
            exitCode: 1,
            runDir: "valid-timeout-run",
            dockerCleanup: { clean: true },
            report: reportWithValidAgentTimeout(2, 1)
          };
        }
      });
      expect(first.report.status).toBe("running");

      const second = await runFormalBenchmark([
        "--preregistration-file", frozen.file,
        "--expected-preregistration-sha256", frozen.sha256,
        "--output", output,
        "--batch", "002",
        "--resume"
      ], {
        ...verificationDeps,
        runBatch: async (_manifest, _batch, _options, deps) => {
          await deps.beforeHarborDispatch();
          return {
            exitCode: 0,
            runDir: "following-run",
            dockerCleanup: { clean: true },
            report: report(1, 1)
          };
        }
      });
      expect(second.report).toMatchObject({
        status: "complete",
        trial_accounting: { expected: 3, observed: 3, errored: 1, missing: 0 }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("checks the frozen archive bytes before creating a run marker", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-formal-archive-"));
    const archive = path.join(directory, "agent.tgz");
    try {
      await writeFile(archive, "archive-bytes", "utf8");
      await expect(assertFormalArchive(sha256("archive-bytes"), archive)).resolves.toBe(archive);
      await expect(assertFormalArchive("0".repeat(64), archive)).rejects.toThrow(/does not match/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
