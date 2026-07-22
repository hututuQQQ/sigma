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
  sigmaFormalRunPreregistrationV1,
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
  return sigmaFormalRunPreregistrationV1(draft(overrides));
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
      kind: "SigmaFormalRunPreregistrationV1",
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
    expect(() => sigmaFormalRunPreregistrationV1(missingModel)).toThrow(/field set/u);
    const missingConcurrency = draft();
    delete (missingConcurrency.execution as Record<string, unknown>).concurrency;
    expect(() => sigmaFormalRunPreregistrationV1(missingConcurrency)).toThrow(/field set/u);
  });

  it("rejects score thresholds, mutable task sources, and stale digests", () => {
    const value = manifest() as Record<string, unknown>;
    expect(() => validateFormalPreregistration({ ...value, minimum_passes: 2 }))
      .toThrow(/invalid field set/u);

    const mutable = draft();
    (mutable.task_selection as { tasks: Array<Record<string, unknown>> }).tasks[0]
      .git_commit_id = "d".repeat(40);
    expect(() => sigmaFormalRunPreregistrationV1(mutable)).toThrow(/pinned/u);

    const tampered = structuredClone(value) as Record<string, unknown>;
    (tampered.model as { name: string }).name = "different-model";
    expect(() => validateFormalPreregistration(tampered)).toThrow(/consumption_identity/u);

    const contradictoryTopology = draft();
    (contradictoryTopology.execution as Record<string, unknown>).harbor_topology = "managed_three_role";
    expect(() => sigmaFormalRunPreregistrationV1(contradictoryTopology))
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

  it("runs each frozen batch once and derives every CLI control from the manifest", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-formal-controller-"));
    const output = path.join(directory, "output");
    try {
      const frozen = await frozenManifest(directory);
      const invocations: string[][] = [];
      const runner = async (argv: string[]) => {
        invocations.push(argv);
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
        runBatch: async () => { throw new Error("simulated interruption"); }
      })).rejects.toThrow("simulated interruption");
      await expect(runFormalBenchmark([...args, "--resume"], {
        ...verificationDeps,
        runBatch: async () => { throw new Error("must not dispatch"); }
      })).rejects.toThrow(/retrying a consumed batch is prohibited/u);
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
        runBatch: async () => ({
          exitCode: 1,
          runDir: "incomplete-run",
          dockerCleanup: { clean: true },
          report: incomplete
        })
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
