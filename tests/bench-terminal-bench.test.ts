import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runTerminalBenchCli } from "../scripts/bench-terminal-bench.mjs";

interface RunnerLogOptions {
  stdoutPath?: string;
  stderrPath?: string;
  rawPath?: string;
}

async function writeRunnerLogs(options: RunnerLogOptions, result: { exitCode: number; stdout: string; stderr: string }) {
  if (options.stdoutPath) await writeFile(options.stdoutPath, result.stdout, "utf8");
  if (options.stderrPath) await writeFile(options.stderrPath, result.stderr, "utf8");
  if (options.rawPath) {
    await writeFile(
      options.rawPath,
      [`exit_code: ${result.exitCode}`, "stdout:", result.stdout, "stderr:", result.stderr, ""].join("\n"),
      "utf8"
    );
  }
}

async function writeAttemptArtifacts(configPath: string, attempt: number, passed: boolean) {
  const runDir = path.dirname(path.dirname(path.dirname(configPath)));
  const jobConfig = JSON.parse(await readFile(configPath, "utf8"));
  const runSlot = path.basename(path.dirname(configPath));
  const taskName = jobConfig.tasks?.[0]?.name ?? "terminal-bench/selected-task";
  const trialDir = path.join(jobConfig.jobs_dir, "job-1", `trial-${attempt}`);
  const taskDir = path.join(runDir, "tasks", runSlot);
  await mkdir(taskDir, { recursive: true });
  await writeFile(path.join(taskDir, "metadata.json"), `${JSON.stringify({
    task_id: taskName,
    run_slot: runSlot,
    source_logs_dir: path.join(trialDir, "agent")
  })}\n`, "utf8");
  await writeFile(
    path.join(taskDir, "summary.json"),
    `${JSON.stringify({ status: "completed", finish_reason: "assistant_stop" })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(taskDir, "verifier.log"),
    passed ? "verifier passed\n" : "verifier failed: connection refused\n",
    "utf8"
  );

  await mkdir(path.join(trialDir, "verifier"), { recursive: true });
  await writeFile(
    path.join(trialDir, "result.json"),
    `${JSON.stringify({
      trial_name: `trial-${attempt}`,
      task_name: taskName,
      verifier_result: { rewards: { reward: passed ? 1 : 0 } }
    })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(trialDir, "verifier", "ctrf.json"),
    `${JSON.stringify({
      results: {
        tests: passed
          ? [{ name: "case_basic", status: "passed" }]
          : [{ name: "case_basic", status: "failed", message: "connection refused" }]
      }
    })}\n`,
    "utf8"
  );
  await writeFile(path.join(path.dirname(trialDir), "result.json"), `${JSON.stringify({
    n_total_trials: 1,
    stats: { n_completed_trials: 1, n_errored_trials: 0, n_retries: 0 }
  })}\n`, "utf8");
}

function cleanDockerResources() {
  return {
    schemaVersion: 1,
    runId: "test",
    clean: true,
    removed: { containers: [], networks: [] },
    remaining: { containers: [], networks: [] },
    commands: []
  };
}

async function packageRuntimeFixture(fixtureDir: string) {
  const harborRuntimeDir = path.join(fixtureDir, "harbor-runtime");
  await mkdir(harborRuntimeDir, { recursive: true });
  await writeFile(path.join(harborRuntimeDir, "sigma_harbor_agent.py"), "VALUE = 1\n", "utf8");
  return { exitCode: 0, stdout: "", stderr: "", harborRuntimeDir };
}

describe("Terminal-Bench CLI verifier result handling", () => {
  it("reuses only an archive matching the frozen SHA-256", async () => {
    const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "sigma-bench-archive-"));
    const tarball = path.join(fixtureDir, "agent-cli-linux-x64.tgz");
    const previousTarball = process.env.AGENT_CLI_TARBALL;
    process.env.AGENT_CLI_TARBALL = tarball;
    await writeFile(tarball, "frozen-stub", "utf8");
    const sha = createHash("sha256").update("frozen-stub").digest("hex");
    let packageCalls = 0;

    const result = await runTerminalBenchCli([
      "--mode", "task", "--task-id", "selected-task", "--reuse-package",
      "--expected-archive-sha256", sha, "--run-label", "reuse-test"
    ], {
      resolveHarborCommand: () => ({ command: "harbor", source: "test", exists: true }),
      packageAgentCli: async () => {
        packageCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      packageHarborRuntime: async () => await packageRuntimeFixture(fixtureDir),
      cleanupHarborDockerResources: cleanDockerResources,
      runProcess: async (_command: string, args: string[], options: Record<string, string | undefined>) => {
        const response = { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "--version") response.stdout = "harbor 0.17.1";
        else if (args[0] === "run" && args[1] === "--help") response.stdout = "--config --yes --task-id";
        else if (args.some((arg) => arg.endsWith("probe-harbor-timeouts.py"))) {
          response.stdout = JSON.stringify({
            resolved_tasks: [{ name: "terminal-bench/selected-task" }],
            tasks: [{ task_name: "terminal-bench/selected-task", agent_timeout_sec: 60 }]
          });
        } else if (args[0] === "run" && args.includes("--config")) {
          await writeAttemptArtifacts(args[args.indexOf("--config") + 1], 1, true);
        }
        await writeRunnerLogs(options, response);
        return response;
      }
    });

    try {
      expect(packageCalls).toBe(0);
      expect(result.report.agent_cli_sha256).toBe(sha);
      expect(result.report.package_reused).toBe(true);
    } finally {
      await rm(result.runDir, { recursive: true, force: true });
      if (previousTarball === undefined) delete process.env.AGENT_CLI_TARBALL;
      else process.env.AGENT_CLI_TARBALL = previousTarball;
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("does not retry or pass verifier result details in task mode", async () => {
    const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "sigma-bench-archive-"));
    const tarball = path.join(fixtureDir, "agent-cli-linux-x64.tgz");
    const previousTarball = process.env.AGENT_CLI_TARBALL;
    process.env.AGENT_CLI_TARBALL = tarball;
    await writeFile(tarball, "stub", "utf8");
    let harborRuns = 0;

    const result = await runTerminalBenchCli(
      ["--mode", "task", "--task-id", "selected-task", "--provider", "deepseek", "--model", "retry-test-model"],
      {
        resolveHarborCommand: () => ({ command: "harbor", source: "test", exists: true }),
        packageAgentCli: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        packageHarborRuntime: async () => await packageRuntimeFixture(fixtureDir),
        cleanupHarborDockerResources: cleanDockerResources,
        runProcess: async (_command: string, args: string[], options: Record<string, string | undefined>) => {
          let response = { exitCode: 0, stdout: "", stderr: "" };
          if (args[0] === "--version") {
            response = { exitCode: 0, stdout: "harbor 0.17.0", stderr: "" };
          } else if (args[0] === "run" && args[1] === "--help") {
            response = { exitCode: 0, stdout: "Usage: harbor run --config PATH --yes --task-id TASK", stderr: "" };
          } else if (args.some((arg) => arg.endsWith("probe-harbor-timeouts.py"))) {
            response = {
              exitCode: 0,
              stdout: JSON.stringify({
                resolved_tasks: [{ name: "terminal-bench/selected-task" }],
                tasks: [{ task_name: "terminal-bench/selected-task", agent_timeout_sec: 60 }],
                max_agent_timeout_sec: 60
              }),
              stderr: ""
            };
          } else if (args[0] === "run" && args.includes("--config")) {
            harborRuns += 1;
            const configPath = args[args.indexOf("--config") + 1];
            await writeAttemptArtifacts(configPath, harborRuns, false);
            response = { exitCode: 0, stdout: `attempt ${harborRuns}`, stderr: "" };
          }
          await writeRunnerLogs(options, response);
          return response;
        }
      }
    );

    try {
      expect(result.exitCode).toBe(1);
      expect(result.report.status).toBe("failed");
      expect(result.report.score_mode).toBe("standard_benchmark");
      expect(harborRuns).toBe(1);
      const runConfig = JSON.parse(await readFile(path.join(result.runDir, "config.json"), "utf8"));
      const firstConfig = JSON.parse(await readFile(
        path.join(result.runDir, runConfig.resolved_job_config_path),
        "utf8"
      ));
      expect(Object.keys(firstConfig.agents[0].kwargs).some((key) => key.includes("feedback"))).toBe(false);
      expect(runConfig.resolved_job_config_paths).toHaveLength(1);
      expect(runConfig.run_slots).toHaveLength(1);
    } finally {
      await rm(result.runDir, { recursive: true, force: true });
      if (previousTarball === undefined) delete process.env.AGENT_CLI_TARBALL;
      else process.env.AGENT_CLI_TARBALL = previousTarball;
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("runs five frozen tasks as isolated source-free slots without sibling cancellation", async () => {
    const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "sigma-bench-slots-"));
    const tarball = path.join(fixtureDir, "agent-cli-linux-x64.tgz");
    const tasksFile = path.join(fixtureDir, "tasks.json");
    const previousTarball = process.env.AGENT_CLI_TARBALL;
    process.env.AGENT_CLI_TARBALL = tarball;
    await writeFile(tarball, "stub", "utf8");
    const names = Array.from({ length: 5 }, (_value, index) => `registry/task-${index + 1}`);
    await writeFile(tasksFile, `${JSON.stringify(names.map((name) => ({
      name,
      provenance_source: "frozen-selection"
    })))}\n`, "utf8");
    const harborCalls: Array<{ config: Record<string, unknown>; slot: string }> = [];
    let nextSlot = 0;

    const result = await runTerminalBenchCli([
      "--mode", "batch", "--tasks-file", tasksFile, "--concurrency", "5", "--run-label", "five-slots"
    ], {
      makeRunSlotId: () => `slot-${++nextSlot}`,
      resolveHarborCommand: () => ({ command: "harbor", source: "test", exists: true }),
      packageAgentCli: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      packageHarborRuntime: async () => await packageRuntimeFixture(fixtureDir),
      cleanupHarborDockerResources: cleanDockerResources,
      runProcess: async (_command: string, args: string[], options: RunnerLogOptions & {
        env: Record<string, string | undefined>;
      }) => {
        let response = { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "--version") response.stdout = "harbor 0.17.1";
        else if (args[0] === "run" && args[1] === "--help") response.stdout = "--config --yes";
        else if (args.some((arg) => arg.endsWith("probe-harbor-timeouts.py"))) {
          response.stdout = JSON.stringify({
            resolved_tasks: names.map((name) => ({ name })),
            tasks: names.map((name) => ({ task_name: name, agent_timeout_sec: 60 }))
          });
        } else if (args[0] === "run" && args.includes("--config")) {
          const configPath = args[args.indexOf("--config") + 1];
          const jobConfig = JSON.parse(await readFile(configPath, "utf8"));
          harborCalls.push({ config: jobConfig, slot: options.env.SIGMA_BENCH_RUN_SLOT });
          const passed = options.env.SIGMA_BENCH_RUN_SLOT !== "slot-3";
          await writeAttemptArtifacts(configPath, 1, passed);
          response = { exitCode: passed ? 0 : 1, stdout: "", stderr: passed ? "" : "isolated failure" };
        }
        await writeRunnerLogs(options, response);
        return response;
      }
    });

    try {
      expect(harborCalls).toHaveLength(5);
      expect(new Set(harborCalls.map((call) => call.slot))).toEqual(
        new Set(["slot-1", "slot-2", "slot-3", "slot-4", "slot-5"])
      );
      for (const call of harborCalls) {
        expect(call.config).toMatchObject({ n_concurrent_trials: 1 });
        expect(call.config.tasks).toHaveLength(1);
        expect(call.config.tasks[0]).not.toHaveProperty("source");
        expect(call.config.tasks[0]).not.toHaveProperty("provenance_source");
      }
      const runConfig = JSON.parse(await readFile(path.join(result.runDir, "config.json"), "utf8"));
      expect(runConfig.run_slots).toHaveLength(5);
      expect(runConfig.resolved_task_attestation_paths).toHaveLength(5);
      expect(result.report.trial_accounting).toMatchObject({ expected: 5, observed: 5 });
      expect(result.report.incomplete_reason).toBeNull();
      expect(result.report.tasks.every((task: { provenance_source?: string }) =>
        task.provenance_source === "frozen-selection")).toBe(true);
    } finally {
      await rm(result.runDir, { recursive: true, force: true });
      if (previousTarball === undefined) delete process.env.AGENT_CLI_TARBALL;
      else process.env.AGENT_CLI_TARBALL = previousTarball;
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
