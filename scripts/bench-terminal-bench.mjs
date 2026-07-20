#!/usr/bin/env node
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { cleanupHarborDockerResources } from "./harbor-docker-cleanup.mjs";
import {
  benchRootDir,
  agentCliArchiveSourceIdentity,
  buildCommandScript,
  buildHarborArgs,
  buildHarborJobConfig,
  buildHarborTimeoutProbeConfig,
  commandText,
  computeHarborTimeoutPlan,
  detectHarborRunCapabilities,
  detectTaskSelectionFlag,
  ensurePlaceholderTask,
  generateBenchReport,
  groupHarborTimeoutProbe,
  harborTopologyForOptions,
  harborPythonCommand,
  harborEnvForRun,
  loadDotEnv,
  makeRunId,
  packageAgentCli,
  packageHarborRuntime,
  pairedRunCohortScheduleSha256,
  pairedRunTaskIdentitySha256,
  pairedRunTaskKey,
  parseHarborTimeoutProbe,
  repositorySourceIdentity,
  resolveHarborCommand,
  resolveRunOptions,
  rootDir,
  runProcess,
  safePathPart,
  terminalBenchDataset,
  writeJson
} from "./bench-common.mjs";

function statusFromExitCode(exitCode) {
  return exitCode === 0 ? "passed" : "failed";
}

function evaluationLane(agentProfile) {
  return agentProfile === "strict" ? "strict_conformance" : "solving";
}

