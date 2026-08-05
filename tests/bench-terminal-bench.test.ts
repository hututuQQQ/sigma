import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  boundedBenchmarkRunId,
  portableHarborJobsDir,
  runTerminalBenchCli,
  terminalBenchHelpText
} from "../scripts/bench-terminal-bench.mjs";
import { runProcess } from "../scripts/bench-common.mjs";

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
  await writeFile(path.join(harborRuntimeDir, "verifier_gate_plugin.py"), "VALUE = 1\n", "utf8");
  return { exitCode: 0, stdout: "", stderr: "", harborRuntimeDir };
}

async function removeRunArtifacts(runDir: string) {
  const config = JSON.parse(await readFile(path.join(runDir, "config.json"), "utf8"));
  const jobsDir = typeof config.harbor_jobs_dir === "string" ? path.resolve(config.harbor_jobs_dir) : null;
  if (jobsDir && jobsDir !== path.join(runDir, "harbor-jobs")) {
    await rm(jobsDir, { recursive: true, force: true });
  }
  await rm(runDir, { recursive: true, force: true });
}

describe("Terminal-Bench CLI verifier result handling", () => {
  it("prints help without packaging or creating a benchmark run", async () => {
    let output = "";
    let packaged = false;
    const result = await runTerminalBenchCli(["--help"], {
      writeOutput(text: string) { output += text; },
      packageAgentCli: async () => {
        packaged = true;
        throw new Error("help must not package");
      }
    });
    expect(result).toEqual({ exitCode: 0, help: true });
    expect(output).toBe(terminalBenchHelpText);
    expect(packaged).toBe(false);
  });

  it("keeps Windows Harbor workspaces and labeled run identifiers within a portable path budget", () => {
    const runId = boundedBenchmarkRunId(
      "20260723-120000-deepseek-deepseek-v4-pro",
      "formal-a-deliberately-long-preregistered-evaluation-identifier"
    );
    const jobsDir = portableHarborJobsDir(
      path.join("D:\\very-long-worktree", runId),
      "win32",
      "C:\\t"
    );
    expect(runId.length).toBeLessThanOrEqual(72);
    expect(jobsDir).toMatch(/^C:\\t\\sigma-harbor\\[a-f0-9]{24}$/u);
    expect(jobsDir).not.toContain(runId);
  });

  it.runIf(process.platform === "win32")(
    "runs Windows command scripts with spaces without generic shell argument concatenation",
    async () => {
      const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "sigma-bench-command-"));
      const scriptDir = path.join(fixtureDir, "with space");
      const scriptPath = path.join(scriptDir, "probe command.cmd");
      await mkdir(scriptDir, { recursive: true });
      await writeFile(
        scriptPath,
        "@echo off\r\nif \"%~1\"==\"--stdio\" (echo command-ok& exit /b 0)\r\nexit /b 7\r\n",
        "utf8"
      );

      try {
        const moduleUrl = new URL("../scripts/bench-common.mjs", import.meta.url).href;
        const probe = await runProcess(process.execPath, [
          "--throw-deprecation",
          "--input-type=module",
          "--eval",
          [
            `import { runProcess } from ${JSON.stringify(moduleUrl)};`,
            `const result = await runProcess(${JSON.stringify(scriptPath)}, ["--stdio"]);`,
            "process.stdout.write(result.stdout);",
            "process.stderr.write(result.stderr);",
            "process.exitCode = result.exitCode;"
          ].join("\n")
        ]);
        expect(probe.exitCode).toBe(0);
        expect(probe.stderr).toBe("");
        expect(probe.stdout.trim()).toBe("command-ok");
      } finally {
        await rm(fixtureDir, { recursive: true, force: true });
      }
    }
  );

  it("reuses only an archive matching the frozen SHA-256", async () => {
    const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "sigma-bench-archive-"));
    const tarball = path.join(fixtureDir, "agent-cli-linux-x64.tgz");
    const preflightFile = path.join(fixtureDir, "bootstrap-preflight.json");
    const previousTarball = process.env.AGENT_CLI_TARBALL;
    process.env.AGENT_CLI_TARBALL = tarball;
    await writeFile(tarball, "frozen-stub", "utf8");
    const sha = createHash("sha256").update("frozen-stub").digest("hex");
    const preflightBytes = `${JSON.stringify({
      schemaVersion: 1,
      command: "neutral-preflight",
      args: ["--check"],
      timeout_sec: 30
    })}\n`;
    await writeFile(preflightFile, preflightBytes, "utf8");
    const preflightSha = createHash("sha256").update(preflightBytes).digest("hex");
    let packageCalls = 0;
    const commands: string[] = [];

    const result = await runTerminalBenchCli([
      "--mode", "task", "--task-id", "selected-task", "--reuse-package",
      "--expected-archive-sha256", sha, "--run-label", "reuse-test",
      "--verifier-proxy-mode", "auto",
      "--bootstrap-preflight-file", preflightFile,
      "--expected-bootstrap-preflight-sha256", preflightSha
    ], {
      discoverDockerProxyOrigin: () => "http://http.docker.internal:3128",
      resolveHarborCommand: () => ({ command: "harbor", source: "test", exists: true }),
      packageAgentCli: async () => {
        packageCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      packageHarborRuntime: async () => await packageRuntimeFixture(fixtureDir),
      cleanupHarborDockerResources: cleanDockerResources,
      runProcess: async (command: string, args: string[], options: Record<string, string | undefined>) => {
        commands.push(command === "harbor" && args[0] === "run" && args.includes("--config")
          ? "harbor-dispatch" : command);
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
      expect(commands.indexOf("neutral-preflight")).toBeGreaterThanOrEqual(0);
      expect(commands.indexOf("neutral-preflight")).toBeLessThan(commands.indexOf("harbor-dispatch"));
      expect(result.report.bootstrap_preflight).toMatchObject({
        status: "passed",
        file_sha256: preflightSha,
        exit_code: 0
      });
      expect(result.report.verifier_proxy).toMatchObject({
        mode: "auto",
        origin: "http://http.docker.internal:3128",
        source: "docker_info.HTTPProxy"
      });
    } finally {
      await removeRunArtifacts(result.runDir);
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
      [
        "--mode", "task", "--task-id", "selected-task",
        "--provider", "deepseek", "--model", "retry-test-model",
        "--reasoning-effort", "max"
      ],
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
      expect(result.report.reasoning_effort).toBe("max");
      expect(harborRuns).toBe(1);
      const runConfig = JSON.parse(await readFile(path.join(result.runDir, "config.json"), "utf8"));
      const firstConfig = JSON.parse(await readFile(
        path.join(result.runDir, runConfig.resolved_job_config_path),
        "utf8"
      ));
      expect(Object.keys(firstConfig.agents[0].kwargs).some((key) => key.includes("feedback"))).toBe(false);
      expect(firstConfig.agents[0].kwargs.reasoning_effort).toBe("max");
      expect(runConfig.resolved_job_config_paths).toHaveLength(1);
      expect(runConfig.run_slots).toHaveLength(1);
    } finally {
      await removeRunArtifacts(result.runDir);
      if (previousTarball === undefined) delete process.env.AGENT_CLI_TARBALL;
      else process.env.AGENT_CLI_TARBALL = previousTarball;
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("runs four frozen tasks as isolated source-free slots with an independent verifier gate", async () => {
    const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "sigma-bench-slots-"));
    const tarball = path.join(fixtureDir, "agent-cli-linux-x64.tgz");
    const tasksFile = path.join(fixtureDir, "tasks.json");
    const previousTarball = process.env.AGENT_CLI_TARBALL;
    process.env.AGENT_CLI_TARBALL = tarball;
    await writeFile(tarball, "stub", "utf8");
    const names = Array.from({ length: 4 }, (_value, index) => `registry/task-${index + 1}`);
    await writeFile(tasksFile, `${JSON.stringify(names.map((name) => ({
      name,
      provenance_source: "frozen-selection"
    })))}\n`, "utf8");
    const harborCalls: Array<{ config: Record<string, unknown>; slot: string; args: string[] }> = [];
    let nextSlot = 0;

    const result = await runTerminalBenchCli([
      "--mode", "batch",
      "--tasks-file", tasksFile,
      "--concurrency", "4",
      "--verifier-concurrency", "1",
      "--run-label", "four-slots",
      "--network", "full",
      "--execution-mode", "container",
      "--managed-environment-mode", "required",
      "--harbor-topology", "managed_three_role"
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
        else if (args[0] === "run" && args[1] === "--help") response.stdout = "--config --yes --plugin";
        else if (args.some((arg) => arg.endsWith("probe-harbor-timeouts.py"))) {
          response.stdout = JSON.stringify({
            resolved_tasks: names.map((name) => ({ name })),
            tasks: names.map((name) => ({ task_name: name, agent_timeout_sec: 60 }))
          });
        } else if (args[0] === "run" && args.includes("--config")) {
          const configPath = args[args.indexOf("--config") + 1];
          const jobConfig = JSON.parse(await readFile(configPath, "utf8"));
          harborCalls.push({ config: jobConfig, slot: options.env.SIGMA_BENCH_RUN_SLOT, args });
          const passed = options.env.SIGMA_BENCH_RUN_SLOT !== "slot-3";
          await writeAttemptArtifacts(configPath, 1, passed);
          response = { exitCode: passed ? 0 : 1, stdout: "", stderr: passed ? "" : "isolated failure" };
        }
        await writeRunnerLogs(options, response);
        return response;
      }
    });

    try {
      expect(harborCalls).toHaveLength(4);
      expect(new Set(harborCalls.map((call) => call.slot))).toEqual(
        new Set(["slot-1", "slot-2", "slot-3", "slot-4"])
      );
      for (const call of harborCalls) {
        expect(call.config).toMatchObject({ n_concurrent_trials: 1 });
        expect(call.config.tasks).toHaveLength(1);
        expect(call.config.tasks[0]).not.toHaveProperty("source");
        expect(call.config.tasks[0]).not.toHaveProperty("provenance_source");
        expect(call.config.agents[0].kwargs).toMatchObject({
          network_mode: "full",
          execution_mode: "container",
          managed_environment_mode: "required",
          harbor_topology: "managed_three_role"
        });
        expect(call.args).toEqual(expect.arrayContaining([
          "--plugin", "verifier_gate_plugin:VerifierGatePlugin"
        ]));
      }
      const runConfig = JSON.parse(await readFile(path.join(result.runDir, "config.json"), "utf8"));
      expect(runConfig).toMatchObject({
        network_mode: "full",
        execution_mode: "container",
        managed_environment_mode: "required",
        harbor_topology: "managed_three_role",
        n_concurrent_trials: 4,
        verifier_concurrency: 1,
        verifier_gate_enabled: true
      });
      expect(runConfig.run_slots).toHaveLength(4);
      expect(runConfig.resolved_task_attestation_paths).toHaveLength(4);
      expect(result.report.trial_accounting).toMatchObject({ expected: 4, observed: 4 });
      expect(result.report).toMatchObject({
        network_mode: "full",
        managed_environment_mode: "required",
        harbor_topology: "managed_three_role",
        verifier_concurrency: 1,
        verifier_gate_enabled: true
      });
      expect(result.report.incomplete_reason).toBeNull();
      expect(result.report.tasks.every((task: { provenance_source?: string }) =>
        task.provenance_source === "frozen-selection")).toBe(true);
    } finally {
      await removeRunArtifacts(result.runDir);
      if (previousTarball === undefined) delete process.env.AGENT_CLI_TARBALL;
      else process.env.AGENT_CLI_TARBALL = previousTarball;
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
