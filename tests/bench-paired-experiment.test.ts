import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHarborArgs,
  buildHarborJobConfig,
  resolveRunOptions,
  runSlotIntegrityReasons,
  taskSelectionIdentitySha256
} from "../scripts/bench-common.mjs";
import {
  analyzePairedExperiment,
  bootstrapByTask,
  semanticToolCategory
} from "../scripts/bench-paired-analysis.mjs";
import {
  classifyBlockingCondition,
  runPairedExperiment,
  summarizePairedAttempt
} from "../scripts/bench-paired-experiment.mjs";
import {
  pairedExperimentPreregistration,
  pairedSha256,
  validatePairedExperiment
} from "../scripts/bench-paired-preregistration.mjs";
import { normalizedProxyEnv, packageCodexRuntime } from "../scripts/package-codex-runtime.mjs";

const revision = "a".repeat(40);

function draft(taskCount = 10, repetitions = 5) {
  return {
    experiment_id: "generic-paired-harness",
    arms: [
      {
        id: "reference",
        harness: "codex",
        runtime: {
          archive_path: "codex.tgz",
          archive_sha256: "b".repeat(64),
          version: "0.147.0",
          layout: "npm-linux-x64"
        }
      },
      {
        id: "comparison",
        harness: "sigma",
        runtime: {
          archive_path: "sigma.tgz",
          archive_sha256: "c".repeat(64),
          version: null,
          layout: "sigma-agent-cli"
        }
      }
    ],
    model: {
      provider: "provider-fixture",
      name: "model-fixture",
      reasoning_effort: "max"
    },
    task_catalog: {
      dataset: "fixture/dataset",
      revision,
      tasks: Array.from({ length: Math.max(taskCount, 12) }, (_unused, index) => ({
        path: `tasks/task-${String(index).padStart(2, "0")}`,
        git_url: "https://example.test/tasks.git",
        git_commit_id: revision,
        provenance_source: "frozen-fixture"
      }))
    },
    selection: {
      method: "sha256_rank_v1",
      seed: "precommitted-seed",
      sample_size: taskCount
    },
    controls: {
      benchmark_class: "standard",
      agent_profile: "standard",
      max_turns: 200,
      command_timeout_sec: 180,
      cleanup_grace_sec: 120,
      network_mode: "full",
      execution_mode: "sandboxed",
      write_scope: "workspace",
      managed_environment_mode: "disabled",
      harbor_topology: "main_only"
    },
    execution: {
      repetitions,
      concurrency: 4,
      retries: 0,
      ramp_task_counts: taskCount === 10 ? [1, 4, 10] : [taskCount]
    }
  };
}

function reportFor(manifest: ReturnType<typeof pairedExperimentPreregistration>, context: any, runDir: string) {
  const arm = context.arm;
  const task = manifest.selection.selected_tasks[context.pair.task_index];
  const selectionIdentity = taskSelectionIdentitySha256(task);
  return {
    exitCode: 0,
    runDir,
    report: {
      harness: arm.harness,
      provider: manifest.model.provider,
      model: manifest.model.name,
      reasoning_effort: manifest.model.reasoning_effort,
      dataset: manifest.task_catalog.dataset,
      runtime_archive_sha256: arm.runtime.archive_sha256,
      incomplete_reason: null,
      infra_status: "passed",
      trial_accounting: { expected: 1, observed: 1, missing: 0 },
      tasks: [{
        selection_identity_sha256: selectionIdentity,
        validity: "valid",
        verifier_outcome: context.pair.task_index % 2 === 0 ? "passed" : "failed",
        agent_outcome: "completed",
        failure_category: context.pair.task_index % 2 === 0 ? null : "verifier_failed",
        duration_ms: arm.id === "comparison" ? 80 : 100,
        input_tokens: arm.id === "comparison" ? 80 : 100,
        cache_read_tokens: 40,
        output_tokens: 10,
        reasoning_tokens: 5,
        commands_executed: arm.id === "comparison" ? 4 : 5,
        cost_usd: null,
        trace_path: null,
        trace_format: null
      }]
    }
  };
}

async function frozen(directory: string, value: ReturnType<typeof pairedExperimentPreregistration>) {
  const file = path.join(directory, "preregistration.json");
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(file, bytes, "utf8");
  return { file, sha256: pairedSha256(bytes) };
}

