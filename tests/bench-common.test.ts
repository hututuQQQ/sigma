import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHarborArgs,
  buildHarborJobConfig,
  buildHarborTimeoutProbeConfig,
  buildCommandScript,
  classifyFailure,
  computeHarborTimeoutPlan,
  defaultAgentCliTarballForEnv,
  detectHarborRunCapabilities,
  detectTaskSelectionFlag,
  formatMarkdownReport,
  generateBenchReport,
  harborEnvForRun,
  harborRuntimeDir,
  parseHarborTimeoutProbe,
  portableAgentImportPath,
  removedHarborAdapterErrorMessage,
  removedHarborPackageName,
  resolveHarborCommand,
  suggestedOwnerForFailureCategory,
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
      portableAgentImportPath,
      "-k",
      "5",
      "--ak",
      `agent_cli_tarball:str=${defaultAgentCliTarballForEnv()}`,
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
      "Usage: harbor run [OPTIONS]\n --agent TEXT\n --ak TEXT Additional agent kwarg in the format 'key=value'.\n --n-tasks -l INTEGER\n --yes\n --agent-timeout-multi... FLOAT Multiplier for agent execution timeout"
    );

    expect(capabilities.agentTimeoutMultiplierFlag).toBe("--agent-timeout-multiplier");
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
      portableAgentImportPath,
      "--yes",
      "-l",
      "5",
      "--agent-timeout-multiplier",
      "8.12",
      "--ak",
      `agent_cli_tarball=${defaultAgentCliTarballForEnv()}`,
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

  it("uses detected task limit flags for oracle smoke runs", () => {
    expect(
      buildHarborArgs({
        mode: "smoke",
        capabilities: { taskLimitFlag: "-k", yesFlag: "--yes" }
      })
    ).toEqual(["run", "-d", terminalBenchDataset, "-a", "oracle", "-k", "5", "--yes"]);
  });

  it("uses probed task timeout metadata for agent and Harbor thresholds", () => {
    const capabilities = {
      agentFlag: "--agent",
      agentKwargStyle: "plain",
      taskLimitFlag: "-l",
      agentTimeoutMultiplierFlag: "--agent-timeout-multiplier"
    };
    const timeoutProbe = {
      tasks: [{ task_name: "terminal-bench/make-mips-interpreter", agent_timeout_sec: 1800 }],
      max_agent_timeout_sec: 1800
    };
    const timeoutPlan = computeHarborTimeoutPlan(
      {
        agentTimeoutGraceSec: 120
      },
      timeoutProbe
    );

    expect(timeoutPlan).toMatchObject({
      agent_wall_time_sec: 2700,
      retry_budget_sec: 2700,
      precheck_timeout_sec: 45,
      precheck_retry_limit: 1,
      harbor_agent_timeout_sec: 5610,
      effective_harbor_agent_timeout_sec: 5610,
      agent_timeout_multiplier: "3.12",
      source: "harbor_task_metadata"
    });
    expect(
      buildHarborArgs({
        mode: "k",
        k: 1,
        provider: "deepseek",
        model: "deepseek-v4-pro",
        maxTurns: 200,
        commandTimeoutSec: 180,
        capabilities,
        timeoutProbe,
        timeoutPlan
      })
    ).toContain("max_wall_time_sec=2700");
  });

  it("gives long MVP tasks lenient wall time by default", () => {
    const timeoutPlan = computeHarborTimeoutPlan(
      {
        agentTimeoutGraceSec: 120
      },
      {
        tasks: [{ task_name: "terminal-bench/long-task", agent_timeout_sec: 6000 }],
        max_agent_timeout_sec: 6000
      }
    );

    expect(timeoutPlan).toMatchObject({
      agent_wall_time_sec: 9000,
      retry_budget_sec: 9000,
      precheck_timeout_sec: 45,
      precheck_retry_limit: 1,
      harbor_agent_timeout_sec: 18210,
      agent_timeout_multiplier: "3.04",
      leniency_multiplier: 1.5,
      leniency_min_extra_sec: 600
    });
  });

  it("keeps Harbor outer timeout wider when max wall time is explicit", () => {
    const timeoutPlan = computeHarborTimeoutPlan(
      {
        maxWallTimeSec: 6000,
        agentTimeoutGraceSec: 120
      },
      {
        tasks: [{ task_name: "terminal-bench/task-a", agent_timeout_sec: 1800 }],
        max_agent_timeout_sec: 1800
      }
    );

    expect(timeoutPlan).toMatchObject({
      agent_wall_time_sec: 6000,
      retry_budget_sec: 6000,
      harbor_agent_timeout_sec: 12210,
      agent_timeout_multiplier: "6.79",
      source: "explicit_max_wall_time"
    });
  });

  it("builds a Harbor timeout probe config for the selected task", () => {
    expect(
      buildHarborTimeoutProbeConfig(
        {
          mode: "task",
          taskId: "make-mips-interpreter",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          maxTurns: 200,
          commandTimeoutSec: 180
        },
        "probe-jobs"
      )
    ).toMatchObject({
      jobs_dir: "probe-jobs",
      tasks: [{ name: "terminal-bench/make-mips-interpreter" }]
    });
  });

  it("parses Harbor timeout probe JSON from stdout", () => {
    expect(parseHarborTimeoutProbe('noise\n{"max_agent_timeout_sec":1800,"tasks":[]}\n')).toEqual({
      max_agent_timeout_sec: 1800,
      tasks: []
    });
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

  it("resolves Harbor executable from explicit and common Windows locations", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sigma-harbor-bin-"));
    const explicit = path.join(dir, "custom-harbor.exe");
    await writeFile(explicit, "", "utf8");
    expect(resolveHarborCommand({ HARBOR_BIN: explicit }, "win32")).toMatchObject({
      command: explicit,
      source: "HARBOR_BIN",
      exists: true
    });

    const appData = path.join(dir, "AppData");
    const uvHarbor = path.join(appData, "uv", "tools", "harbor", "Scripts", "harbor.exe");
    await mkdir(path.dirname(uvHarbor), { recursive: true });
    await writeFile(uvHarbor, "", "utf8");
    expect(resolveHarborCommand({ APPDATA: appData }, "win32")).toMatchObject({
      command: uvHarbor,
      source: "APPDATA_UV_TOOL",
      exists: true
    });

    expect(resolveHarborCommand({}, "linux")).toMatchObject({
      command: "harbor",
      source: "PATH",
      exists: null
    });
  });

  it("builds resolved JobConfig with selected tasks, lenient timeout, and make-mips precheck", () => {
    const timeoutProbe = {
      resolved_tasks: [{ name: "terminal-bench/make-mips-interpreter" }],
      tasks: [{ task_name: "terminal-bench/make-mips-interpreter", agent_timeout_sec: 1800 }],
      max_agent_timeout_sec: 1800
    };
    const timeoutPlan = computeHarborTimeoutPlan({ agentTimeoutGraceSec: 120 }, timeoutProbe);
    const config = buildHarborJobConfig(
      {
        mode: "k",
        k: 1,
        provider: "deepseek",
        model: "deepseek-v4-pro",
        maxTurns: 200,
        commandTimeoutSec: 180
      },
      "jobs",
      timeoutPlan,
      timeoutProbe
    );

    expect(config.datasets).toBeUndefined();
    expect(config.tasks).toEqual([{ name: "terminal-bench/make-mips-interpreter" }]);
    expect(config.agent_timeout_multiplier).toBe(3.12);
    expect(config.agents[0].name).toBe(portableAgentImportPath);
    expect(path.isAbsolute(config.agents[0].kwargs.agent_cli_tarball)).toBe(true);
    expect(config.agents[0].kwargs).toMatchObject({
      agent_cli_tarball: defaultAgentCliTarballForEnv(),
      max_turns: 540,
      max_wall_time_sec: 2700,
      harbor_agent_timeout_sec: 5610,
      precheck_retry_limit: 1,
      precheck_timeout_sec: 45,
      generic_validation_enabled: true,
      validation_timeout_sec: 45,
      pre_verifier_cleanup_globs: "/tmp/frame*.bmp"
    });
    expect(config.agents[0].kwargs.precheck_command).toContain("/tmp/frame.bmp");
    expect(config.agents[0].kwargs.precheck_command).toContain("timeout 35 node /app/vm.js");
  });

  it("enables generic validation retry budget for ordinary Terminal-Bench tasks", () => {
    const timeoutProbe = {
      resolved_tasks: [{ name: "terminal-bench/regex-log" }],
      tasks: [{ task_name: "terminal-bench/regex-log", agent_timeout_sec: 1800 }],
      max_agent_timeout_sec: 1800
    };
    const timeoutPlan = computeHarborTimeoutPlan({ agentTimeoutGraceSec: 120 }, timeoutProbe);
    const config = buildHarborJobConfig(
      {
        mode: "task",
        taskId: "regex-log",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        maxTurns: 200,
        commandTimeoutSec: 180
      },
      "jobs",
      timeoutPlan,
      timeoutProbe
    );

    expect(timeoutPlan).toMatchObject({
      agent_wall_time_sec: 2700,
      retry_budget_sec: 2700,
      precheck_retry_limit: 1,
      precheck_timeout_sec: 45,
      generic_validation_enabled: true
    });
    expect(config.agents[0].kwargs).toMatchObject({
      agent_cli_tarball: defaultAgentCliTarballForEnv(),
      generic_validation_enabled: true,
      validation_timeout_sec: 45,
      precheck_retry_limit: 1,
      precheck_timeout_sec: 45
    });
    expect(config.agents[0].kwargs.precheck_command).toBeUndefined();
  });

  it("preserves explicit max turns in resolved JobConfig", () => {
    const timeoutProbe = {
      resolved_tasks: [{ name: "terminal-bench/make-mips-interpreter" }],
      tasks: [{ task_name: "terminal-bench/make-mips-interpreter", agent_timeout_sec: 1800 }],
      max_agent_timeout_sec: 1800
    };
    const timeoutPlan = computeHarborTimeoutPlan({ agentTimeoutGraceSec: 120 }, timeoutProbe);
    const config = buildHarborJobConfig(
      {
        mode: "task",
        taskId: "make-mips-interpreter",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        maxTurns: 200,
        maxTurnsExplicit: true,
        commandTimeoutSec: 180
      },
      "jobs",
      timeoutPlan,
      timeoutProbe
    );

    expect(config.agents[0].kwargs.max_turns).toBe(200);
  });

  it("rejects removed Harbor import paths", () => {
    const removedAgentClass = ["AgentCli", "HarborAgent"].join("");
    const removedImportPath = `${removedHarborPackageName}.agent:${removedAgentClass}`;

    expect(() =>
      buildHarborJobConfig(
        {
          mode: "k",
          k: 1,
          provider: "deepseek",
          model: "deepseek-v4-pro",
          maxTurns: 200,
          commandTimeoutSec: 180,
          env: { SIGMA_HARBOR_AGENT_IMPORT_PATH: removedImportPath }
        },
        "jobs"
      )
    ).toThrow(removedHarborAdapterErrorMessage);
    expect(() =>
      buildHarborArgs({
        mode: "k",
        k: 1,
        provider: "deepseek",
        model: "deepseek-v4-pro",
        maxTurns: 200,
        commandTimeoutSec: 180,
        maxWallTimeSec: 7200,
        agentImportPath: `${removedHarborPackageName}.custom:OtherAgent`
      })
    ).toThrow(removedHarborAdapterErrorMessage);
  });

  it("puts only the portable runtime and existing PYTHONPATH on PYTHONPATH", () => {
    const portableEnv = harborEnvForRun("run-dir", {});
    const portablePythonPath = portableEnv.PYTHONPATH.split(path.delimiter);
    expect(portablePythonPath).toEqual([harborRuntimeDir]);

    const existingEnv = harborEnvForRun("run-dir", { PYTHONPATH: ["one", "two"].join(path.delimiter) });
    expect(existingEnv.PYTHONPATH.split(path.delimiter)).toEqual([harborRuntimeDir, "one", "two"]);
  });

  it("rejects removed Harbor import paths before building run env", () => {
    expect(() =>
      harborEnvForRun("run-dir", {
        SIGMA_HARBOR_AGENT_IMPORT_PATH: `${removedHarborPackageName}.agent:RemovedAgent`
      })
    ).toThrow(removedHarborAdapterErrorMessage);
  });

  it("writes portable command scripts without the legacy integration import path", () => {
    const env = harborEnvForRun("run-dir", {});
    const args = buildHarborArgs({
      mode: "k",
      k: 1,
      provider: "deepseek",
      model: "deepseek-v4-pro",
      maxTurns: 200,
      commandTimeoutSec: 180,
      maxWallTimeSec: 7200,
      env
    });
    const script = buildCommandScript("harbor", args, env);

    expect(script).toContain(portableAgentImportPath);
    expect(script).toContain(harborRuntimeDir);
    expect(script).not.toContain(removedHarborPackageName);
  });
});

