import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  allocateBenchmarkRunDirectory,
  assembleGroupedLogs,
  runTerminalBenchCli
} from "../scripts/bench-terminal-bench.mjs";

async function writeRunnerLogs(options: Record<string, string | undefined>, result: { exitCode: number; stdout: string; stderr: string }) {
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
  const runDir = path.dirname(configPath);
  const jobConfig = JSON.parse(await readFile(configPath, "utf8"));
  const managedProvenance = jobConfig.agents?.[0]?.kwargs?.managed_provenance === true;
  const trialDir = path.join(runDir, "harbor-jobs", "job-1", `trial-${attempt}`);
  const taskDir = path.join(runDir, "tasks", "selected-task");
  await mkdir(taskDir, { recursive: true });
  await writeFile(path.join(taskDir, "metadata.json"), `${JSON.stringify({
    task_id: "terminal-bench/selected-task",
    source_logs_dir: path.join(trialDir, "agent"),
    execution_backend: "sandbox:bwrap",
    ...(managedProvenance ? {
      container_engine: "docker",
      container_target: "managed",
      target_image_id: `sha256:${"a".repeat(64)}`
    } : {})
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
      task_name: "terminal-bench/selected-task",
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

describe("Terminal-Bench CLI verifier result handling", () => {
  it("allocates collision-resistant run directories exclusively", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-bench-run-id-"));
    const nonces = ["same", "same", "different"];
    try {
      const first = await allocateBenchmarkRunDirectory(
        directory, "20260719-120000-deepseek-model", "candidate", () => nonces.shift() ?? "fallback"
      );
      const second = await allocateBenchmarkRunDirectory(
        directory, "20260719-120000-deepseek-model", "candidate", () => nonces.shift() ?? "fallback"
      );
      expect(first.runId).not.toBe(second.runId);
      expect(first.runDir).not.toBe(second.runDir);
      expect((await stat(first.runDir)).isDirectory()).toBe(true);
      expect((await stat(second.runDir)).isDirectory()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("assembles complete group logs from files instead of concatenating returned output", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-bench-group-logs-"));
    const first = "a".repeat(256 * 1024);
    const second = "b".repeat(256 * 1024);
    try {
      await Promise.all([
        writeFile(path.join(directory, "harbor-group-001.stdout.log"), first, "utf8"),
        writeFile(path.join(directory, "harbor-group-001.stderr.log"), "first-error", "utf8"),
        writeFile(path.join(directory, "harbor-group-002.stdout.log"), second, "utf8"),
        writeFile(path.join(directory, "harbor-group-002.stderr.log"), "second-error", "utf8")
      ]);
      await assembleGroupedLogs(
        directory,
        [{}, {}],
        [
          { exitCode: 0, stdout: "bounded-first", stderr: "bounded-first-error" },
          { exitCode: 1, stdout: "bounded-second", stderr: "bounded-second-error" }
        ]
      );
      const stdout = await readFile(path.join(directory, "harbor.stdout.log"), "utf8");
      expect(stdout).toContain(first);
      expect(stdout).toContain(second);
      expect(stdout).not.toContain("bounded-first");
      expect((await stat(path.join(directory, "harbor.stdout.log"))).size)
        .toBeGreaterThanOrEqual(512 * 1024);
      expect(await readFile(path.join(directory, "result.raw.log"), "utf8"))
        .toContain("stdout_log: harbor-group-002.stdout.log");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("marks a pre-Harbor failure incomplete instead of scoring a synthetic zero", async () => {
    const result = await runTerminalBenchCli([
      "--mode", "task", "--task-id", "selected-task", "--run-label", "pre-harbor-incomplete"
    ], {
      repositorySourceIdentity: () => ({ revision: "b".repeat(40), dirty: false }),
      resolveHarborCommand: () => ({ command: "harbor", source: "test", exists: true }),
      packageAgentCli: async () => ({ exitCode: 1, stdout: "", stderr: "build failed" })
    });

    try {
      expect(result.report.status).toBe("incomplete");
      expect(result.report.score_status).toBe("incomplete");
      expect(result.report).toMatchObject({
        managed_provenance: false,
        harbor_topology: "main_only"
      });
      expect(result.report.incomplete_reason.join("\n")).toMatch(/trial result count 0 does not match expected 1/iu);
    } finally {
      await rm(result.runDir, { recursive: true, force: true });
    }
  });

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
      "--expected-archive-sha256", sha, "--run-label", "reuse-test",
      "--managed-provenance"
    ], {
      repositorySourceIdentity: () => ({ revision: "c".repeat(40), dirty: false }),
      agentCliArchiveSourceIdentity: () => ({ revision: "c".repeat(40), dirty: false }),
      resolveHarborCommand: () => ({ command: "harbor", source: "test", exists: true }),
      packageAgentCli: async () => {
        packageCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      packageHarborRuntime: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
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
      expect(result.report.source_revision).toBe("c".repeat(40));
      expect(result.report.source_dirty).toBe(false);
      expect(result.report).toMatchObject({
        managed_provenance: true,
        harbor_topology: "managed_three_role"
      });
      const runConfig = JSON.parse(await readFile(path.join(result.runDir, "config.json"), "utf8"));
      expect(runConfig).toMatchObject({
        execution_mode: "sandboxed",
        managed_provenance: true,
        harbor_topology: "managed_three_role"
      });
      const resolvedJob = JSON.parse(
        await readFile(path.join(result.runDir, "resolved-job.config.json"), "utf8")
      );
      expect(resolvedJob.agents[0].kwargs).toMatchObject({
        execution_mode: "sandboxed",
        managed_provenance: true
      });
      expect(resolvedJob.environment.extra_docker_compose[0])
        .toMatch(/docker-compose-sigma-container\.yaml$/u);
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
        agentCliArchiveSourceIdentity: () => ({ revision: "d".repeat(40), dirty: true }),
        resolveHarborCommand: () => ({ command: "harbor", source: "test", exists: true }),
        packageAgentCli: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        packageHarborRuntime: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
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
      const firstConfig = JSON.parse(await readFile(path.join(result.runDir, "resolved-job.config.json"), "utf8"));
      expect(Object.keys(firstConfig.agents[0].kwargs).some((key) => key.includes("feedback"))).toBe(false);
      await expect(readFile(path.join(result.runDir, "resolved-job.retry-1.config.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(result.runDir, { recursive: true, force: true });
      if (previousTarball === undefined) delete process.env.AGENT_CLI_TARBALL;
      else process.env.AGENT_CLI_TARBALL = previousTarball;
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