describe("paired Harness experiment", () => {
  it("derives a neutral sample, five repetitions, gradual ramp, and balanced arm order", () => {
    const value = pairedExperimentPreregistration(draft());
    expect(value).toMatchObject({
      kind: "PairedHarnessExperiment",
      selection: { method: "sha256_rank_v1", sample_size: 10 },
      execution: { repetitions: 5, concurrency: 4, retries: 0, expected_attempts: 100 },
      stop_loss: {
        score_independent: true,
        verifier_feedback_to_solver: false,
        retry_consumed_attempts: false
      }
    });
    expect(value.execution.stages.map((stage) => stage.pairs.length)).toEqual([1, 3, 6, 10, 10, 10, 10]);
    const orders = value.execution.stages.flatMap((stage) => stage.pairs.map((pair) => pair.arms[0]));
    expect(orders.filter((arm) => arm === "reference")).toHaveLength(25);
    expect(orders.filter((arm) => arm === "comparison")).toHaveLength(25);
    expect(validatePairedExperiment(value)).toEqual(value);
    expect(() => validatePairedExperiment({
      ...value,
      execution: { ...value.execution, expected_attempts: 99 }
    })).toThrow(/stale/iu);
  });

  it("selects independently of catalog order and prohibits retry controls", () => {
    const first = pairedExperimentPreregistration(draft());
    const shuffled = draft();
    shuffled.task_catalog.tasks.reverse();
    const second = pairedExperimentPreregistration(shuffled);
    expect(second.selection.selected_task_identity_sha256)
      .toBe(first.selection.selected_task_identity_sha256);
    const invalid = draft();
    invalid.execution.retries = 1;
    expect(() => pairedExperimentPreregistration(invalid)).toThrow(/retries=0/u);
  });

  it("builds Codex Harbor kwargs without Sigma-only controls", () => {
    const archive = path.resolve("codex.tgz");
    const digest = "d".repeat(64);
    const options = resolveRunOptions([
      "--mode", "task", "--task-id", "fixture-task",
      "--harness", "codex",
      "--provider", "provider-fixture",
      "--model", "model-fixture",
      "--reasoning-effort", "max",
      "--runtime-archive", archive,
      "--runtime-version", "0.147.0",
      "--runtime-layout", "npm-linux-x64",
      "--reuse-package",
      "--expected-archive-sha256", digest
    ], {});
    const agent = buildHarborJobConfig(options, "jobs").agents[0];
    expect(agent.name).toBe("codex_harbor_agent:PortableCodex");
    expect(agent.kwargs).toMatchObject({
      codex_cli_tarball: archive,
      codex_cli_sha256: digest,
      codex_cli_layout: "npm-linux-x64",
      version: "0.147.0",
      reasoning_effort: "max"
    });
    expect(agent.model_name).toBe("model-fixture");
    expect(agent.kwargs).not.toHaveProperty("model_name");
    expect(agent.kwargs).not.toHaveProperty("agent_profile");
    expect(agent.kwargs).not.toHaveProperty("provider");
  });

  it("keeps the Codex model in Harbor's standard field across config and CLI integrity checks", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-codex-controls-"));
    try {
      const archive = path.resolve("codex.tgz");
      const digest = "d".repeat(64);
      const options = resolveRunOptions([
        "--mode", "task", "--task-id", "fixture-task",
        "--harness", "codex",
        "--provider", "provider-fixture",
        "--model", "model-fixture",
        "--reasoning-effort", "max",
        "--runtime-archive", archive,
        "--runtime-version", "0.147.0",
        "--runtime-layout", "npm-linux-x64",
        "--reuse-package",
        "--expected-archive-sha256", digest
      ], {});
      const jobConfig = buildHarborJobConfig(options, "jobs");
      const configPath = path.join(directory, "resolved-job.config.json");
      const bytes = `${JSON.stringify(jobConfig, null, 2)}\n`;
      await writeFile(configPath, bytes, "utf8");
      const config = {
        mode: "task",
        harness: "codex",
        model: "model-fixture",
        reasoning_effort: "max",
        runtime_archive_sha256: digest,
        runtime_layout: "npm-linux-x64",
        runtime_version: "0.147.0",
        run_slots: [{
          run_slot: "slot-one",
          resolved_job_config_path: "resolved-job.config.json",
          job_config_sha256: createHash("sha256").update(bytes).digest("hex")
        }]
      };
      await expect(runSlotIntegrityReasons(directory, config)).resolves.toEqual([]);

      const args = buildHarborArgs({
        ...options,
        k: 1,
        capabilities: {
          agentFlag: "--agent",
          agentKwargStyle: "plain",
          taskLimitFlag: "-l",
          taskSelectionFlag: "--task"
        }
      });
      expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2))
        .toEqual(["--model", "model-fixture"]);
      expect(args.some((item) => item.includes("model_name"))).toBe(false);

      jobConfig.agents[0].model_name = "drifted-model";
      const driftedBytes = `${JSON.stringify(jobConfig, null, 2)}\n`;
      await writeFile(configPath, driftedBytes, "utf8");
      config.run_slots[0].job_config_sha256 = createHash("sha256").update(driftedBytes).digest("hex");
      await expect(runSlotIntegrityReasons(directory, config)).resolves.toEqual([
        "Harbor run slot slot-one agent control model_name does not match its frozen run."
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("consumes one ramp stage once and never retries its attempts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-paired-run-"));
    try {
      const manifest = pairedExperimentPreregistration(draft(2, 1), { baseDir: directory });
      const preregistration = await frozen(directory, manifest);
      const output = path.join(directory, "output");
      const calls: string[] = [];
      const result = await runPairedExperiment([
        "--preregistration-file", preregistration.file,
        "--expected-preregistration-sha256", preregistration.sha256,
        "--output", output,
        "--stage", "next"
      ], {
        assertFrozenArchives: async () => undefined,
        assertCredentials: async () => undefined,
        packageHarborRuntime: async () => ({ exitCode: 0, harborRuntimeDir: directory }),
        prefetchTasks: async () => undefined,
        runArm: async (_args: string[], context: any) => {
          await context.beforeHarborDispatch();
          calls.push(`${context.pair.task_index}:${context.arm.id}`);
          const runDir = path.join(directory, "runs", calls.at(-1)!.replace(":", "-"));
          await mkdir(runDir, { recursive: true });
          return reportFor(manifest, context, runDir);
        }
      });
      expect(result.status).toBe("complete");
      expect(calls).toHaveLength(4);
      await expect(runPairedExperiment([
        "--preregistration-file", preregistration.file,
        "--expected-preregistration-sha256", preregistration.sha256,
        "--output", output,
        "--stage", manifest.execution.stages[0].id
      ], {
        assertFrozenArchives: async () => undefined,
        assertCredentials: async () => undefined
      })).rejects.toThrow(/next unconsumed stage|already complete/iu);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs task-cache prefetch before consuming a stage", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-paired-prefetch-"));
    try {
      const manifest = pairedExperimentPreregistration(draft(2, 1), { baseDir: directory });
      const preregistration = await frozen(directory, manifest);
      const output = path.join(directory, "output");
      await expect(runPairedExperiment([
        "--preregistration-file", preregistration.file,
        "--expected-preregistration-sha256", preregistration.sha256,
        "--output", output,
        "--stage", "next"
      ], {
        assertFrozenArchives: async () => undefined,
        assertCredentials: async () => undefined,
        packageHarborRuntime: async () => ({ exitCode: 0, harborRuntimeDir: directory }),
        prefetchTasks: async () => { throw new Error("prefetch fixture failed"); }
      })).rejects.toThrow("prefetch fixture failed");
      await expect(readFile(
        path.join(output, "receipts", manifest.execution.stages[0].id, "stage.started.json"),
        "utf8"
      )).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops on neutral infrastructure failure but not ordinary verifier failure", () => {
    const base = {
      incomplete_reason: null,
      trial_accounting: { expected: 1, observed: 1, missing: 0 },
      notes: []
    };
    expect(classifyBlockingCondition(base, {
      validity: "valid", failure_category: "verifier_failed", last_error: "tests failed"
    })).toBeNull();
    expect(classifyBlockingCondition(base, {
      validity: "infra_failed", failure_category: "agent_setup_failed"
    })).toBe("infra_failed_attempt");
    expect(classifyBlockingCondition(base, {
      validity: "valid", failure_category: "api_error", last_error: "authentication failed"
    })).toBe("credential_or_provider_unavailable");
    expect(classifyBlockingCondition(base, {
      validity: "valid",
      failure_category: "agent_crashed",
      last_error: "Optional MCP worker quit with AuthRequired after the model had already started."
    })).toBeNull();
  });

  it("preserves an attested task identity when Harbor fails before producing a trial", () => {
    const manifest = pairedExperimentPreregistration(draft(2, 1));
    const stage = manifest.execution.stages[0];
    const pair = stage.pairs[0];
    const arm = manifest.arms.find((item) => item.id === pair.arms[0])!;
    const expectedIdentity = taskSelectionIdentitySha256(
      manifest.selection.selected_tasks[pair.task_index]
    );
    const summary = summarizePairedAttempt({
      manifest,
      stage,
      pair,
      arm,
      result: {
        runDir: "failed-run",
        report: {
          harness: arm.harness,
          provider: manifest.model.provider,
          model: manifest.model.name,
          reasoning_effort: manifest.model.reasoning_effort,
          dataset: manifest.task_catalog.dataset,
          runtime_archive_sha256: arm.runtime.archive_sha256,
          incomplete_reason: ["No Harbor trial result was produced."],
          trial_accounting: { expected: 1, observed: 0, missing: 1 },
          run_slots: [{ selection_identity_sha256: expectedIdentity }],
          tasks: [{ failure_category: "harbor_cli_error", verifier_outcome: "not_run" }]
        }
      }
    });
    expect(summary).toMatchObject({
      valid: false,
      passed: false,
      blocking_condition: "missing_or_incomplete_report",
      task_identity_evidence: "run_slot_attestation"
    });
  });

  it("packages an exact official platform archive and records content identity", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-codex-package-"));
    try {
      const output = path.join(directory, "codex.tgz");
      const result = await packageCodexRuntime({ version: "0.147.0", output }, {
        platform: "linux",
        run: async (_command: string, args: string[]) => {
          const destination = args[args.indexOf("--pack-destination") + 1];
          const filename = "openai-codex-0.147.0-linux-x64.tgz";
          await writeFile(path.join(destination, filename), "archive-bytes", "utf8");
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify([{
              id: "@openai/codex@0.147.0-linux-x64",
              version: "0.147.0-linux-x64",
              filename,
              integrity: "sha512-fixture",
              shasum: "fixture",
              files: [{
                path: "vendor/x86_64-unknown-linux-musl/bin/codex",
                mode: 493
              }]
            }])
          };
        }
      });
      expect(result.metadata).toMatchObject({
        version: "0.147.0",
        layout: "npm-linux-x64",
        sha256: createHash("sha256").update("archive-bytes").digest("hex")
      });
      await expect(readFile(output, "utf8")).resolves.toBe("archive-bytes");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("repairs malformed proxy schemes before invoking npm", async () => {
    expect(normalizedProxyEnv({
      http_proxy: "htpp://127.0.0.1:7890",
      HTTPS_PROXY: "https://proxy.example"
    })).toEqual({
      http_proxy: "http://127.0.0.1:7890",
      HTTPS_PROXY: "https://proxy.example"
    });
  });

  it("analyzes paired outcomes and efficiency from immutable receipts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-paired-analysis-"));
    try {
      const manifest = pairedExperimentPreregistration(draft(2, 1), { baseDir: directory });
      const preregistration = await frozen(directory, manifest);
      const output = path.join(directory, "output");
      const runResult = await runPairedExperiment([
        "--preregistration-file", preregistration.file,
        "--expected-preregistration-sha256", preregistration.sha256,
        "--output", output,
        "--stage", "next"
      ], {
        assertFrozenArchives: async () => undefined,
        assertCredentials: async () => undefined,
        packageHarborRuntime: async () => ({ exitCode: 0, harborRuntimeDir: directory }),
        prefetchTasks: async () => undefined,
        runArm: async (_args: string[], context: any) => {
          await context.beforeHarborDispatch();
          const runDir = path.join(directory, "analysis-runs", `${context.pair.task_index}-${context.arm.id}`);
          await mkdir(runDir, { recursive: true });
          return reportFor(manifest, context, runDir);
        }
      });
      expect(runResult.status).toBe("complete");
      const analysis = await analyzePairedExperiment({
        preregistrationFile: preregistration.file,
        expectedSha256: preregistration.sha256,
        experimentOutput: output,
        allowPartial: false
      });
      expect(analysis).toMatchObject({
        status: "complete",
        observed_attempts: 4,
        paired: { complete_pairs: 2 }
      });
      expect(analysis.arms.reference.pass_rate).toBe(0.5);
      expect(analysis.paired.efficiency.duration_ms.joint_success.median_ratio).toBe(0.8);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cluster-resamples tasks with replacement instead of cycling low PRNG bits", () => {
    const rows = Array.from({ length: 8 }, (_unused, task_index) => ({ task_index, value: task_index }));
    const interval = bootstrapByTask(rows, (row) => row.value, "bootstrap-fixture");
    expect(interval).toMatchObject({ samples: 4_000 });
    expect(interval!.low).toBeLessThan(interval!.high);
    expect(interval!.low).toBeLessThan(3.5);
    expect(interval!.high).toBeGreaterThan(3.5);
  });

  it("normalizes cross-harness tool aliases into semantic categories", () => {
    expect(semanticToolCategory("exec")).toBe("command");
    expect(semanticToolCategory("shell")).toBe("command");
    expect(semanticToolCategory("read")).toBe("inspect");
    expect(semanticToolCategory("grep")).toBe("inspect");
    expect(semanticToolCategory("apply_patch")).toBe("edit");
    expect(semanticToolCategory("update_plan")).toBe("plan");
    expect(semanticToolCategory("spawn_agent")).toBe("delegate");
    expect(semanticToolCategory("join_agent")).toBe("wait");
    expect(semanticToolCategory("custom-tool")).toBe("other:custom_tool");
  });
});
