import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHarborArgs,
  classifyFailure,
  detectHarborRunCapabilities,
  detectTaskSelectionFlag,
  generateBenchReport,
  terminalBenchDataset
} from "../scripts/bench-common.mjs";

describe("Terminal-Bench command construction", () => {
  it("builds the oracle smoke command", () => {
    expect(buildHarborArgs({ mode: "smoke" })).toEqual([
      "run",
      "-d",
      terminalBenchDataset,
      "-a",
      "oracle",
      "-l",
      "5"
    ]);
  });

  it("propagates provider, model, k, and agent limits", () => {
    expect(
      buildHarborArgs({
        mode: "k",
        k: 5,
        provider: "deepseek",
        model: "deepseek-v4-pro",
        maxTurns: 200,
        commandTimeoutSec: 180,
        maxWallTimeSec: 7200
      })
    ).toEqual([
      "run",
      "-d",
      terminalBenchDataset,
      "--agent-import-path",
      "integrations.harbor.agent:AgentCliHarborAgent",
      "-k",
      "5",
      "--ak",
      "provider:str=deepseek",
      "--ak",
      "model:str=deepseek-v4-pro",
      "--ak",
      "max_turns:int=200",
      "--ak",
      "command_timeout_sec:int=180",
      "--ak",
      "max_wall_time_sec:int=7200"
    ]);
  });

  it("uses current Harbor CLI flags when detected from help text", () => {
    const capabilities = detectHarborRunCapabilities(
      "Usage: harbor run [OPTIONS]\n --agent TEXT\n --ak TEXT Additional agent kwarg in the format 'key=value'.\n --n-tasks -l INTEGER\n --yes"
    );

    expect(
      buildHarborArgs({
        mode: "k",
        k: 5,
        provider: "glm",
        model: "glm-5.2",
        maxTurns: 200,
        commandTimeoutSec: 180,
        maxWallTimeSec: 7200,
        capabilities
      })
    ).toEqual([
      "run",
      "-d",
      terminalBenchDataset,
      "--agent",
      "integrations.harbor.agent:AgentCliHarborAgent",
      "--yes",
      "-l",
      "5",
      "--ak",
      "provider=glm",
      "--ak",
      "model=glm-5.2",
      "--ak",
      "max_turns=200",
      "--ak",
      "command_timeout_sec=180",
      "--ak",
      "max_wall_time_sec=7200"
    ]);
  });

  it("omits model ak when the model is not set", () => {
    const args = buildHarborArgs({
      mode: "k",
      k: 1,
      provider: "glm",
      maxTurns: 10,
      commandTimeoutSec: 20,
      maxWallTimeSec: 30
    });

    expect(args).toContain("provider:str=glm");
    expect(args.some((arg) => arg.startsWith("model:str="))).toBe(false);
  });

  it("detects and uses a task selection flag", () => {
    const flag = detectTaskSelectionFlag("Usage: harbor run [OPTIONS]\n  --task-id TEXT");
    expect(flag).toBe("--task-id");
    expect(
      buildHarborArgs({
        mode: "task",
        taskId: "debug-python",
        taskSelectionFlag: flag,
        provider: "deepseek",
        model: "deepseek-v4-pro",
        maxTurns: 200,
        commandTimeoutSec: 180,
        maxWallTimeSec: 7200
      })
    ).toContain("debug-python");
  });
});

describe("failure classifier", () => {
  it("classifies common setup, API, timeout, and crash failures", () => {
    expect(classifyFailure({ logText: "Node is required to run the current artifact" })).toBe("node_missing");
    expect(classifyFailure({ logText: "API request failed with 429 rate limit" })).toBe("api_error");
    expect(classifyFailure({ summary: { finish_reason: "max_turns" }, logText: "" })).toBe("max_turns");
    expect(
      classifyFailure({
        traceEvents: [
          {
            type: "tool_end",
            metadata: { result: { metadata: { timedOut: true } } }
          }
        ]
      })
    ).toBe("tool_timeout");
    expect(classifyFailure({ summary: { status: "error" }, exitCode: 1 })).toBe("agent_crashed");
  });
});