describe("failure classifier", () => {
  it("classifies common setup, API, timeout, and crash failures", () => {
    expect(classifyFailure({ logText: "ValueError: Unknown scheme for proxy URL URL('htpp://127.0.0.1:7890')" })).toBe(
      "host_proxy_error"
    );
    expect(classifyFailure({ logText: "UnicodeEncodeError: 'gbk' codec can't encode character '\\u2022'" })).toBe(
      "host_encoding_error"
    );
    expect(
      classifyFailure({
        logText: "Traceback (most recent call last)\n  File site-packages\\harbor\\cli\\run.py"
      })
    ).toBe("harbor_cli_error");
    expect(classifyFailure({ logText: "Failed to start harbor: spawn harbor ENOENT\n--agent-timeout-multiplier" })).toBe(
      "harbor_cli_error"
    );
    expect(classifyFailure({ logText: "Harbor timeout probe failed with exit code 1." })).toBe("harbor_cli_error");
    expect(classifyFailure({ logText: "Node is required to run the current artifact" })).toBe("node_missing");
    expect(classifyFailure({ logText: "Sigma agent cannot start: no bundled node and no system node found." })).toBe(
      "node_missing"
    );
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
    expect(classifyFailure({ logText: '{"max_wall_time_sec":2700}', exitCode: 1 })).toBe("agent_crashed");
    expect(classifyFailure({ logText: '{"finish_reason":"max_wall_time"}' })).toBe("agent_timeout");
    expect(classifyFailure({ summary: { status: "error" }, exitCode: 1 })).toBe("agent_crashed");
  });

  it("maps failure categories to suggested owners", () => {
    expect(suggestedOwnerForFailureCategory("host_proxy_error")).toBe("environment");
    expect(suggestedOwnerForFailureCategory("host_encoding_error")).toBe("environment");
    expect(suggestedOwnerForFailureCategory("harbor_cli_error")).toBe("scripts/bench");
    expect(suggestedOwnerForFailureCategory("node_missing")).toBe("package-agent-cli");
    expect(suggestedOwnerForFailureCategory("agent_setup_failed")).toBe("portable/harbor");
    expect(suggestedOwnerForFailureCategory("api_error")).toBe("agent-ai");
    expect(suggestedOwnerForFailureCategory("agent_timeout")).toBe("agent-core");
    expect(suggestedOwnerForFailureCategory("max_turns")).toBe("agent-core");
    expect(suggestedOwnerForFailureCategory("tool_timeout")).toBe("agent-core");
    expect(suggestedOwnerForFailureCategory("verifier_failed")).toBe("agent-core");
    expect(suggestedOwnerForFailureCategory("agent_crashed")).toBe("agent-core");
    expect(suggestedOwnerForFailureCategory("unknown")).toBe("inspect");
    expect(suggestedOwnerForFailureCategory("new-category")).toBe("inspect");
  });
});

