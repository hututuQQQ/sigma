import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultAgentCliTarballForEnv } from "../scripts/bench-common.mjs";
import { runTerminalBenchCli } from "../scripts/bench-terminal-bench.mjs";

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
  const taskDir = path.join(runDir, "tasks", "selected-task");
  await mkdir(taskDir, { recursive: true });
  await writeFile(path.join(taskDir, "metadata.json"), '{"task_id":"terminal-bench/selected-task"}\n', "utf8");
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

  const trialDir = path.join(runDir, "harbor-jobs", "job-1", `trial-${attempt}`);
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
}

describe("Terminal-Bench CLI verifier result handling", () => {
  it("does not retry or pass verifier result details in task mode", async () => {
    const tarball = defaultAgentCliTarballForEnv();
    await mkdir(path.dirname(tarball), { recursive: true });
    await writeFile(tarball, "stub", "utf8");
    let harborRuns = 0;

    const result = await runTerminalBenchCli(
      ["--mode", "task", "--task-id", "selected-task", "--provider", "deepseek", "--model", "retry-test-model"],
      {
        resolveHarborCommand: () => ({ command: "harbor", source: "test", exists: true }),
        packageAgentCli: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        packageHarborRuntime: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
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
    }
  });
});
