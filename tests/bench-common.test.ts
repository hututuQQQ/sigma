import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertUniqueHarborTaskExecutionIdentities,
  buildResolvedTaskAttestationV2,
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
  groupHarborTimeoutProbe,
  assertComparableBenchmarkReports,
  harborEnvForRun,
  harborTaskExecutionIdentitySha256,
  harborRuntimeDir,
  parseHarborTimeoutProbe,
  portableAgentImportPath,
  projectHarborTaskConfig,
  readTaskSelectionFile,
  removedHarborAdapterErrorMessage,
  removedHarborPackageName,
  resolveHarborCommand,
  resolveRunOptions,
  suggestedOwnerForFailureCategory,
  taskSelectionIdentitySha256,
  terminalBenchDataset
} from "../scripts/bench-common.mjs";

async function writeHarborJobResult(jobDir: string, total: number, errored = 0, retries = 0) {
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(jobDir, "result.json"), `${JSON.stringify({
    n_total_trials: total,
    stats: {
      n_completed_trials: total,
      n_errored_trials: errored,
      n_retries: retries
    }
  })}\n`, "utf8");
}

describe("Terminal-Bench command construction", () => {
  it("loads an exact pinned external task batch without losing Git provenance", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-batch-tasks-"));
    const tasksFile = path.join(directory, "tasks.json");
    await writeFile(tasksFile, `${JSON.stringify([
      {
        path: "tasks/one",
        git_url: "https://example.test/tasks.git",
        git_commit_id: "a".repeat(40)
      },
      { name: "registry/task-two" }
    ])}\n`, "utf8");

    const options = resolveRunOptions(["--mode", "batch", "--tasks-file", tasksFile]);
    const config = buildHarborJobConfig(options, "jobs");

    expect(options.tasksFileSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(config.tasks).toEqual([
      {
        path: "tasks/one",
        git_url: "https://example.test/tasks.git",
        git_commit_id: "a".repeat(40)
      },
      { name: "registry/task-two" }
    ]);
    expect(config.environment).toMatchObject({
      type: "docker",
      extra_docker_compose: [expect.stringMatching(/docker-compose-sigma-sandbox\.yaml$/u)]
    });
  });

  it("keeps Git task paths repository-relative and host-independent", async () => {
    const left = await mkdtemp(path.join(os.tmpdir(), "sigma-git-task-left-"));
    const right = await mkdtemp(path.join(os.tmpdir(), "sigma-git-task-right-"));
    const task = {
      path: "nested/task-one",
      git_url: "https://EXAMPLE.test/tasks.git/",
      git_commit_id: "a".repeat(40),
      provenance_source: "frozen"
    };
    const leftFile = path.join(left, "tasks.json");
    const rightFile = path.join(right, "tasks.json");
    await writeFile(leftFile, `${JSON.stringify([task])}\n`, "utf8");
    await writeFile(rightFile, `${JSON.stringify([task])}\n`, "utf8");
    try {
      const [leftTask] = readTaskSelectionFile(leftFile);
      const [rightTask] = readTaskSelectionFile(rightFile);
      expect(leftTask.path).toBe("nested/task-one");
      expect(rightTask.path).toBe("nested/task-one");
      expect(harborTaskExecutionIdentitySha256(leftTask)).toBe(
        harborTaskExecutionIdentitySha256(rightTask)
      );
    } finally {
      await rm(left, { recursive: true, force: true });
      await rm(right, { recursive: true, force: true });
    }
  });

  it("rejects unsafe Git locations before Harbor task resolution", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-git-task-invalid-"));
    const tasksFile = path.join(directory, "tasks.json");
    try {
      for (const record of [
        { path: "../task", git_url: "https://example.test/tasks.git", git_commit_id: "a".repeat(40) },
        { path: "C:/task", git_url: "https://example.test/tasks.git", git_commit_id: "a".repeat(40) },
        { path: "task", git_url: "https://user:secret@example.test/tasks.git", git_commit_id: "a".repeat(40) },
        { path: "task", git_url: "https://example.test/tasks.git?token=secret", git_commit_id: "a".repeat(40) }
      ]) {
        await writeFile(tasksFile, `${JSON.stringify([record])}\n`, "utf8");
        expect(() => readTaskSelectionFile(tasksFile)).toThrow(/Git task/u);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires a frozen archive digest when reusing a package", () => {
    expect(() => resolveRunOptions([
      "--mode", "task", "--task-id", "one", "--reuse-package"
    ])).toThrow("--reuse-package requires --expected-archive-sha256");
  });

  it("separates provenance from source-free Harbor execution identity", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-task-provenance-"));
    const tasksFile = path.join(directory, "tasks.json");
    await writeFile(tasksFile, `${JSON.stringify([{
      name: "registry/task-one",
      source: "legacy-catalog"
    }])}\n`, "utf8");

    const [task] = readTaskSelectionFile(tasksFile);
    expect(task).toMatchObject({ name: "registry/task-one", provenance_source: "legacy-catalog" });
    expect(projectHarborTaskConfig({ ...task, untrusted: "ignored" })).toEqual({ name: "registry/task-one" });
    expect(buildHarborJobConfig({ mode: "batch", tasks: [task] }, "jobs").tasks).toEqual([
      { name: "registry/task-one" }
    ]);
    expect(taskSelectionIdentitySha256(task)).not.toBe(harborTaskExecutionIdentitySha256(task));

    const attestation = buildResolvedTaskAttestationV2({
      jobConfigSha256: "a".repeat(64),
      taskSelectionSha256: "b".repeat(64),
      selectedTasks: [task],
      resolvedTasks: [{ name: "registry/task-one" }]
    });
    expect(attestation).toMatchObject({
      schema_version: 2,
      job_config_sha256: "a".repeat(64),
      task_selection_sha256: "b".repeat(64),
      tasks: [{ selection_identity: { provenance_source: "legacy-catalog" } }]
    });
  });

  it("rejects conflicting provenance aliases and duplicate execution identities", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-task-provenance-conflict-"));
    const tasksFile = path.join(directory, "tasks.json");
    await writeFile(tasksFile, `${JSON.stringify([{
      name: "registry/task-one",
      source: "catalog-a",
      provenance_source: "catalog-b"
    }])}\n`, "utf8");
    expect(() => readTaskSelectionFile(tasksFile)).toThrow(/source and provenance_source conflict/u);
    expect(() => assertUniqueHarborTaskExecutionIdentities([
      { name: "registry/task-one", provenance_source: "a" },
      { name: "registry/task-one", provenance_source: "b" }
    ])).toThrow(/duplicate Harbor execution identities/u);
  });

  it("rejects comparisons across agent profiles and evaluation lanes", () => {
    expect(() => assertComparableBenchmarkReports(
      { agent_profile: "standard", evaluation_lane: "solving" },
      { agent_profile: "strict", evaluation_lane: "strict_conformance" }
    )).toThrow(/different agent profiles/iu);
    expect(() => assertComparableBenchmarkReports(
      { tasks: [{ agent_profile: "standard" }], evaluation_lane: "solving" },
      { agent_profile: "standard", evaluation_lane: "solving" }
    )).not.toThrow();
  });

  it("propagates the run-level network mode into Harbor agent configuration", () => {
    const options = resolveRunOptions(["--mode", "task", "--task-id", "generic-task", "--network", "full"]);
    expect(options.networkMode).toBe("full");
    expect(buildHarborArgs({
      ...options,
      taskSelectionFlag: "--task-id",
      timeoutPlan: { agent_wall_time_sec: 60, effective_harness_timeout_sec: 180, agent_timeout_multiplier: "1" }
    })).toEqual(expect.arrayContaining([
      "network_mode:str=full",
      "execution_mode:str=sandboxed",
      "agent_profile:str=standard"
    ]));
    expect(buildHarborJobConfig(options, "jobs").agents[0].kwargs).toMatchObject({
      network_mode: "full",
      execution_mode: "sandboxed",
      agent_profile: "standard"
    });
  });

  it("accepts loopback without promoting it to full network", () => {
    const options = resolveRunOptions([
      "--mode", "task", "--task-id", "generic-task", "--network", "loopback"
    ]);
    expect(options.networkMode).toBe("loopback");
    expect(buildHarborJobConfig(options, "jobs").agents[0].kwargs).toMatchObject({
      network_mode: "loopback",
      execution_mode: "sandboxed"
    });
  });

  it("makes the managed three-role topology an explicit reachable run control", () => {
    const options = resolveRunOptions([
      "--mode", "task", "--task-id", "generic-task",
      "--network", "full",
      "--execution-mode", "container",
      "--managed-environment-mode", "required",
      "--harbor-topology", "managed_three_role",
      "--max-turns", "73",
      "--command-timeout-sec", "41",
      "--agent-timeout-grace-sec", "17"
    ]);
    expect(options).toMatchObject({
      networkMode: "full",
      executionMode: "container",
      managedEnvironmentMode: "required",
      harborTopology: "managed_three_role",
      maxTurns: 73,
      commandTimeoutSec: 41,
      agentTimeoutGraceSec: 17
    });
    expect(buildHarborJobConfig(options, "jobs").agents[0].kwargs).toMatchObject({
      network_mode: "full",
      execution_mode: "container",
      managed_environment_mode: "required",
      harbor_topology: "managed_three_role"
    });
    expect(buildHarborArgs({
      ...options,
      taskSelectionFlag: "--task-id",
      timeoutPlan: { agent_wall_time_sec: 60, effective_harness_timeout_sec: 180 }
    })).toEqual(expect.arrayContaining([
      "managed_environment_mode:str=required",
      "harbor_topology:str=managed_three_role"
    ]));

    expect(() => resolveRunOptions([
      "--mode", "task", "--task-id", "generic-task",
      "--managed-environment-mode", "required"
    ])).toThrow(/execution-mode container/iu);
    expect(() => resolveRunOptions([
      "--mode", "task", "--task-id", "generic-task",
      "--harbor-topology", "managed_three_role"
    ])).toThrow(/managed environment mode required/iu);
    for (const invalid of [
      ["--execution-mode", "sandboxed", "--network", "full", "--harbor-topology", "managed_three_role"],
      ["--execution-mode", "container", "--network", "none", "--harbor-topology", "managed_three_role"],
      ["--execution-mode", "container", "--network", "full", "--harbor-topology", "main_only"]
    ]) {
      expect(() => resolveRunOptions([
        "--mode", "task", "--task-id", "generic-task",
        "--managed-environment-mode", "required",
        ...invalid
      ])).toThrow(/managed environment mode required/iu);
    }
  });

  it("keeps the full task timeout for solving and reserves cleanup outside it", () => {
    const standard = resolveRunOptions(["--mode", "task", "--task-id", "generic-task"]);
    const standardPlan = computeHarborTimeoutPlan(standard, { max_agent_timeout_sec: 900 });
    const config = buildHarborJobConfig(standard, "jobs", standardPlan);
    expect(standard).toMatchObject({
      benchmarkClass: "standard", executionMode: "sandboxed", agentProfile: "standard"
    });
    expect(standardPlan).toMatchObject({
      agent_wall_time_sec: 900,
      harness_timeout_sec: 1020,
      benchmark_class: "standard",
      agent_timeout_multiplier: "1.14",
      verifier_timeout_multiplier: null,
      environment_build_timeout_multiplier: null
    });
    expect(config.agent_timeout_multiplier).toBe(1.14);
    expect(config.agents[0].kwargs.execution_mode).toBe("sandboxed");
    expect(config.agents[0].kwargs.agent_profile).toBe("standard");

    expect(resolveRunOptions([
      "--mode", "task", "--task-id", "generic-task", "--execution-mode", "sandboxed",
      "--agent-profile", "strict"
    ])).toMatchObject({ executionMode: "sandboxed", agentProfile: "strict" });

    const diagnostic = resolveRunOptions([
      "--mode", "task", "--task-id", "generic-task",
      "--benchmark-class", "diagnostic",
      "--timeout-leniency-multiplier", "2"
    ]);
    expect(computeHarborTimeoutPlan(diagnostic, { max_agent_timeout_sec: 900 }))
      .toMatchObject({ benchmark_class: "diagnostic", agent_timeout_multiplier: "2.14" });
    expect(() => resolveRunOptions([
      "--mode", "task", "--task-id", "generic-task",
      "--timeout-leniency-multiplier", "2"
    ])).toThrow(/diagnostic/u);
  });

  it("can bind formal agent wall time exactly to task metadata", () => {
    const options = resolveRunOptions([
      "--mode", "task", "--task-id", "one",
      "--timeout-leniency-multiplier", "1", "--timeout-leniency-min-extra-sec", "0"
    ]);
    expect(computeHarborTimeoutPlan(options, { max_agent_timeout_sec: 900 })).toMatchObject({
      recommended_agent_timeout_sec: 900,
      agent_wall_time_sec: 900,
      harness_timeout_sec: 1020,
      leniency_multiplier: 1,
      leniency_min_extra_sec: 0,
      agent_timeout_multiplier: "1.14",
      benchmark_class: "standard"
    });
  });

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
      "agent_profile:str=standard",
      "--ak",
      "model:str=deepseek-v4-pro",
      "--ak",
      "max_turns:int=200",
      "--ak",
      "command_timeout_sec:int=180",
      "--ak",
      "max_wall_time_sec:int=7200",
      "--ak",
      "harness_timeout_sec:int=7320"
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
      "4.07",
      "--ak",
      `agent_cli_tarball=${defaultAgentCliTarballForEnv()}`,
      "--ak",
      "provider=glm",
      "--ak",
      "agent_profile=standard",
      "--ak",
      "model=glm-5.2",
      "--ak",
      "max_turns=200",
      "--ak",
      "command_timeout_sec=180",
      "--ak",
      "max_wall_time_sec=7200",
      "--ak",
      "harness_timeout_sec=7320"
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
      tasks: [{ task_name: "terminal-bench/long-runtime-task", agent_timeout_sec: 1800 }],
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
      harness_timeout_sec: 2820,
      effective_harness_timeout_sec: 2820,
      agent_timeout_multiplier: "1.57",
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

  it("uses Harbor per-trial deadlines for heterogeneous timeout batches", () => {
    const timeoutProbe = {
      tasks: [
        { agent_timeout_sec: 900 },
        { agent_timeout_sec: 1200 }
      ],
      max_agent_timeout_sec: 1200
    };
    const plan = computeHarborTimeoutPlan({ benchmarkClass: "standard", agentTimeoutGraceSec: 120 }, timeoutProbe);

    expect(plan).toMatchObject({
      requested_agent_wall_time_sec: 1200,
      agent_wall_time_sec: 1200,
      child_deadline_sec: 1200,
      outer_trial_deadline_sec: null,
      outer_trial_deadline_scope: "harbor_per_trial",
      deadline_cleanup_grace_sec: 120,
      deadline_clamped: false
    });
    const kwargs = buildHarborJobConfig({
      mode: "k", k: 2, provider: "deepseek", model: "deepseek-v4-pro", agentTimeoutGraceSec: 120
    }, "jobs", plan, timeoutProbe).agents[0].kwargs;
    expect(kwargs).toMatchObject({ max_wall_time_sec: 1200 });
    expect(kwargs).not.toHaveProperty("outer_trial_deadline_sec");
  });

  it("groups heterogeneous trials so each runtime receives its real deadline", () => {
    const groups = groupHarborTimeoutProbe({
      tasks: [
        { task_name: "terminal-bench/short-a", agent_timeout_sec: 900, verifier_timeout_sec: 900 },
        { task_name: "terminal-bench/long", agent_timeout_sec: 3600, verifier_timeout_sec: 3600 },
        { task_name: "terminal-bench/short-b", agent_timeout_sec: 900, verifier_timeout_sec: 900 }
      ],
      resolved_tasks: [
        { name: "terminal-bench/short-a" },
        { name: "terminal-bench/long" },
        { name: "terminal-bench/short-b" }
      ]
    });

    expect(groups.map((group) => ({
      timeout: group.agent_timeout_sec,
      tasks: group.tasks.map((task) => task.task_name),
      plan: computeHarborTimeoutPlan(
        { benchmarkClass: "standard", agentTimeoutGraceSec: 120 }, group.timeout_probe
      ).agent_wall_time_sec
    }))).toEqual([
      { timeout: 900, tasks: ["terminal-bench/short-a", "terminal-bench/short-b"], plan: 900 },
      { timeout: 3600, tasks: ["terminal-bench/long"], plan: 3600 }
    ]);
  });

  it("injects an exact outer deadline only when all task timeouts are uniform", () => {
    const timeoutProbe = {
      tasks: [{ agent_timeout_sec: 900 }, { agent_timeout_sec: 900 }],
      max_agent_timeout_sec: 900
    };
    const plan = computeHarborTimeoutPlan(
      { benchmarkClass: "standard", agentTimeoutGraceSec: 120 },
      timeoutProbe
    );

    expect(plan).toMatchObject({
      agent_wall_time_sec: 900,
      outer_trial_deadline_sec: 1020,
      outer_trial_deadline_scope: "uniform_task_timeout",
      deadline_cleanup_grace_sec: 120
    });
    expect(plan.agent_wall_time_sec).toBe(plan.outer_trial_deadline_sec - plan.deadline_cleanup_grace_sec);
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
      harness_timeout_sec: 9120,
      agent_timeout_multiplier: "1.52",
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
      harness_timeout_sec: 6120,
      agent_timeout_multiplier: "3.4",
      source: "explicit_max_wall_time"
    });
  });

  it("builds a Harbor timeout probe config for the selected task", () => {
    expect(
      buildHarborTimeoutProbeConfig(
        {
          mode: "task",
          taskId: "selected-task",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          maxTurns: 200,
          commandTimeoutSec: 180
        },
        "probe-jobs"
      )
    ).toMatchObject({
      jobs_dir: "probe-jobs",
      tasks: [{ name: "terminal-bench/selected-task" }]
    });
  });

  it("parses Harbor timeout probe JSON from stdout", () => {
    expect(parseHarborTimeoutProbe('noise\n{"max_agent_timeout_sec":1800,"tasks":[]}\n')).toEqual({
      max_agent_timeout_sec: 1800,
      tasks: []
    });
  });

  it("normalizes only probe-derived Git task paths at the platform boundary", () => {
    const gitCommit = "a".repeat(40);
    const parsed = parseHarborTimeoutProbe(JSON.stringify({
      resolved_tasks: [{
        path: "tasks\\portable-task",
        git_url: "https://example.test/tasks.git",
        git_commit_id: gitCommit
      }]
    }));
    expect(parsed.resolved_tasks[0].path).toBe("tasks/portable-task");
    expect(projectHarborTaskConfig(parsed.resolved_tasks[0])).toMatchObject({
      path: "tasks/portable-task"
    });
    expect(() => projectHarborTaskConfig({
      path: "tasks\\external-task",
      git_url: "https://example.test/tasks.git",
      git_commit_id: gitCommit
    })).toThrow(/portable repository-relative path/u);
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

  it("builds resolved JobConfig without task-specific prechecks", () => {
    const timeoutProbe = {
      resolved_tasks: [{ name: "terminal-bench/long-runtime-task" }],
      tasks: [{ task_name: "terminal-bench/long-runtime-task", agent_timeout_sec: 1800 }],
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
    expect(config.tasks).toEqual([{ name: "terminal-bench/long-runtime-task" }]);
    expect(config.agent_timeout_multiplier).toBe(1.57);
    expect(config.agents[0].name).toBe(portableAgentImportPath);
    expect(path.isAbsolute(config.agents[0].kwargs.agent_cli_tarball)).toBe(true);
    expect(config.agents[0].kwargs).toMatchObject({
      agent_cli_tarball: defaultAgentCliTarballForEnv(),
      max_wall_time_sec: 2700
    });
    expect(config.agents[0].kwargs.max_turns).toBeUndefined();
    expect(config.agents[0].kwargs.validation_retry_limit).toBeUndefined();
    expect(config.agents[0].kwargs.precheck_command).toBeUndefined();
    expect(config.agents[0].kwargs.post_run_cleanup_globs).toBeUndefined();
  });

  it("keeps external timeout planning out of solver kwargs", () => {
    const timeoutProbe = {
      resolved_tasks: [{ name: "terminal-bench/ordinary-task" }],
      tasks: [{ task_name: "terminal-bench/ordinary-task", agent_timeout_sec: 1800 }],
      max_agent_timeout_sec: 1800
    };
    const timeoutPlan = computeHarborTimeoutPlan({ agentTimeoutGraceSec: 120 }, timeoutProbe);
    const config = buildHarborJobConfig(
      {
        mode: "task",
        taskId: "ordinary-task",
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
      harness_timeout_sec: 2820
    });
    expect(config.agents[0].kwargs).toMatchObject({
      agent_cli_tarball: defaultAgentCliTarballForEnv(),
      max_wall_time_sec: 2700
    });
    expect(config.agents[0].kwargs.validation_mode).toBeUndefined();
    expect(config.agents[0].kwargs.precheck_command).toBeUndefined();
  });

  it("does not expose removed validation or retry controls", () => {
    const timeoutProbe = {
      resolved_tasks: [{ name: "terminal-bench/ordinary-task" }],
      tasks: [{ task_name: "terminal-bench/ordinary-task", agent_timeout_sec: 1800 }],
      max_agent_timeout_sec: 1800
    };

    const plan = computeHarborTimeoutPlan({
      agentTimeoutGraceSec: 120,
      validationRetryLimit: 99,
      validationMode: "auto",
      precheckTimeoutSec: 999
    }, timeoutProbe);
    expect(plan).not.toHaveProperty("validation_retry_limit");
    expect(plan).not.toHaveProperty("validation_mode");
    expect(plan).not.toHaveProperty("precheck_timeout_sec");
    expect(plan).toMatchObject({ agent_wall_time_sec: 2700, harness_timeout_sec: 2820 });
  });

  it("does not expose fixed turn limits to the solver", () => {
    const timeoutProbe = {
      resolved_tasks: [{ name: "terminal-bench/long-runtime-task" }],
      tasks: [{ task_name: "terminal-bench/long-runtime-task", agent_timeout_sec: 1800 }],
      max_agent_timeout_sec: 1800
    };
    const timeoutPlan = computeHarborTimeoutPlan({ agentTimeoutGraceSec: 120 }, timeoutProbe);
    const config = buildHarborJobConfig(
      {
        mode: "task",
        taskId: "long-runtime-task",
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

    expect(config.agents[0].kwargs.max_turns).toBeUndefined();
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
    expect(portableEnv.PYTHONDONTWRITEBYTECODE).toBe("1");
    expect(portableEnv.PYTHONPYCACHEPREFIX).toContain(path.join("runtime-scratch", "pycache"));
  });

  it("rejects removed Harbor import paths before building run env", () => {
    expect(() =>
      harborEnvForRun("run-dir", {
        SIGMA_HARBOR_AGENT_IMPORT_PATH: `${removedHarborPackageName}.agent:RemovedAgent`
      })
    ).toThrow(removedHarborAdapterErrorMessage);
  });

  it("writes portable command scripts without the removed integration import path", () => {
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
    expect(classifyFailure({ summary: { finish_reason: "max_wall_time" } })).toBe("agent_timeout");
    expect(classifyFailure({ summary: { status: "error" }, exitCode: 1 })).toBe("agent_crashed");
  });

  it("honors explicit runtime failure kinds without conflating their owners", () => {
    expect(classifyFailure({ failureKind: "needs_input" })).toBe("needs_input");
    expect(classifyFailure({ failureKind: "timeout" })).toBe("timeout");
    expect(classifyFailure({ failureKind: "tool_error" })).toBe("tool_error");
    expect(classifyFailure({ failureKind: "api_error" })).toBe("api_error");
    expect(classifyFailure({ failureKind: "verifier_failure" })).toBe("verifier_failure");
    expect(classifyFailure({ failureKind: "structured_blocker" })).toBe("structured_blocker");
    expect(classifyFailure({ logText: "the final message says blocked", exitCode: 1 })).toBe("agent_crashed");
  });

  it("maps failure categories to suggested owners", () => {
    expect(suggestedOwnerForFailureCategory("host_proxy_error")).toBe("environment");
    expect(suggestedOwnerForFailureCategory("host_encoding_error")).toBe("environment");
    expect(suggestedOwnerForFailureCategory("harbor_cli_error")).toBe("scripts/bench");
    expect(suggestedOwnerForFailureCategory("node_missing")).toBe("package-agent-cli");
    expect(suggestedOwnerForFailureCategory("agent_setup_failed")).toBe("portable/harbor");
    expect(suggestedOwnerForFailureCategory("api_error")).toBe("agent-model");
    expect(suggestedOwnerForFailureCategory("agent_timeout")).toBe("agent-runtime");
    expect(suggestedOwnerForFailureCategory("max_turns")).toBe("agent-runtime");
    expect(suggestedOwnerForFailureCategory("tool_timeout")).toBe("agent-tools");
    expect(suggestedOwnerForFailureCategory("verifier_failed")).toBe("agent-runtime");
    expect(suggestedOwnerForFailureCategory("agent_crashed")).toBe("agent-runtime");
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
          suggested_owner: "agent-runtime",
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

    expect(markdown).toContain("| task | status | failure_category | suggested_owner | warnings | verifier_status | failure_signals |");
    expect(markdown).toContain(
      "| terminal-bench/task-a | failed | verifier_failed | agent-runtime | 0 |  | agent_completed_but_verifier_failed |"
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
          agent_profile: "standard",
          evaluation_lane: "solving",
          timeout_probe: { tasks: [
            { task_name: "passed-task", agent_timeout_sec: 900 },
            { task_name: "api-task", agent_timeout_sec: 3600 }
          ] },
          timeout_groups: [
            { task_names: ["passed-task"], timeout_plan: { agent_wall_time_sec: 780 } },
            { task_names: ["api-task"], timeout_plan: { agent_wall_time_sec: 3480 } }
          ],
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
      '{"status":"completed","finish_reason":"assistant_stop","commands_executed":3,"input_tokens":10,"cache_tokens":8,"cache_read_tokens":8,"output_tokens":5,"reasoning_tokens":4,"length_finish_count":1,"converge_turns":2,"duration_ms":1000,"last_error":null}\n',
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
    expect(report.tasks.find((task) => task.task_id === "api-task")?.suggested_owner).toBe("agent-model");
    expect(report).toMatchObject({
      reasoning_tokens: 4,
      agent_profile: "standard",
      evaluation_lane: "solving",
      cache_read_ratio: 8 / 22,
      reasoning_output_ratio: 4 / 6,
      length_finish_count: 1,
      converge_turns: 2,
      usage: { reasoning_tokens: 4, cache_read_tokens: 8 }
    });
    expect(report.lane_metrics).toMatchObject({ verifier_reached: 0, verifier_passed: 0 });
    const markdown = await readFile(path.join(runDir, "report.md"), "utf8");
    const jsonReport = JSON.parse(await readFile(path.join(runDir, "report.json"), "utf8"));
    expect(markdown).toContain("# Terminal-Bench Run synthetic-run");
    expect(markdown).toContain("| task | status | failure_category | suggested_owner |");
    expect(jsonReport.counts.api_error).toBe(1);
    expect(jsonReport.tasks.find((task) => task.task_id === "passed-task")).toMatchObject({
      harbor_deadline_sec: 900, sigma_deadline_sec: 780
    });
    expect(markdown).toContain("Evaluation lane: solving");
    expect(jsonReport.tasks.find((task) => task.task_id === "api-task")?.suggested_owner).toBe("agent-model");
  });

  it("reports an authorized structured blocker as valid without calling it a crash", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "sigma-bench-blocker-"));
    const slot = "slot-blocked";
    const trialDir = path.join(runDir, "harbor-jobs", slot, "job-1", "trial-1");
    const taskDir = path.join(runDir, "tasks", slot);
    await writeFile(path.join(runDir, "config.json"), `${JSON.stringify({
      run_id: "structured-blocker-run",
      started_at: "2026-07-06T00:00:00.000Z",
      finished_at: "2026-07-06T00:01:00.000Z",
      provider: "deepseek",
      model: "model",
      mode: "batch",
      exit_code: 1,
      status: "failed",
      resolved_job_config_path: "resolved-job.config.json",
      run_slots: [{
        run_slot: slot,
        harbor_task_identity: { kind: "name", name: "registry/task-one" },
        provenance_source: "selection",
        selection_identity: { execution: { kind: "name", name: "registry/task-one" } }
      }]
    })}\n`, "utf8");
    await writeFile(path.join(runDir, "resolved-job.config.json"), `${JSON.stringify({
      n_concurrent_trials: 1,
      tasks: [{ name: "registry/task-one" }]
    })}\n`, "utf8");
    for (const name of ["harbor.stdout.log", "harbor.stderr.log", "result.raw.log"]) {
      await writeFile(path.join(runDir, name), "", "utf8");
    }
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(taskDir, "metadata.json"), `${JSON.stringify({
      task_id: "registry/task-one",
      run_slot: slot,
      exit_code: 1,
      failure_kind: "structured_blocker",
      failure_code: "dependency_unavailable"
    })}\n`, "utf8");
    await writeFile(path.join(taskDir, "summary.json"), `${JSON.stringify({
      status: "error",
      failure_kind: "structured_blocker",
      failure_code: "dependency_unavailable",
      last_error: "Dependency recovery was exhausted."
    })}\n`, "utf8");
    await mkdir(trialDir, { recursive: true });
    await writeFile(path.join(trialDir, "result.json"), `${JSON.stringify({
      trial_name: "trial-1",
      task_name: "registry/task-one",
      exception_info: { exception_message: "structured_blocker: Dependency recovery was exhausted." },
      agent_result: { metadata: {
        exit_code: 1,
        failure_kind: "structured_blocker",
        failure_code: "dependency_unavailable"
      } }
    })}\n`, "utf8");
    await writeHarborJobResult(path.dirname(trialDir), 1, 1, 0);

    const report = await generateBenchReport(runDir);

    expect(report.incomplete_reason).toBeNull();
    expect(report.counts.structured_blocker).toBe(1);
    expect(report.tasks[0]).toMatchObject({
      failure_category: "structured_blocker",
      failure_code: "dependency_unavailable",
      agent_outcome: "blocked",
      verifier_outcome: "not_run",
      validity: "valid",
      provenance_source: "selection",
      agent_exception: null
    });

    await writeFile(path.join(trialDir, "result.json"), `${JSON.stringify({
      trial_name: "trial-1",
      task_name: "registry/different-task",
      agent_result: { metadata: { exit_code: 1, failure_kind: "structured_blocker" } }
    })}\n`, "utf8");
    const mismatched = await generateBenchReport(runDir);
    expect(mismatched.status).toBe("incomplete");
    expect(mismatched.incomplete_reason?.join("\n")).toMatch(/identity does not match run slot/u);
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

    const trialDir = path.join(runDir, "harbor-jobs", "job-1", "trial-1");
    const taskDir = path.join(runDir, "tasks", "task-a");
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(taskDir, "metadata.json"), `${JSON.stringify({
      task_id: "task-a", status: "passed", source_logs_dir: path.join(trialDir, "agent")
    })}\n`, "utf8");
    await writeFile(
      path.join(taskDir, "summary.json"),
      '{"status":"completed","finish_reason":"assistant_stop","commands_executed":2,"input_tokens":3,"output_tokens":4,"duration_ms":5,"last_error":null}\n',
      "utf8"
    );

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
    await writeHarborJobResult(path.dirname(trialDir), 1);
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

  it("excludes verifier setup failures from effective correctness", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "sigma-bench-verifier-infra-"));
    await writeFile(path.join(runDir, "config.json"), `${JSON.stringify({
      run_id: "verifier-infra-run", provider: "deepseek", model: "deepseek-v4-pro",
      dataset: terminalBenchDataset, k: 1, command_text: "harbor run -l 1",
      exit_code: 0, status: "passed"
    })}\n`, "utf8");
    for (const name of ["harbor.stdout.log", "harbor.stderr.log", "result.raw.log"]) {
      await writeFile(path.join(runDir, name), "", "utf8");
    }
    const trialDir = path.join(runDir, "harbor-jobs", "job-1", "trial-1");
    const taskDir = path.join(runDir, "tasks", "task-a");
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(taskDir, "metadata.json"), `${JSON.stringify({
      task_id: "task-a", status: "passed", source_logs_dir: path.join(trialDir, "agent")
    })}\n`, "utf8");
    await writeFile(path.join(taskDir, "summary.json"), JSON.stringify({
      status: "completed", commands_executed: 2, input_tokens: 3, output_tokens: 4
    }), "utf8");
    await mkdir(path.join(trialDir, "verifier"), { recursive: true });
    await writeFile(path.join(trialDir, "result.json"), `${JSON.stringify({
      trial_name: "trial-1", task_name: "terminal-bench/task-a",
      verifier_result: { rewards: { reward: 0 } }, exception_info: null
    })}\n`, "utf8");
    await writeFile(path.join(trialDir, "verifier", "test-stdout.txt"), [
      "E: Failed to fetch http://deb.example/pkg 502 Bad Gateway",
      "/tests/test.sh: line 8: curl: command not found"
    ].join("\n"), "utf8");
    await writeHarborJobResult(path.dirname(trialDir), 1);

    const report = await generateBenchReport(runDir);

    expect(report.tasks[0]).toMatchObject({
      status: "infra_failed",
      failure_category: "verifier_setup_failed",
      agent_outcome: "completed",
      verifier_outcome: "infra_failed",
      validity: "infra_failed"
    });
    expect(report.counts.infra_failed).toBe(1);
    expect(report.validity).toEqual({ valid: 0, infra_failed: 1 });
    expect(report.effective_correctness).toEqual({ passed: 0, total: 0, pass_rate: null });
  });

  it("keeps reward=1 tasks passed when Harbor also reports an agent exception", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "sigma-bench-harbor-warning-"));
    await writeFile(
      path.join(runDir, "config.json"),
      `${JSON.stringify({
        run_id: "harbor-warning-run",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        dataset: terminalBenchDataset,
        k: 1,
        command_text: "harbor run -l 1",
        exit_code: 1,
        status: "failed"
      })}\n`,
      "utf8"
    );
    await writeFile(path.join(runDir, "harbor.stdout.log"), "", "utf8");
    await writeFile(path.join(runDir, "harbor.stderr.log"), "", "utf8");
    await writeFile(path.join(runDir, "result.raw.log"), "exit_code: 1\n", "utf8");

    const trialDir = path.join(runDir, "harbor-jobs", "job-1", "trial-1");
    const taskDir = path.join(runDir, "tasks", "task-a");
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(taskDir, "metadata.json"), `${JSON.stringify({
      task_id: "task-a", status: "failed", source_logs_dir: path.join(trialDir, "agent")
    })}\n`, "utf8");
    await writeFile(
      path.join(taskDir, "summary.json"),
      '{"status":"completed","finish_reason":"assistant_stop","commands_executed":2,"input_tokens":3,"output_tokens":4,"duration_ms":5,"last_error":null}\n',
      "utf8"
    );

    await mkdir(trialDir, { recursive: true });
    await writeFile(
      path.join(trialDir, "result.json"),
      `${JSON.stringify({
        trial_name: "trial-1",
        task_name: "terminal-bench/task-a",
        verifier_result: { rewards: { reward: 1.0 } },
        exception_info: { exception_message: "AgentTimeoutError after verifier pass" }
      })}\n`,
      "utf8"
    );
    await writeHarborJobResult(path.dirname(trialDir), 1, 1);

    const report = await generateBenchReport(runDir);

    expect(report.status).toBe("passed");
    expect(report.score_status).toBe("passed");
    expect(report.infra_status).toBe("warning");
    expect(report.exit_code).toBe(1);
    expect(report.harbor_exit_code).toBe(1);
    expect(report.counts.passed).toBe(1);
    expect(report.tasks[0]).toMatchObject({
      status: "passed",
      failure_category: null,
      verifier_status: "passed",
      infra_warnings: ["agent_exception_after_verifier_pass"],
      agent_exception: { message: "AgentTimeoutError after verifier pass" }
    });
    const markdown = await readFile(path.join(runDir, "report.md"), "utf8");
    expect(markdown).toContain("- Infra status: warning");
    expect(markdown).toContain("- Harbor exit code: 1");
    expect(markdown).toContain("## Infra Warnings");
  });

  it("uses Harbor trial results as authority independent of mirrored artifact order", async () => {
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

    const taskDir = path.join(runDir, "tasks", "python-module-task");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      path.join(taskDir, "metadata.json"),
      `${JSON.stringify({
        task_id: "terminal-bench/python-module-task",
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

  it("reports precheck and max wall time signals without artifact-specific defaults", async () => {
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
          effective_harness_timeout_sec: 5610
        }
      })}\n`,
      "utf8"
    );
    await writeFile(path.join(runDir, "harbor.stdout.log"), "", "utf8");
    await writeFile(path.join(runDir, "harbor.stderr.log"), "", "utf8");
    await writeFile(path.join(runDir, "result.raw.log"), "exit_code: 1\n", "utf8");

    const trialDir = path.join(runDir, "harbor-jobs", "job-1", "trial-1");
    const taskDir = path.join(runDir, "tasks", "artifact-task");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      path.join(taskDir, "metadata.json"),
      `${JSON.stringify({
        task_id: "terminal-bench/artifact-task",
        status: "failed",
        source_logs_dir: path.join(trialDir, "agent"),
        failure_signals: ["precheck_failed"],
        precheck_results: [{ exit_code: 1, message: "File /tmp/output.dat does not exist" }]
      })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(taskDir, "summary.json"),
      '{"status":"stopped","finish_reason":"max_wall_time","commands_executed":2,"duration_ms":2700000,"last_error":"wall time"}\n',
      "utf8"
    );

    await mkdir(trialDir, { recursive: true });
    await writeFile(
      path.join(trialDir, "result.json"),
      `${JSON.stringify({
        trial_name: "trial-1",
        task_name: "terminal-bench/artifact-task",
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
              name: "artifact_exists",
              status: "failed",
              message: "File /tmp/output.dat does not exist",
              trace: "assert artifact_path.exists()"
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
      expect.arrayContaining(["precheck_failed", "max_wall_time"])
    );
    expect(report.tasks[0].failure_signals.some((signal) => signal.startsWith("missing_artifact:"))).toBe(false);
    expect(markdown).not.toContain("missing_artifact:");
    expect(markdown).toContain("Effective harness timeout sec: 5610");
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
        exit_code: 0,
        status: "passed"
      })}\n`,
      "utf8"
    );
    await writeFile(path.join(runDir, "harbor.stdout.log"), "", "utf8");
    await writeFile(path.join(runDir, "harbor.stderr.log"), "", "utf8");
    await writeFile(path.join(runDir, "result.raw.log"), "exit_code: 0\n", "utf8");

    const taskDir = path.join(runDir, "tasks", "validation-task");
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(taskDir, "metadata.json"), '{"task_id":"validation-task"}\n', "utf8");
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
          post_run_cleanup: { patterns: ["/tmp/cache*.tmp"], exit_code: 1, warning: "cleanup failed" }
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
        "post_run_cleanup_warning"
      ])
    );
  });

  it("attributes verifier failures after service cleanup to the service harness", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "sigma-bench-service-cleanup-"));
    await writeFile(
      path.join(runDir, "config.json"),
      `${JSON.stringify({
        run_id: "service-cleanup-run",
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

    const trialDir = path.join(runDir, "harbor-jobs", "job-1", "trial-1");
    const taskDir = path.join(runDir, "tasks", "service-task");
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(taskDir, "metadata.json"), `${JSON.stringify({
      task_id: "terminal-bench/service-task", source_logs_dir: path.join(trialDir, "agent")
    })}\n`, "utf8");
    await writeFile(
      path.join(taskDir, "summary.json"),
      `${JSON.stringify({
        status: "completed",
        finish_reason: "assistant_stop",
        harness: {
          service_cleanup: {
            stopped: ["kvstore-server"],
            kept: [],
            missing: [],
            errors: []
          }
        }
      })}\n`,
      "utf8"
    );
    await writeFile(path.join(taskDir, "verifier.log"), "verifier failed: connection refused on 127.0.0.1:5328\n", "utf8");

    await mkdir(path.join(trialDir, "agent"), { recursive: true });
    await mkdir(path.join(trialDir, "verifier"), { recursive: true });
    await writeFile(
      path.join(trialDir, "result.json"),
      `${JSON.stringify({
        trial_name: "trial-1",
        task_name: "terminal-bench/service-task",
        verifier_result: { rewards: { reward: 0 } }
      })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(trialDir, "agent", "trace.jsonl"),
      `${JSON.stringify({ type: "run_end", metadata: { result: { status: "completed", finishReason: "assistant_stop" } } })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(trialDir, "verifier", "ctrf.json"),
      `${JSON.stringify({
        results: {
          tests: [{ name: "connection_check", status: "failed", message: "connection refused" }]
        }
      })}\n`,
      "utf8"
    );

    const report = await generateBenchReport(runDir);
    const markdown = await readFile(path.join(runDir, "report.md"), "utf8");

    expect(report.tasks[0].failure_category).toBe("verifier_failed");
    expect(report.tasks[0].failure_signals).toEqual(
      expect.arrayContaining(["agent_completed_but_verifier_failed", "service_stopped_before_verifier"])
    );
    expect(report.tasks[0].suggested_owner).toBe("agent-tools/service");
    expect(markdown).toContain("service_stopped_before_verifier");
    expect(markdown).toContain("agent-tools/service");
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

    const trialDir = path.join(runDir, "harbor-jobs", "job-1", "trial-1");
    const taskDir = path.join(runDir, "tasks", "run");
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(taskDir, "metadata.json"), `${JSON.stringify({
      task_id: "run", status: "failed", exit_code: 1, source_logs_dir: path.join(trialDir, "agent")
    })}\n`, "utf8");

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
        JSON.stringify({
          type: "usage",
          metadata: { event_type: "usage.recorded", inputTokens: 10, outputTokens: 3 },
          sigma_event: {
            type: "usage.recorded",
            payload: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 0 }
          }
        }),
        JSON.stringify({
          type: "tool_end",
          metadata: { event_type: "tool.completed", toolName: "bash" },
          sigma_event: { type: "tool.completed", payload: { toolName: "bash" } }
        }),
        JSON.stringify({
          type: "run_end",
          metadata: {
            event_type: "run.failed",
            status: "stopped",
            finish_reason: "max_wall_time",
            commands_executed: 2,
            input_tokens: 20,
            output_tokens: 5,
            cache_tokens: 1,
            duration_ms: 1234
          },
          sigma_event: {
            type: "run.failed",
            payload: { kind: "recoverable_failure", code: "budget_exhausted", message: "wall time" }
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

  it("accounts for every Harbor trial and keeps UUID mirror orphans out of scoring", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "sigma-bench-five-trials-"));
    await writeFile(path.join(runDir, "config.json"), `${JSON.stringify({
      run_id: "five-trials",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      dataset: terminalBenchDataset,
      k: 5,
      command_text: "harbor run --config resolved-job.config.json",
      resolved_job_config_path: "resolved-job.config.json",
      finished_at: "2026-07-15T00:00:00.000Z",
      exit_code: 0,
      status: "passed"
    })}\n`, "utf8");
    await writeFile(path.join(runDir, "resolved-job.config.json"), `${JSON.stringify({
      n_concurrent_trials: 5,
      tasks: Array.from({ length: 5 }, (_value, index) => ({ name: `terminal-bench/task-${index + 1}` }))
    })}\n`, "utf8");
    for (const name of ["harbor.stdout.log", "harbor.stderr.log", "result.raw.log"]) {
      await writeFile(path.join(runDir, name), "", "utf8");
    }
    const jobDir = path.join(runDir, "harbor-jobs", "job-1");
    await writeHarborJobResult(jobDir, 5, 3);

    const trialDirs = Array.from({ length: 5 }, (_value, index) => path.join(jobDir, `trial-${index + 1}`));
    for (let index = 0; index < trialDirs.length; index += 1) {
      const trialDir = trialDirs[index];
      await mkdir(trialDir, { recursive: true });
      const setupError = index >= 2;
      await writeFile(path.join(trialDir, "result.json"), `${JSON.stringify({
        trial_name: `trial-${index + 1}`,
        task_name: `terminal-bench/task-${index + 1}`,
        agent_result: setupError ? null : { metadata: { exit_code: 0 }, n_input_tokens: 10, n_output_tokens: 2 },
        verifier_result: setupError ? null : { rewards: { reward: 0 } },
        exception_info: setupError ? {
          exception_type: "RuntimeError",
          exception_message: `agent_setup_failed: stage=strict_doctor exit_code=${index + 1}`
        } : null
      })}\n`, "utf8");
    }

    for (let index = 0; index < 2; index += 1) {
      const artifactDir = path.join(runDir, "tasks", `00000000-0000-0000-0000-00000000000${index}`);
      await mkdir(artifactDir, { recursive: true });
      await writeFile(path.join(artifactDir, "metadata.json"), `${JSON.stringify({
        task_id: `uuid-${index}`,
        source_logs_dir: path.join(trialDirs[index], "agent"),
        exit_code: 0
      })}\n`, "utf8");
    }
    const orphanDir = path.join(runDir, "tasks", "ffffffff-ffff-ffff-ffff-ffffffffffff");
    await mkdir(orphanDir, { recursive: true });
    await writeFile(path.join(orphanDir, "metadata.json"), `${JSON.stringify({
      task_id: "orphan-uuid",
      source_logs_dir: path.join(jobDir, "not-a-trial", "agent"),
      exit_code: 1
    })}\n`, "utf8");

    const report = await generateBenchReport(runDir);

    expect(report.status).toBe("failed");
    expect(report.incomplete_reason).toBeNull();
    expect(report.tasks).toHaveLength(5);
    expect(report.tasks.every((task) => ["failed", "infra_failed"].includes(task.status))).toBe(true);
    expect(report.counts.failed).toBe(2);
    expect(report.counts.infra_failed).toBe(3);
    expect(report.tasks.filter((task) => task.failure_category === "agent_setup_failed")).toHaveLength(3);
    expect(report.trial_accounting).toEqual({
      expected: 5,
      observed: 5,
      scored: 2,
      errored: 3,
      missing: 0,
      meanReward: 0
    });
    expect(report.n_concurrent_trials).toBe(5);
    expect(report.orphan_artifacts).toHaveLength(1);
    expect(report.orphan_artifacts[0].artifact_task_id).toBe("orphan-uuid");
  });

  it("marks a missing Harbor trial incomplete even when the Harbor process exited zero", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "sigma-bench-missing-trial-"));
    await writeFile(path.join(runDir, "config.json"), `${JSON.stringify({
      run_id: "missing-trial",
      provider: "deepseek",
      k: 2,
      resolved_job_config_path: "resolved-job.config.json",
      finished_at: "2026-07-15T00:00:00.000Z",
      exit_code: 0,
      status: "passed"
    })}\n`, "utf8");
    await writeFile(path.join(runDir, "resolved-job.config.json"), `${JSON.stringify({
      tasks: [{ name: "terminal-bench/a" }, { name: "terminal-bench/b" }]
    })}\n`, "utf8");
    for (const name of ["harbor.stdout.log", "harbor.stderr.log", "result.raw.log"]) {
      await writeFile(path.join(runDir, name), "", "utf8");
    }
    const jobDir = path.join(runDir, "harbor-jobs", "job-1");
    await mkdir(path.join(jobDir, "trial-1"), { recursive: true });
    await writeHarborJobResult(jobDir, 2);
    await writeFile(path.join(jobDir, "trial-1", "result.json"), `${JSON.stringify({
      trial_name: "trial-1",
      task_name: "terminal-bench/a",
      verifier_result: { rewards: { reward: 1 } },
      exception_info: null
    })}\n`, "utf8");

    const report = await generateBenchReport(runDir);

    expect(report.status).toBe("incomplete");
    expect(report.trial_accounting.missing).toBe(1);
    expect(report.incomplete_reason?.join("\n")).toContain("trial result count 1 does not match expected 2");
  });
});