export async function allocateBenchmarkRunDirectory(
  parentDirectory,
  stem,
  runLabel = null,
  entropy = () => randomBytes(8).toString("hex")
) {
  await mkdir(parentDirectory, { recursive: true });
  const label = runLabel ? `-${safePathPart(runLabel)}` : "";
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const nonce = safePathPart(entropy(), "entropy-unavailable");
    const runId = `${stem}${label}-${nonce}`;
    const runDir = path.join(parentDirectory, runId);
    try {
      await mkdir(runDir, { recursive: false, mode: 0o700 });
      return { runId, runDir };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not allocate an exclusive benchmark run directory after 32 attempts.");
}

async function appendFileStream(targetPath, sourcePath, fallbackText = "") {
  if (!existsSync(sourcePath)) {
    if (fallbackText) await appendFile(targetPath, fallbackText, "utf8");
    return;
  }
  await pipeline(
    createReadStream(sourcePath),
    createWriteStream(targetPath, { flags: "a", mode: 0o600 })
  );
}

export async function assembleGroupedLogs(runDir, launchGroups, harborResults) {
  const stdout = path.join(runDir, "harbor.stdout.log");
  const stderr = path.join(runDir, "harbor.stderr.log");
  const raw = path.join(runDir, "result.raw.log");
  await Promise.all([writeFile(stdout, "", "utf8"), writeFile(stderr, "", "utf8")]);
  const summaries = [];
  for (let index = 0; index < launchGroups.length; index += 1) {
    const suffix = `-group-${String(index + 1).padStart(3, "0")}`;
    const result = harborResults[index] ?? {};
    await appendFile(stdout, `[group ${index + 1}]\n`, "utf8");
    await appendFileStream(
      stdout,
      path.join(runDir, `harbor${suffix}.stdout.log`),
      result.stdout ?? ""
    );
    await appendFile(stdout, "\n", "utf8");
    await appendFile(stderr, `[group ${index + 1}]\n`, "utf8");
    await appendFileStream(
      stderr,
      path.join(runDir, `harbor${suffix}.stderr.log`),
      result.stderr ?? ""
    );
    await appendFile(stderr, "\n", "utf8");
    summaries.push([
      `group: ${index + 1}`,
      `exit_code: ${result.exitCode ?? 1}`,
      `stdout_log: harbor${suffix}.stdout.log`,
      `stderr_log: harbor${suffix}.stderr.log`
    ].join("\n"));
  }
  await writeFile(raw, `${summaries.join("\n\n")}\n`, "utf8");
}

async function cleanupWithDeadline(cleanup, runId, engine, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => cleanup === cleanupHarborDockerResources
        ? cleanup(runId, engine, undefined, timeoutMs)
        : cleanup(runId, engine)),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Container cleanup exceeded its ${timeoutMs}ms deadline.`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function boundedReturnedLog(value, limit = 64 * 1024) {
  const text = typeof value === "string" ? value : "";
  return text.length <= limit ? text : text.slice(-limit);
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function writeRunFiles(runDir, config, harborCommand, harborArgs, env) {
  await writeJson(path.join(runDir, "config.json"), config);
  await writeFile(path.join(runDir, "command.sh"), buildCommandScript(harborCommand, harborArgs, env), "utf8");
}

async function failBeforeHarbor(runDir, config, message, exitCode) {
  const finishedAt = new Date().toISOString();
  const nextConfig = {
    ...config,
    finished_at: finishedAt,
    exit_code: exitCode,
    status: "failed",
    notes: [...(config.notes ?? []), message]
  };
  await writeJson(path.join(runDir, "config.json"), nextConfig);
  await writeFile(path.join(runDir, "harbor.stdout.log"), "", "utf8");
  await writeFile(path.join(runDir, "harbor.stderr.log"), `${message}\n`, "utf8");
  await writeFile(
    path.join(runDir, "result.raw.log"),
    [`exit_code: ${exitCode}`, "stdout:", "", "stderr:", message, ""].join("\n"),
    "utf8"
  );
  await ensurePlaceholderTask(runDir, {
    status: "failed",
    exit_code: exitCode,
    error_message: message
  });
  const report = await generateBenchReport(runDir);
  return { exitCode, runDir, report };
}

export async function runTerminalBenchCli(argv, deps = {}) {
  loadDotEnv();
  const options = resolveRunOptions(argv);
  if (options.mode === "task" && !options.taskId) {
    throw new Error("Task mode requires --task-id <task-id>.");
  }
  if (options.mode === "batch" && options.tasks.length === 0) {
    throw new Error("Batch mode requires at least one externally selected task.");
  }

  const baseRunId = makeRunId(new Date(), options.provider, options.model);
  const { runId, runDir } = await allocateBenchmarkRunDirectory(
    benchRootDir,
    baseRunId,
    options.runLabel,
    deps.runIdEntropy
  );
  const jobsDir = path.join(runDir, "harbor-jobs");
  const env = harborEnvForRun(runDir);
  const startedAt = new Date().toISOString();
  const runner = deps.runProcess ?? runProcess;
  const packager = deps.packageAgentCli ?? packageAgentCli;
  const harborRuntimePackager = deps.packageHarborRuntime ?? packageHarborRuntime;
  const dockerCleanup = deps.cleanupHarborDockerResources ?? cleanupHarborDockerResources;
  const harborCommandInfo = deps.resolveHarborCommand?.(env) ?? resolveHarborCommand(env);
  const harborCommand = harborCommandInfo.command;
  const harnessSourceIdentity = deps.repositorySourceIdentity?.() ?? repositorySourceIdentity(rootDir);
  let harborVersion = null;
  let harborArgs = ["run", "--help"];
  let config = {
    run_id: runId,
    started_at: startedAt,
    finished_at: null,
    mode: options.mode,
    benchmark_class: options.benchmarkClass,
    agent_profile: options.agentProfile,
    evaluation_lane: evaluationLane(options.agentProfile),
    execution_mode: options.executionMode,
    managed_provenance: options.managedProvenance,
    harbor_topology: harborTopologyForOptions(options),
    container_engine_requested: options.containerEngine,
    network_mode: options.networkMode,
    provider: options.provider,
    model: options.model ?? null,
    model_parameters: {
      temperature: "provider_default",
      top_p: "provider_default"
    },
    max_turns: options.maxTurns,
    command_timeout_sec: options.commandTimeoutSec,
    dataset: terminalBenchDataset,
    terminal_bench_revision: options.terminalBenchRevision,
    k: options.mode === "k" ? options.k : null,
    n_concurrent_trials: options.nConcurrentTrials,
    task_id: options.mode === "task" ? options.taskId : null,
    task_count: options.mode === "batch" ? options.tasks.length : null,
    tasks_file: options.tasksFile,
    tasks_file_sha256: options.tasksFileSha256,
    package_reused: options.reusePackage,
    expected_agent_cli_sha256: options.expectedArchiveSha256,
    agent_cli_sha256: null,
    source_revision: null,
    source_dirty: null,
    source_diff_sha256: null,
    source_identity_source: null,
    preregistration_sha256: options.preregistrationSha256,
    validation_manifest: options.validationManifest,
    validation_manifest_sha256: options.validationManifestSha256,
    harness_source_revision: harnessSourceIdentity.revision,
    harness_source_dirty: harnessSourceIdentity.dirty,
    harness_source_diff_sha256: harnessSourceIdentity.dirtyDiffSha256 ?? null,
    attempts_per_arm: options.attemptsPerArm,
    retries: options.retries,
    agent_cli_tarball: env.AGENT_CLI_TARBALL,
    harbor_jobs_dir: jobsDir,
    harbor_command: harborCommand,
    harbor_command_source: harborCommandInfo.source,
    harbor_command_exists: harborCommandInfo.exists,
    harbor_version: harborVersion,
    command: [harborCommand, ...harborArgs],
    command_text: commandText(harborCommand, harborArgs),
    exit_code: null,
    status: "running",
    notes: []
  };
  await writeRunFiles(runDir, config, harborCommand, harborArgs, env);

  if (options.reusePackage) {
    process.stdout.write(`Reusing SHA-pinned Sigma agent CLI archive...\n`);
    await writeFile(path.join(runDir, "package.stdout.log"), "Reused existing SHA-pinned archive.\n", "utf8");
    await writeFile(path.join(runDir, "package.stderr.log"), "", "utf8");
    await writeFile(path.join(runDir, "package.raw.log"), "package_reused: true\n", "utf8");
  } else {
    process.stdout.write(`Packaging Sigma agent CLI for Terminal-Bench...\n`);
    const packageResult = await packager({
      cwd: rootDir,
      env: process.env,
      stdoutPath: path.join(runDir, "package.stdout.log"),
      stderrPath: path.join(runDir, "package.stderr.log"),
      rawPath: path.join(runDir, "package.raw.log")
    });
    if (packageResult.exitCode !== 0) {
      return await failBeforeHarbor(
        runDir,
        config,
        `pnpm package:agent-cli failed with exit code ${packageResult.exitCode}. See package.raw.log.`,
        packageResult.exitCode
      );
    }
  }

  if (!existsSync(env.AGENT_CLI_TARBALL)) {
    return await failBeforeHarbor(
      runDir,
      config,
      `AGENT_CLI_TARBALL does not exist after packaging: ${env.AGENT_CLI_TARBALL}`,
      1
    );
  }

  const agentCliSha256 = await sha256File(env.AGENT_CLI_TARBALL);
  let embeddedSourceIdentity;
  try {
    embeddedSourceIdentity = (deps.agentCliArchiveSourceIdentity ?? agentCliArchiveSourceIdentity)(
      env.AGENT_CLI_TARBALL
    );
  } catch (error) {
    return await failBeforeHarbor(
      runDir,
      config,
      `Agent CLI source provenance inspection failed: ${error instanceof Error ? error.message : String(error)}`,
      1
    );
  }
  if (embeddedSourceIdentity && options.expectedSourceRevision
    && embeddedSourceIdentity.revision !== options.expectedSourceRevision) {
    return await failBeforeHarbor(
      runDir,
      config,
      `Agent CLI source revision ${embeddedSourceIdentity.revision} does not match frozen ${options.expectedSourceRevision}.`,
      1
    );
  }
  if (embeddedSourceIdentity && options.expectedSourceDirty !== null
    && embeddedSourceIdentity.dirty !== options.expectedSourceDirty) {
    return await failBeforeHarbor(
      runDir,
      config,
      `Agent CLI source dirty state ${String(embeddedSourceIdentity.dirty)} does not match frozen ${String(options.expectedSourceDirty)}.`,
      1
    );
  }
  if (options.expectedSourceDiffSha256
    && (harnessSourceIdentity.revision !== (options.expectedSourceRevision ?? embeddedSourceIdentity?.revision)
      || harnessSourceIdentity.dirtyDiffSha256 !== options.expectedSourceDiffSha256)) {
    return await failBeforeHarbor(
      runDir,
      config,
      "Current source delta does not match the frozen source-diff SHA-256.",
      1
    );
  }
  const packageSourceIdentity = embeddedSourceIdentity ?? (options.expectedSourceRevision
    ? { revision: options.expectedSourceRevision, dirty: null }
    : null);
  if (!packageSourceIdentity) {
    return await failBeforeHarbor(
      runDir,
      config,
      "Agent CLI archive lacks source provenance; legacy reuse requires --expected-source-revision.",
      1
    );
  }
  config = {
    ...config,
    agent_cli_sha256: agentCliSha256,
    source_revision: packageSourceIdentity.revision,
    source_dirty: packageSourceIdentity.dirty,
    source_diff_sha256: options.expectedSourceDiffSha256
      ?? (harnessSourceIdentity.revision === packageSourceIdentity.revision
        ? harnessSourceIdentity.dirtyDiffSha256 : null),
    source_identity_source: embeddedSourceIdentity ? "package_metadata" : "launcher_pinned_legacy"
  };
  await writeJson(path.join(runDir, "config.json"), config);
  if (options.expectedArchiveSha256 && agentCliSha256 !== options.expectedArchiveSha256) {
    return await failBeforeHarbor(
      runDir,
      config,
      `Agent CLI archive SHA-256 ${agentCliSha256} does not match frozen ${options.expectedArchiveSha256}.`,
      1
    );
  }

  process.stdout.write(`Packaging portable Harbor runtime...\n`);
  const harborRuntimeResult = await harborRuntimePackager({
    cwd: rootDir,
    env: process.env,
    stdoutPath: path.join(runDir, "package-harbor-runtime.stdout.log"),
    stderrPath: path.join(runDir, "package-harbor-runtime.stderr.log"),
    rawPath: path.join(runDir, "package-harbor-runtime.raw.log")
  });
  if (harborRuntimeResult.exitCode !== 0) {
    return await failBeforeHarbor(
      runDir,
      config,
      `pnpm package:harbor-runtime failed with exit code ${harborRuntimeResult.exitCode}. See package-harbor-runtime.raw.log.`,
      harborRuntimeResult.exitCode
    );
  }

  process.stdout.write(`Inspecting Harbor CLI support...\n`);
  const versionResult = await runner(harborCommand, ["--version"], {
    cwd: rootDir,
    env,
    stdoutPath: path.join(runDir, "harbor-version.stdout.log"),
    stderrPath: path.join(runDir, "harbor-version.stderr.log"),
    rawPath: path.join(runDir, "harbor-version.raw.log")
  });
  harborVersion = versionResult.exitCode === 0 ? `${versionResult.stdout}\n${versionResult.stderr}`.trim() || null : null;
  config = {
    ...config,
    harbor_version: harborVersion
  };
  await writeRunFiles(runDir, config, harborCommand, harborArgs, env);

  const helpResult = await runner(harborCommand, ["run", "--help"], {
    cwd: rootDir,
    env,
    stdoutPath: path.join(runDir, "harbor-run-help.stdout.log"),
    stderrPath: path.join(runDir, "harbor-run-help.stderr.log"),
    rawPath: path.join(runDir, "harbor-run-help.raw.log")
  });
  if (helpResult.exitCode !== 0) {
    return await failBeforeHarbor(
      runDir,
      config,
      `Harbor run --help failed with exit code ${helpResult.exitCode}. Set HARBOR_BIN if Harbor is installed outside PATH. See harbor-run-help.raw.log.`,
      helpResult.exitCode
    );
  }
  const helpText = `${helpResult.stdout}\n${helpResult.stderr}`;
  await writeFile(path.join(runDir, "harbor-run-help.txt"), helpText, "utf8");
  const capabilities = detectHarborRunCapabilities(helpText);
  const taskSelectionFlag = detectTaskSelectionFlag(helpText);

  let timeoutProbe = null;
  let timeoutPlan;
  if (options.mode !== "smoke") {
    process.stdout.write(`Inspecting selected task timeout metadata...\n`);
    const timeoutProbeJobsDir = path.join(runDir, "harbor-timeout-probe-jobs");
    const timeoutProbeConfig = buildHarborTimeoutProbeConfig(
      {
        ...options,
        agentCliTarball: env.AGENT_CLI_TARBALL
      },
      timeoutProbeJobsDir
    );
    const timeoutProbeConfigPath = path.join(runDir, "harbor-timeout-probe.config.json");
    await writeJson(timeoutProbeConfigPath, timeoutProbeConfig);
    const timeoutProbeResult = await runner(harborPythonCommand(env), [path.join(rootDir, "scripts", "probe-harbor-timeouts.py"), timeoutProbeConfigPath], {
      cwd: rootDir,
      env,
      stdoutPath: path.join(runDir, "harbor-timeout-probe.stdout.log"),
      stderrPath: path.join(runDir, "harbor-timeout-probe.stderr.log"),
      rawPath: path.join(runDir, "harbor-timeout-probe.raw.log")
    });
    if (timeoutProbeResult.exitCode !== 0) {
      return await failBeforeHarbor(
        runDir,
        config,
        `Harbor timeout probe failed with exit code ${timeoutProbeResult.exitCode}. See harbor-timeout-probe.raw.log.`,
        timeoutProbeResult.exitCode
      );
    }

    try {
      timeoutProbe = parseHarborTimeoutProbe(timeoutProbeResult.stdout);
    } catch (error) {
      return await failBeforeHarbor(
        runDir,
        config,
        `Harbor timeout probe output could not be parsed: ${error instanceof Error ? error.message : String(error)}. See harbor-timeout-probe.raw.log.`,
        2
      );
    }
    timeoutPlan = computeHarborTimeoutPlan(options, timeoutProbe);
  } else {
    timeoutPlan = computeHarborTimeoutPlan(options, null);
  }

  const attemptOptions = {
    ...options,
    agentCliTarball: env.AGENT_CLI_TARBALL
  };
  const timeoutGroups = options.mode === "smoke"
    ? [{ tasks: [], resolved_tasks: [], configured_tasks: [], timeout_probe: null }]
    : groupHarborTimeoutProbe(timeoutProbe, options.tasks);
  const launchGroups = [];
  for (let index = 0; index < timeoutGroups.length; index += 1) {
    const group = timeoutGroups[index];
    const groupPlan = computeHarborTimeoutPlan(options, group.timeout_probe);
    const groupOptions = {
      ...attemptOptions,
      tasks: group.configured_tasks.length > 0 ? group.configured_tasks : group.resolved_tasks
    };
    const suffix = timeoutGroups.length === 1 ? "" : `-${String(index + 1).padStart(3, "0")}`;
    const configPath = path.join(runDir, `resolved-job${suffix}.config.json`);
    const jobConfig = buildHarborJobConfig(groupOptions, jobsDir, groupPlan, group.timeout_probe);
    await writeJson(configPath, jobConfig);
    const resolvedTaskAttestationPath = path.join(
      runDir, `resolved-task-attestation${suffix}.json`
    );
    await writeJson(resolvedTaskAttestationPath, {
      schemaVersion: 1,
      kind: "sigma.harbor-resolved-task-attestation",
      job_config_sha256: await sha256File(configPath),
      tasks: group.tasks
    });
    const args = buildHarborArgs({
      ...groupOptions,
      taskSelectionFlag,
      capabilities,
      jobsDir,
      timeoutProbe: group.timeout_probe,
      timeoutPlan: groupPlan,
      configPath
    });
    launchGroups.push({
      index,
      args,
      configPath,
      resolvedTaskAttestationPath,
      timeoutPlan: groupPlan,
      taskNames: group.tasks.map((task) => task?.task_name).filter(Boolean)
    });
  }
  harborArgs = launchGroups[0].args;
  let pairedRunControls = null;
  if (options.mode === "batch" && options.tasks.length === timeoutProbe?.tasks?.length) {
    const controlledTasks = options.tasks.map((task, index) => {
      const controlled = {
        pairing_key: pairedRunTaskKey(task),
        source: task.source,
        path: task.path,
        git_url: task.git_url,
        git_commit_id: task.git_commit_id ?? options.terminalBenchRevision,
        effective_solver_timeout_sec: Number(timeoutProbe.tasks[index]?.agent_timeout_sec),
        network_mode_effective: options.networkMode
      };
      return { ...controlled, task_identity_sha256: pairedRunTaskIdentitySha256(controlled) };
    });
    const cohortSchedule = timeoutGroups.map((group, index) => ({
      order: index,
      effective_solver_timeout_sec: Number(group.agent_timeout_sec),
      task_keys: group.task_indexes.map((taskIndex) => pairedRunTaskKey(options.tasks[taskIndex])).sort()
    }));
    const inputConfigSha256s = await Promise.all(launchGroups.map(async (group, index) => ({
      order: index,
      sha256: await sha256File(group.configPath)
    })));
    pairedRunControls = {
      agent: "sigma",
      source_revision: config.source_revision,
      source_dirty: config.source_dirty,
      source_diff_sha256: config.source_diff_sha256,
      execution_subject_kind: "archive",
      execution_subject_sha256: config.agent_cli_sha256,
      archiveSha256: config.agent_cli_sha256,
      model_identity: options.model?.includes("/")
        ? options.model : `${options.provider}/${options.model}`,
      terminal_bench_revision: options.terminalBenchRevision,
      network_mode: options.networkMode,
      n_concurrent_trials: options.nConcurrentTrials,
      attempts_per_arm: options.attemptsPerArm,
      retries: options.retries,
      preregistration_sha256: options.preregistrationSha256,
      tasks: controlledTasks,
      cohort_schedule: cohortSchedule,
      cohort_schedule_sha256: pairedRunCohortScheduleSha256(cohortSchedule),
      input_config_sha256s: inputConfigSha256s
    };
  }
  config = {
    ...config,
    finished_at: null,
    exit_code: null,
    status: "running",
    command: [harborCommand, ...harborArgs],
    command_text: launchGroups.map((group) => commandText(harborCommand, group.args)).join("\n"),
    harbor_capabilities: capabilities,
    task_selection_flag: taskSelectionFlag,
    timeout_probe: timeoutProbe,
    timeout_plan: timeoutPlan,
    timeout_groups: launchGroups.map((group) => ({
      task_names: group.taskNames,
      timeout_plan: group.timeoutPlan,
      resolved_job_config_path: path.relative(runDir, group.configPath).replace(/\\/g, "/")
    })),
    paired_run_controls: pairedRunControls,
    score_mode: options.benchmarkClass === "diagnostic" ? "diagnostic" : "standard_benchmark",
    resolved_job_config_path: path.relative(runDir, launchGroups[0].configPath).replace(/\\/g, "/"),
    resolved_job_config_paths: launchGroups.map((group) =>
      path.relative(runDir, group.configPath).replace(/\\/g, "/")),
    resolved_task_attestation_paths: launchGroups.map((group) =>
      path.relative(runDir, group.resolvedTaskAttestationPath).replace(/\\/g, "/")),
    commands: launchGroups.map((group) => [harborCommand, ...group.args])
  };
  await writeRunFiles(runDir, config, harborCommand, harborArgs, env);
  if (launchGroups.length > 1) {
    await writeFile(path.join(runDir, "command.sh"), launchGroups
      .map((group) => buildCommandScript(harborCommand, group.args, env).trimEnd())
      .join("\n"), "utf8");
  }

  let cleanupBefore;
  try {
    cleanupBefore = await cleanupWithDeadline(
      dockerCleanup,
      env.SIGMA_HARBOR_RUN_ID,
      options.containerEngine,
      options.agentTimeoutGraceSec * 1_000
    );
  } catch (error) {
    cleanupBefore = {
      schemaVersion: 1,
      runId: env.SIGMA_HARBOR_RUN_ID,
      clean: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
  await writeJson(path.join(runDir, "docker-cleanup-before.json"), cleanupBefore);
  if (!cleanupBefore.clean) {
    return await failBeforeHarbor(
      runDir,
      config,
      "Docker resource preflight failed; refusing to start Harbor while run-scoped resources cannot be cleaned.",
      1
    );
  }

  const abortController = new AbortController();
  let interruptionSignal = null;
  const interrupt = (signal) => {
    interruptionSignal ??= signal;
    abortController.abort(new Error(`Benchmark interrupted by ${signal}.`));
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  const harborResults = [];
  let runnerError = null;
  let cleanupAfter;
  try {
    for (const group of launchGroups) {
      process.stdout.write(`Running Harbor benchmark: ${commandText(harborCommand, group.args)}\n`);
      const suffix = launchGroups.length === 1 ? "" : `-group-${String(group.index + 1).padStart(3, "0")}`;
      const groupResult = await runner(harborCommand, group.args, {
        cwd: rootDir,
        env,
        stdoutPath: path.join(runDir, `harbor${suffix}.stdout.log`),
        stderrPath: path.join(runDir, `harbor${suffix}.stderr.log`),
        rawPath: path.join(runDir, suffix ? `result${suffix}.raw.log` : "result.raw.log"),
        signal: abortController.signal
      });
      harborResults.push({
        exitCode: groupResult.exitCode,
        stdout: boundedReturnedLog(groupResult.stdout),
        stderr: boundedReturnedLog(groupResult.stderr)
      });
      if (abortController.signal.aborted) break;
    }
    if (abortController.signal.aborted) {
      runnerError = abortController.signal.reason?.message ?? "Benchmark interrupted.";
    }
  } catch (error) {
    runnerError = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      cleanupAfter = await cleanupWithDeadline(
        dockerCleanup,
        env.SIGMA_HARBOR_RUN_ID,
        options.containerEngine,
        options.agentTimeoutGraceSec * 1_000
      );
    } catch (error) {
      cleanupAfter = {
        schemaVersion: 1,
        runId: env.SIGMA_HARBOR_RUN_ID,
        clean: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    try {
      await writeJson(path.join(runDir, "docker-cleanup-after.json"), cleanupAfter);
    } finally {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    }
  }
  if (launchGroups.length > 1) {
    await assembleGroupedLogs(runDir, launchGroups, harborResults);
  }
  for (const [name, content] of [
    ["harbor.stdout.log", ""],
    ["harbor.stderr.log", runnerError ? `${runnerError}\n` : ""],
    ["result.raw.log", runnerError ? `runner_error: ${runnerError}\n` : ""]
  ]) {
    if (!existsSync(path.join(runDir, name))) await writeFile(path.join(runDir, name), content, "utf8");
  }
  const harborExitCode = runnerError
    ? 1
    : harborResults.find((result) => result.exitCode !== 0)?.exitCode ?? 0;

  const finishedAt = new Date().toISOString();
  const effectiveExitCode = cleanupAfter.clean ? harborExitCode : 1;
  config = {
    ...config,
    finished_at: finishedAt,
    exit_code: effectiveExitCode,
    harbor_exit_code: harborExitCode,
    status: statusFromExitCode(effectiveExitCode),
    termination_source: interruptionSignal === "SIGINT"
      ? "manual_stop"
      : interruptionSignal ? "external_stop" : null,
    interruption_signal: interruptionSignal,
    manual_stop_count: interruptionSignal === "SIGINT" ? 1 : 0,
    docker_cleanup: cleanupAfter,
    notes: [
      ...config.notes,
      ...(runnerError ? [`Harbor runner failed before completing: ${runnerError}`] : []),
      ...(cleanupAfter.clean ? [] : ["Run-scoped container resources remained after Harbor exited."])
    ]
  };
  await writeJson(path.join(runDir, "config.json"), config);
  await ensurePlaceholderTask(runDir, {
    status: statusFromExitCode(harborExitCode),
    exit_code: harborExitCode,
    termination_source: config.termination_source,
    manual_stop_count: config.manual_stop_count,
    artifact_note: "Per-task Sigma traces are mirrored here when Harbor exposes task context to the adapter. If this is the only task entry, inspect harbor.stdout.log and harbor.stderr.log."
  });

  const report = await generateBenchReport(runDir);

  process.stdout.write(`Benchmark artifacts: ${runDir}\n`);
  process.stdout.write(`Report: ${path.join(runDir, "report.md")}\n`);
  const exitCode = report?.status === "passed"
    ? cleanupAfter.clean ? 0 : 1
    : effectiveExitCode && effectiveExitCode !== 0
      ? effectiveExitCode
      : 1;
  return { exitCode, runDir, report, dockerCleanup: cleanupAfter };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = await runTerminalBenchCli(process.argv.slice(2));
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