describe("benchmark report generation", () => {
  it("generates JSON and Markdown reports from synthetic task artifacts", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "sigma-bench-report-"));
    await writeFile(
      path.join(runDir, "config.json"),
      `${JSON.stringify(
        {
          run_id: "synthetic-run",
          started_at: "2026-07-06T00:00:00.000Z",
          finished_at: "2026-07-06T00:01:00.000Z",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          dataset: terminalBenchDataset,
          k: 2,
          command_text: "harbor run -k 2",
          exit_code: 1,
          status: "failed"
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(path.join(runDir, "harbor.stdout.log"), "", "utf8");
    await writeFile(path.join(runDir, "harbor.stderr.log"), "API request failed with 429\n", "utf8");
    await writeFile(path.join(runDir, "result.raw.log"), "exit_code: 1\n", "utf8");

    const passedDir = path.join(runDir, "tasks", "passed-task");
    await mkdir(passedDir, { recursive: true });
    await writeFile(path.join(passedDir, "metadata.json"), '{"task_id":"passed-task","status":"passed"}\n', "utf8");
    await writeFile(
      path.join(passedDir, "summary.json"),
      '{"status":"completed","finish_reason":"assistant_stop","commands_executed":3,"input_tokens":10,"output_tokens":5,"duration_ms":1000,"last_error":null}\n',
      "utf8"
    );
    await writeFile(path.join(passedDir, "trace.jsonl"), '{"type":"run_end","metadata":{}}\n', "utf8");

    const failedDir = path.join(runDir, "tasks", "api-task");
    await mkdir(failedDir, { recursive: true });
    await writeFile(path.join(failedDir, "metadata.json"), '{"task_id":"api-task","status":"failed"}\n', "utf8");
    await writeFile(
      path.join(failedDir, "summary.json"),
      '{"status":"error","finish_reason":"error","commands_executed":1,"input_tokens":12,"output_tokens":1,"duration_ms":500,"last_error":"API request failed with 429"}\n',
      "utf8"
    );
    await writeFile(path.join(failedDir, "agent.log"), "API request failed with 429 rate limit\n", "utf8");

    const report = await generateBenchReport(runDir);

    expect(report.counts.passed).toBe(1);
    expect(report.counts.api_error).toBe(1);
    expect(report.tasks.find((task) => task.task_id === "api-task")?.failure_category).toBe("api_error");
    expect(await readFile(path.join(runDir, "report.md"), "utf8")).toContain("# Terminal-Bench Run synthetic-run");
    expect(JSON.parse(await readFile(path.join(runDir, "report.json"), "utf8")).counts.api_error).toBe(1);
  });

  it("uses Harbor verifier reward to mark completed agents as failed", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "sigma-bench-harbor-report-"));
    await writeFile(
      path.join(runDir, "config.json"),
      `${JSON.stringify(
        {
          run_id: "harbor-reward-run",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          dataset: terminalBenchDataset,
          k: 1,
          command_text: "harbor run -l 1",
          exit_code: 0,
          status: "passed"
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(path.join(runDir, "harbor.stdout.log"), "", "utf8");
    await writeFile(path.join(runDir, "harbor.stderr.log"), "", "utf8");
    await writeFile(path.join(runDir, "result.raw.log"), "exit_code: 0\n", "utf8");

    const taskDir = path.join(runDir, "tasks", "task-a");
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(taskDir, "metadata.json"), '{"task_id":"task-a","status":"passed"}\n', "utf8");
    await writeFile(
      path.join(taskDir, "summary.json"),
      '{"status":"completed","finish_reason":"assistant_stop","commands_executed":2,"input_tokens":3,"output_tokens":4,"duration_ms":5,"last_error":null}\n',
      "utf8"
    );

    const trialDir = path.join(runDir, "harbor-jobs", "job-1", "trial-1");
    await mkdir(trialDir, { recursive: true });
    await writeFile(
      path.join(trialDir, "result.json"),
      `${JSON.stringify({
        trial_name: "trial-1",
        task_name: "terminal-bench/task-a",
        verifier_result: { rewards: { reward: 0.0 } },
        exception_info: null
      })}\n`,
      "utf8"
    );

    const report = await generateBenchReport(runDir);

    expect(report.status).toBe("failed");
    expect(report.counts.failed).toBe(1);
    expect(report.tasks[0].status).toBe("failed");
    expect(report.tasks[0].failure_category).toBe("verifier_failed");
    expect(report.tasks[0].reward).toBe(0);
  });
});