describe("markdown report formatting", () => {
  it("includes suggested_owner in the Tasks table and ownership guidance", () => {
    const markdown = formatMarkdownReport({
      run_id: "owner-run",
      status: "failed",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      dataset: terminalBenchDataset,
      started_at: "2026-07-06T00:00:00.000Z",
      finished_at: "2026-07-06T00:01:00.000Z",
      exit_code: 1,
      command: "harbor run -k 1",
      harbor_command: "harbor",
      timeout_plan: null,
      counts: {
        passed: 0,
        failed: 1,
        infra_failed: 0,
        timeout: 0,
        api_error: 0,
        unknown: 0
      },
      tasks: [
        {
          task_id: "terminal-bench/task-a",
          status: "failed",
          failure_category: "verifier_failed",
          suggested_owner: "agent-core",
          failure_signals: ["agent_completed_but_verifier_failed"],
          commands_executed: 2,
          input_tokens: 3,
          output_tokens: 4,
          duration_ms: 5,
          last_error: "Verifier failed",
          verifier_failed_tests: [],
          reward: null
        }
      ],
      incomplete_reason: null,
      notes: []
    });

    expect(markdown).toContain("| task | status | failure_category | suggested_owner | failure_signals |");
    expect(markdown).toContain(
      "| terminal-bench/task-a | failed | verifier_failed | agent-core | agent_completed_but_verifier_failed |"
    );
    expect(markdown).toContain("## Ownership Guidance");
    expect(markdown).toContain("If `suggested_owner` is not `portable/harbor` or `scripts/bench`");
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
    expect(report.tasks.find((task) => task.task_id === "passed-task")?.suggested_owner).toBeNull();
    expect(report.tasks.find((task) => task.task_id === "api-task")?.failure_category).toBe("api_error");
    expect(report.tasks.find((task) => task.task_id === "api-task")?.suggested_owner).toBe("agent-ai");
    const markdown = await readFile(path.join(runDir, "report.md"), "utf8");
    const jsonReport = JSON.parse(await readFile(path.join(runDir, "report.json"), "utf8"));
    expect(markdown).toContain("# Terminal-Bench Run synthetic-run");
    expect(markdown).toContain("| task | status | failure_category | suggested_owner |");
    expect(jsonReport.counts.api_error).toBe(1);
    expect(jsonReport.tasks.find((task) => task.task_id === "api-task")?.suggested_owner).toBe("agent-ai");
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
    const verifierDir = path.join(trialDir, "verifier");
    await mkdir(verifierDir, { recursive: true });
    await writeFile(path.join(verifierDir, "test-stdout.txt"), "FAILED test_outputs.py::test_vm_execution - nope\n", "utf8");
    await writeFile(
      path.join(verifierDir, "ctrf.json"),
      `${JSON.stringify({
        results: {
          tests: [
            {
              name: "test_outputs.py::test_vm_execution",
              status: "failed",
              message: "Expected text not found in output",
              trace: "assert expected_text in stdout_content"
            }
          ]
        }
      })}\n`,
      "utf8"
    );

    const report = await generateBenchReport(runDir);

    expect(report.status).toBe("failed");
    expect(report.counts.failed).toBe(1);
    expect(report.tasks[0].status).toBe("failed");
    expect(report.tasks[0].failure_category).toBe("verifier_failed");
    expect(report.tasks[0].reward).toBe(0);
    expect(report.tasks[0].verifier_log_path).toBe("harbor-jobs/job-1/trial-1/verifier/test-stdout.txt");
    expect(report.tasks[0].verifier_failed_tests[0]).toMatchObject({
      name: "test_outputs.py::test_vm_execution",
      message: "Expected text not found in output"
    });
    expect(report.tasks[0].last_error).toContain("test_outputs.py::test_vm_execution");
    expect(await readFile(path.join(runDir, "report.md"), "utf8")).toContain("## Verifier Failures");
  });

  it("matches Harbor trial results by task name instead of sorted order", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "sigma-bench-harbor-match-"));
    await writeFile(
      path.join(runDir, "config.json"),
      `${JSON.stringify({
        run_id: "harbor-match-run",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        dataset: terminalBenchDataset,
        k: 2,
        command_text: "harbor run -l 2",
        exit_code: 0,
        status: "passed"
      })}\n`,
      "utf8"
    );
    await writeFile(path.join(runDir, "harbor.stdout.log"), "", "utf8");
    await writeFile(path.join(runDir, "harbor.stderr.log"), "", "utf8");
    await writeFile(path.join(runDir, "result.raw.log"), "exit_code: 0\n", "utf8");

    for (const taskName of ["task-a", "task-b"]) {
      const taskDir = path.join(runDir, "tasks", taskName);
      await mkdir(taskDir, { recursive: true });
      await writeFile(path.join(taskDir, "metadata.json"), `${JSON.stringify({ task_id: taskName, status: "passed" })}\n`, "utf8");
      await writeFile(
        path.join(taskDir, "summary.json"),
        '{"status":"completed","finish_reason":"assistant_stop","commands_executed":1,"input_tokens":1,"output_tokens":1,"duration_ms":1,"last_error":null}\n',
        "utf8"
      );
    }

    for (const [trialName, taskName, reward] of [
      ["aaa-trial", "terminal-bench/task-b", 0],
      ["zzz-trial", "terminal-bench/task-a", 1]
    ]) {
      const trialDir = path.join(runDir, "harbor-jobs", "job-1", trialName);
      await mkdir(trialDir, { recursive: true });
      await writeFile(
        path.join(trialDir, "result.json"),
        `${JSON.stringify({
          trial_name: trialName,
          task_name: taskName,
          verifier_result: { rewards: { reward } },
          exception_info: null
        })}\n`,
        "utf8"
      );
    }

    const report = await generateBenchReport(runDir);

    expect(report.tasks.find((task) => task.task_id === "terminal-bench/task-a")?.status).toBe("passed");
    expect(report.tasks.find((task) => task.task_id === "terminal-bench/task-b")?.status).toBe("failed");
  });

  it("extracts missing Python module signals without misreading max_wall_time_sec config", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "sigma-bench-missing-module-"));
    await writeFile(
      path.join(runDir, "config.json"),
      `${JSON.stringify({
        run_id: "missing-module-run",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        dataset: terminalBenchDataset,
        k: 1,
        command_text: "harbor run --config resolved-job.config.json",
        exit_code: 1,
        status: "failed"
      })}\n`,
      "utf8"
    );
    await writeFile(path.join(runDir, "harbor.stdout.log"), "", "utf8");
    await writeFile(path.join(runDir, "harbor.stderr.log"), "", "utf8");
    await writeFile(path.join(runDir, "result.raw.log"), "exit_code: 1\n", "utf8");

    const taskDir = path.join(runDir, "tasks", "openssl-selfsigned-cert");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      path.join(taskDir, "metadata.json"),
      `${JSON.stringify({
        task_id: "terminal-bench/openssl-selfsigned-cert",
        status: "failed",
        max_wall_time_sec: 2700,
        failure_signals: ["agent_setup_ok"]
      })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(taskDir, "summary.json"),
      '{"status":"completed","finish_reason":"assistant_stop","commands_executed":8,"duration_ms":37000}\n',
      "utf8"
    );
    await writeFile(
      path.join(taskDir, "verifier.log"),
      "ModuleNotFoundError: No module named 'cryptography'\n",
      "utf8"
    );

    const report = await generateBenchReport(runDir);

    expect(report.tasks[0].failure_category).toBe("verifier_failed");
    expect(report.tasks[0].failure_signals).toEqual(
      expect.arrayContaining([
        "agent_setup_ok",
        "agent_completed_but_verifier_failed",
        "missing_python_module:cryptography"
      ])
    );
    expect(report.tasks[0].failure_signals).not.toContain("max_wall_time");
  });

  it("reports secondary failure signals for missing make-mips frame artifacts", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "sigma-bench-signals-"));
    await writeFile(
      path.join(runDir, "config.json"),
      `${JSON.stringify({
        run_id: "signals-run",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        dataset: terminalBenchDataset,
        k: 1,
        command_text: "harbor run --config resolved-job.config.json",
        exit_code: 1,
        status: "failed",
        timeout_plan: {
          retry_budget_sec: 2700,
          precheck_timeout_sec: 45,
          effective_harbor_agent_timeout_sec: 5610
        }
      })}\n`,
      "utf8"
    );
    await writeFile(path.join(runDir, "harbor.stdout.log"), "", "utf8");
    await writeFile(path.join(runDir, "harbor.stderr.log"), "", "utf8");
    await writeFile(path.join(runDir, "result.raw.log"), "exit_code: 1\n", "utf8");

    const taskDir = path.join(runDir, "tasks", "make-mips-interpreter");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      path.join(taskDir, "metadata.json"),
      `${JSON.stringify({
        task_id: "terminal-bench/make-mips-interpreter",
        status: "failed",
        failure_signals: ["precheck_failed"],
        precheck_results: [{ exit_code: 1, message: "File /tmp/frame.bmp does not exist" }]
      })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(taskDir, "summary.json"),
      '{"status":"stopped","finish_reason":"max_wall_time","commands_executed":2,"duration_ms":2700000,"last_error":"wall time"}\n',
      "utf8"
    );

    const trialDir = path.join(runDir, "harbor-jobs", "job-1", "trial-1");
    await mkdir(trialDir, { recursive: true });
    await writeFile(
      path.join(trialDir, "result.json"),
      `${JSON.stringify({
        trial_name: "trial-1",
        task_name: "terminal-bench/make-mips-interpreter",
        verifier_result: { rewards: { reward: 0 } },
        exception_info: { exception_message: "Agent execution timed out after 5610.0 seconds" }
      })}\n`,
      "utf8"
    );
    const verifierDir = path.join(trialDir, "verifier");
    await mkdir(verifierDir, { recursive: true });
    await writeFile(
      path.join(verifierDir, "ctrf.json"),
      `${JSON.stringify({
        results: {
          tests: [
            {
              name: "test_frame_bmp_exists",
              status: "failed",
              message: "File /tmp/frame.bmp does not exist",
              trace: "assert frame_path.exists()"
            }
          ]
        }
      })}\n`,
      "utf8"
    );

    const report = await generateBenchReport(runDir);
    const markdown = await readFile(path.join(runDir, "report.md"), "utf8");

    expect(report.tasks[0].failure_category).toBe("agent_timeout");
    expect(report.tasks[0].failure_signals).toEqual(
      expect.arrayContaining(["precheck_failed", "missing_artifact:/tmp/frame.bmp", "max_wall_time"])
    );
    expect(markdown).toContain("missing_artifact:/tmp/frame.bmp");
    expect(markdown).toContain("Effective Harbor agent timeout sec: 5610");
  });

  it("reads harness validation, retry, and cleanup signals from summary JSON", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "sigma-bench-harness-signals-"));
    await writeFile(
      path.join(runDir, "config.json"),
      `${JSON.stringify({
        run_id: "harness-signals-run",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        dataset: terminalBenchDataset,
        k: 1,
        command_text: "harbor run --config resolved-job.config.json",
        exit_code: 1,
        status: "failed"
      })}\n`,
      "utf8"
    );
    await writeFile(path.join(runDir, "harbor.stdout.log"), "", "utf8");
    await writeFile(path.join(runDir, "harbor.stderr.log"), "", "utf8");
    await writeFile(path.join(runDir, "result.raw.log"), "exit_code: 1\n", "utf8");

    const taskDir = path.join(runDir, "tasks", "openssl-selfsigned-cert");
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(taskDir, "metadata.json"), '{"task_id":"openssl-selfsigned-cert"}\n', "utf8");
    await writeFile(
      path.join(taskDir, "summary.json"),
      `${JSON.stringify({
        status: "error",
        finish_reason: "validation_failed",
        commands_executed: 2,
        input_tokens: 3,
        output_tokens: 4,
        duration_ms: 5,
        last_error: "validation command failed",
        harness: {
          attempts: [],
          validation_results: [{ kind: "validation", command: "python check.py", exit_code: 1 }],
          precheck_results: [],
          retry_decisions: [
            { action: "started", trigger: "validation" },
            { action: "skipped", trigger: "validation" }
          ],
          pre_verifier_cleanup: { patterns: ["/tmp/frame*.bmp"], exit_code: 1, warning: "cleanup failed" }
        }
      })}\n`,
      "utf8"
    );

    const report = await generateBenchReport(runDir);

    expect(report.tasks[0].failure_signals).toEqual(
      expect.arrayContaining([
        "validation_failed",
        "validation_retry_used",
        "retry_cut_short_by_budget",
        "pre_verifier_cleanup_warning"
      ])
    );
  });

  it("marks stale running runs as incomplete with missing file details", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "sigma-bench-incomplete-"));
    await writeFile(
      path.join(runDir, "config.json"),
      `${JSON.stringify({
        run_id: "incomplete-run",
        started_at: "2026-07-06T00:00:00.000Z",
        finished_at: null,
        provider: "deepseek",
        model: "deepseek-v4-pro",
        dataset: terminalBenchDataset,
        command_text: "harbor run --help",
        exit_code: null,
        status: "running"
      })}\n`,
      "utf8"
    );

    const report = await generateBenchReport(runDir);
    const markdown = await readFile(path.join(runDir, "report.md"), "utf8");

    expect(report.status).toBe("incomplete");
    expect(report.incomplete_reason?.join("\n")).toContain("missing expected log files");
    expect(report.counts.unknown).toBe(1);
    expect(markdown).toContain("## Incomplete Run");
  });

  it("falls back to Harbor trial agent trace when mirrored task trace is missing", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "sigma-bench-trace-fallback-"));
    await writeFile(
      path.join(runDir, "config.json"),
      `${JSON.stringify({
        run_id: "trace-fallback-run",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        dataset: terminalBenchDataset,
        k: 1,
        command_text: "harbor run --config resolved-job.config.json",
        exit_code: 1,
        status: "failed"
      })}\n`,
      "utf8"
    );
    await writeFile(path.join(runDir, "harbor.stdout.log"), "", "utf8");
    await writeFile(path.join(runDir, "harbor.stderr.log"), "", "utf8");
    await writeFile(path.join(runDir, "result.raw.log"), "exit_code: 1\n", "utf8");

    const taskDir = path.join(runDir, "tasks", "run");
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(taskDir, "metadata.json"), '{"task_id":"run","status":"failed","exit_code":1}\n', "utf8");

    const trialDir = path.join(runDir, "harbor-jobs", "job-1", "trial-1");
    await mkdir(path.join(trialDir, "agent"), { recursive: true });
    await writeFile(
      path.join(trialDir, "result.json"),
      `${JSON.stringify({
        trial_name: "trial-1",
        task_name: "terminal-bench/task-a",
        exception_info: { exception_message: "Agent execution timed out after 1800.0 seconds" },
        verifier_result: { rewards: { reward: 0 } }
      })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(trialDir, "agent", "trace.jsonl"),
      [
        JSON.stringify({ type: "usage", metadata: { usage: { inputTokens: 10, outputTokens: 3, cacheTokens: 1 } } }),
        JSON.stringify({ type: "tool_end", metadata: { toolName: "bash", result: { metadata: {} } } }),
        JSON.stringify({
          type: "run_end",
          metadata: {
            result: {
              status: "stopped",
              finishReason: "max_wall_time",
              commandsExecuted: 2,
              usage: { inputTokens: 20, outputTokens: 5, cacheTokens: 1 },
              durationMs: 1234,
              lastError: "wall time"
            }
          }
        }),
        ""
      ].join("\n"),
      "utf8"
    );

    const report = await generateBenchReport(runDir);

    expect(report.tasks[0]).toMatchObject({
      task_id: "terminal-bench/task-a",
      trace_path: "harbor-jobs/job-1/trial-1/agent/trace.jsonl",
      commands_executed: 2,
      input_tokens: 20,
      output_tokens: 5,
      duration_ms: 1234,
      failure_category: "agent_timeout"
    });
  });
});
