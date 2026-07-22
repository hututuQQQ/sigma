#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupHarborDockerResources } from "./harbor-docker-cleanup.mjs";
import {
  benchRootDir,
  assertUniqueHarborTaskExecutionIdentities,
  buildCommandScript,
  buildHarborArgs,
  buildHarborJobConfig,
  buildHarborTimeoutProbeConfig,
  buildResolvedTaskAttestationV2,
  commandText,
  computeHarborTimeoutPlan,
  detectHarborRunCapabilities,
  detectTaskSelectionFlag,
  ensurePlaceholderTask,
  generateBenchReport,
  groupHarborTimeoutProbe,
  harborPythonCommand,
  harborEnvForRun,
  harborRuntimeDir,
  harborTaskExecutionIdentity,
  harborTaskExecutionIdentitySha256,
  loadDotEnv,
  makeRunId,
  packageAgentCli,
  packageHarborRuntime,
  parseHarborTimeoutProbe,
  resolveHarborCommand,
  resolveRunOptions,
  rootDir,
  runProcess,
  safePathPart,
  taskSelectionIdentity,
  taskSelectionIdentitySha256,
  terminalBenchDataset,
  writeJson
} from "./bench-common.mjs";
import {
  assertFrozenHarborRuntimeUnchanged,
  snapshotFrozenHarborRuntime
} from "./harbor-runtime-freeze.mjs";

function statusFromExitCode(exitCode) {
  return exitCode === 0 ? "passed" : "failed";
}

function evaluationLane(agentProfile) {
  return agentProfile === "strict" ? "strict_conformance" : "solving";
}

export async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runWorker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    () => runWorker()
  ));
  return results;
}

function freshRunSlotId(existing, makeId = () => randomBytes(16).toString("hex")) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const id = safePathPart(makeId(), "slot");
    if (!existing.has(id)) {
      existing.add(id);
      return id;
    }
  }
  throw new Error("Unable to allocate a unique Harbor run slot.");
}

function selectionDigest(tasks, externalDigest) {
  if (externalDigest) return externalDigest;
  return createHash("sha256")
    .update(JSON.stringify(tasks.map(taskSelectionIdentity)))
    .digest("hex");
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
  const runId = options.runLabel ? `${baseRunId}-${safePathPart(options.runLabel)}` : baseRunId;
  const runDir = path.join(benchRootDir, runId);
  const jobsDir = path.join(runDir, "harbor-jobs");
  const env = harborEnvForRun(runDir);
  const startedAt = new Date().toISOString();
  const runner = deps.runProcess ?? runProcess;
  const packager = deps.packageAgentCli ?? packageAgentCli;
  const harborRuntimePackager = deps.packageHarborRuntime ?? packageHarborRuntime;
  const dockerCleanup = deps.cleanupHarborDockerResources ?? cleanupHarborDockerResources;
  const harborCommandInfo = deps.resolveHarborCommand?.(env) ?? resolveHarborCommand(env);
  const harborCommand = harborCommandInfo.command;
  await mkdir(runDir, { recursive: true });

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
    network_mode: options.networkMode,
    execution_mode: options.executionMode,
    managed_environment_mode: options.managedEnvironmentMode,
    harbor_topology: options.harborTopology,
    provider: options.provider,
    model: options.model ?? null,
    dataset: terminalBenchDataset,
    k: options.mode === "k" ? options.k : null,
    n_concurrent_trials: options.nConcurrentTrials,
    task_id: options.mode === "task" ? options.taskId : null,
    tasks_file: options.tasksFile,
    tasks_file_sha256: options.tasksFileSha256,
    package_reused: options.reusePackage,
    expected_agent_cli_sha256: options.expectedArchiveSha256,
    agent_cli_sha256: null,
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
  config = { ...config, agent_cli_sha256: agentCliSha256 };
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

  const frozenHarborRuntimeDir = path.resolve(harborRuntimeResult.harborRuntimeDir ?? harborRuntimeDir);
  let frozenRuntimeSnapshot;
  try {
    frozenRuntimeSnapshot = await snapshotFrozenHarborRuntime(frozenHarborRuntimeDir);
  } catch (error) {
    return await failBeforeHarbor(
      runDir,
      config,
      `Frozen Harbor runtime preflight failed: ${error instanceof Error ? error.message : String(error)}`,
      1
    );
  }
  const importSmokeScript = [
    "import pathlib, sys, sigma_harbor_agent",
    "expected = pathlib.Path(sys.argv[1]).resolve()",
    "actual = pathlib.Path(sigma_harbor_agent.__file__).resolve().parent",
    "assert actual == expected, f'loaded {actual}, expected {expected}'"
  ].join("; ");
  const importSmoke = await runner(
    harborPythonCommand(env),
    ["-c", importSmokeScript, frozenHarborRuntimeDir],
    {
      cwd: rootDir,
      env,
      stdoutPath: path.join(runDir, "harbor-runtime-import.stdout.log"),
      stderrPath: path.join(runDir, "harbor-runtime-import.stderr.log"),
      rawPath: path.join(runDir, "harbor-runtime-import.raw.log")
    }
  );
  if (importSmoke.exitCode !== 0) {
    return await failBeforeHarbor(
      runDir,
      config,
      `Frozen Harbor runtime import smoke failed with exit code ${importSmoke.exitCode}.`,
      importSmoke.exitCode
    );
  }
  try {
    assertFrozenHarborRuntimeUnchanged(
      frozenRuntimeSnapshot,
      await snapshotFrozenHarborRuntime(frozenHarborRuntimeDir)
    );
  } catch (error) {
    return await failBeforeHarbor(
      runDir,
      config,
      `Frozen Harbor runtime import mutated the package: ${error instanceof Error ? error.message : String(error)}`,
      1
    );
  }
  config = {
    ...config,
    frozen_harbor_runtime_dir: frozenHarborRuntimeDir,
    frozen_harbor_runtime_sha256: frozenRuntimeSnapshot.digest,
    frozen_runtime_integrity: "passed"
  };
  await writeJson(path.join(runDir, "config.json"), config);

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
  const slotSpecs = [];
  if (options.mode === "smoke") {
    slotSpecs.push({ task: null, resolvedTask: null, taskProbe: null });
  } else {
    for (const group of timeoutGroups) {
      const count = Math.max(group.configured_tasks.length, group.resolved_tasks.length, group.tasks.length);
      for (let index = 0; index < count; index += 1) {
        const task = group.configured_tasks[index] ?? group.resolved_tasks[index];
        if (!task) throw new Error("Harbor timeout probe did not resolve a frozen task execution identity.");
        const probeTask = group.tasks[index];
        const resolvedTask = group.resolved_tasks[index];
        slotSpecs.push({
          task,
          resolvedTask,
          taskProbe: {
            tasks: probeTask ? [probeTask] : [],
            resolved_tasks: resolvedTask ? [resolvedTask] : [],
            max_agent_timeout_sec: probeTask?.agent_timeout_sec ?? group.agent_timeout_sec,
            max_verifier_timeout_sec: probeTask?.verifier_timeout_sec ?? null,
            max_environment_build_timeout_sec: probeTask?.environment_build_timeout_sec ?? null
          }
        });
      }
    }
  }
  if (slotSpecs.length === 0) {
    return await failBeforeHarbor(
      runDir,
      config,
      "Harbor timeout probe resolved no executable task slots.",
      1
    );
  }
  const frozenTasks = slotSpecs.map((slot) => slot.task).filter(Boolean);
  if (frozenTasks.length > 0) assertUniqueHarborTaskExecutionIdentities(frozenTasks);
  const taskSelectionSha256 = selectionDigest(frozenTasks, options.tasksFileSha256);
  const runSlotIds = new Set();
  const launchSlots = [];
  for (let index = 0; index < slotSpecs.length; index += 1) {
    const spec = slotSpecs[index];
    const runSlot = freshRunSlotId(runSlotIds, deps.makeRunSlotId);
    const slotRoot = path.join(runDir, "run-slots", runSlot);
    const slotJobsDir = path.join(jobsDir, runSlot);
    const slotPlan = computeHarborTimeoutPlan(options, spec.taskProbe);
    const slotOptions = {
      ...attemptOptions,
      nConcurrentTrials: 1,
      k: 1,
      tasks: spec.task ? [spec.task] : []
    };
    const configPath = path.join(slotRoot, "resolved-job.config.json");
    const jobConfig = buildHarborJobConfig(slotOptions, slotJobsDir, slotPlan, spec.taskProbe);
    await writeJson(configPath, jobConfig);
    const jobConfigSha256 = await sha256File(configPath);
    let attestationPath = null;
    let attestation = null;
    if (spec.task) {
      attestation = buildResolvedTaskAttestationV2({
        jobConfigSha256,
        taskSelectionSha256,
        selectedTasks: [spec.task],
        resolvedTasks: spec.resolvedTask ? [spec.resolvedTask] : []
      });
      attestationPath = path.join(slotRoot, "resolved-task-attestation.v2.json");
      await writeJson(attestationPath, attestation);
    }
    const args = buildHarborArgs({
      ...slotOptions,
      taskSelectionFlag,
      capabilities,
      jobsDir: slotJobsDir,
      timeoutProbe: spec.taskProbe,
      timeoutPlan: slotPlan,
      configPath
    });
    launchSlots.push({
      index,
      runSlot,
      args,
      configPath,
      jobsDir: slotJobsDir,
      timeoutPlan: slotPlan,
      task: spec.task,
      attestation,
      attestationPath,
      jobConfigSha256
    });
  }
  harborArgs = launchSlots[0].args;
  config = {
    ...config,
    finished_at: null,
    exit_code: null,
    status: "running",
    command: [harborCommand, ...harborArgs],
    command_text: launchSlots.map((slot) => commandText(harborCommand, slot.args)).join("\n"),
    harbor_capabilities: capabilities,
    task_selection_flag: taskSelectionFlag,
    timeout_probe: timeoutProbe,
    timeout_plan: timeoutPlan,
    timeout_groups: launchSlots.map((slot) => ({
      run_slot: slot.runSlot,
      timeout_plan: slot.timeoutPlan,
      resolved_job_config_path: path.relative(runDir, slot.configPath).replace(/\\/g, "/")
    })),
    score_mode: options.benchmarkClass === "diagnostic" ? "diagnostic" : "standard_benchmark",
    resolved_job_config_path: path.relative(runDir, launchSlots[0].configPath).replace(/\\/g, "/"),
    resolved_job_config_paths: launchSlots.map((slot) =>
      path.relative(runDir, slot.configPath).replace(/\\/g, "/")),
    resolved_task_attestation_paths: launchSlots
      .filter((slot) => slot.attestationPath)
      .map((slot) => path.relative(runDir, slot.attestationPath).replace(/\\/g, "/")),
    task_selection_sha256: taskSelectionSha256,
    run_slots: launchSlots.map((slot) => ({
      run_slot: slot.runSlot,
      jobs_dir: path.relative(runDir, slot.jobsDir).replace(/\\/g, "/"),
      resolved_job_config_path: path.relative(runDir, slot.configPath).replace(/\\/g, "/"),
      ...(slot.attestationPath
        ? { resolved_task_attestation_path: path.relative(runDir, slot.attestationPath).replace(/\\/g, "/") }
        : {}),
      job_config_sha256: slot.jobConfigSha256,
      ...(slot.task ? {
        harbor_task_identity: harborTaskExecutionIdentity(slot.task),
        harbor_task_identity_sha256: harborTaskExecutionIdentitySha256(slot.task),
        selection_identity: taskSelectionIdentity(slot.task),
        selection_identity_sha256: taskSelectionIdentitySha256(slot.task),
        provenance_source: slot.task.provenance_source ?? null
      } : {}),
      timeout_plan: slot.timeoutPlan
    })),
    commands: launchSlots.map((slot) => [harborCommand, ...slot.args])
  };
  await writeRunFiles(runDir, config, harborCommand, harborArgs, env);
  await writeFile(path.join(runDir, "command.sh"), launchSlots
    .map((slot) => buildCommandScript(
      harborCommand,
      slot.args,
      { ...env, SIGMA_BENCH_RUN_SLOT: slot.runSlot }
    ).trimEnd())
    .join("\n"), "utf8");

  const cleanupBefore = await dockerCleanup(env.SIGMA_HARBOR_RUN_ID);
  await writeJson(path.join(runDir, "docker-cleanup-before.json"), cleanupBefore);
  if (!cleanupBefore.clean) {
    return await failBeforeHarbor(
      runDir,
      config,
      "Docker resource preflight failed; refusing to start Harbor while run-scoped resources cannot be cleaned.",
      1
    );
  }

  const harborResults = await runWithConcurrency(
    launchSlots,
    options.nConcurrentTrials,
    async (slot) => {
      process.stdout.write(`Running Harbor benchmark slot ${slot.runSlot}: ${commandText(harborCommand, slot.args)}\n`);
      const stdoutPath = path.join(runDir, `harbor-${slot.runSlot}.stdout.log`);
      const stderrPath = path.join(runDir, `harbor-${slot.runSlot}.stderr.log`);
      const rawPath = path.join(runDir, `result-${slot.runSlot}.raw.log`);
      try {
        return await runner(harborCommand, slot.args, {
          cwd: rootDir,
          env: { ...env, SIGMA_BENCH_RUN_SLOT: slot.runSlot },
          stdoutPath,
          stderrPath,
          rawPath
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await writeFile(stdoutPath, "", "utf8");
        await writeFile(stderrPath, `${message}\n`, "utf8");
        await writeFile(rawPath, `exit_code: 1\nstderr:\n${message}\n`, "utf8");
        return {
          exitCode: 1,
          stdout: "",
          stderr: message,
          error
        };
      }
    }
  );
  if (launchSlots.length > 1) {
    await writeFile(path.join(runDir, "harbor.stdout.log"), harborResults
      .map((result, index) => `[slot ${launchSlots[index].runSlot}]\n${result.stdout ?? ""}`).join("\n"), "utf8");
    await writeFile(path.join(runDir, "harbor.stderr.log"), harborResults
      .map((result, index) => `[slot ${launchSlots[index].runSlot}]\n${result.stderr ?? ""}`).join("\n"), "utf8");
    await writeFile(path.join(runDir, "result.raw.log"), harborResults
      .map((result, index) => `run_slot: ${launchSlots[index].runSlot}\nexit_code: ${result.exitCode}\n`).join("\n"), "utf8");
  } else {
    const result = harborResults[0];
    await writeFile(path.join(runDir, "harbor.stdout.log"), result.stdout ?? "", "utf8");
    await writeFile(path.join(runDir, "harbor.stderr.log"), result.stderr ?? "", "utf8");
    await writeFile(path.join(runDir, "result.raw.log"), `exit_code: ${result.exitCode}\n`, "utf8");
  }
  const harborExitCode = harborResults.find((result) => result.exitCode !== 0)?.exitCode ?? 0;
  let frozenRuntimeIntegrityError = null;
  try {
    assertFrozenHarborRuntimeUnchanged(
      frozenRuntimeSnapshot,
      await snapshotFrozenHarborRuntime(frozenHarborRuntimeDir)
    );
  } catch (error) {
    frozenRuntimeIntegrityError = error instanceof Error ? error.message : String(error);
  }
  const cleanupAfter = await dockerCleanup(env.SIGMA_HARBOR_RUN_ID);
  await writeJson(path.join(runDir, "docker-cleanup-after.json"), cleanupAfter);

  const finishedAt = new Date().toISOString();
  const effectiveExitCode = cleanupAfter.clean && frozenRuntimeIntegrityError === null ? harborExitCode : 1;
  config = {
    ...config,
    finished_at: finishedAt,
    exit_code: effectiveExitCode,
    status: statusFromExitCode(effectiveExitCode),
    run_slot_results: launchSlots.map((slot, index) => ({
      run_slot: slot.runSlot,
      exit_code: harborResults[index]?.exitCode ?? 1,
      stdout_path: `harbor-${slot.runSlot}.stdout.log`,
      stderr_path: `harbor-${slot.runSlot}.stderr.log`,
      raw_path: `result-${slot.runSlot}.raw.log`
    })),
    frozen_runtime_integrity: frozenRuntimeIntegrityError === null ? "passed" : "failed",
    docker_cleanup: cleanupAfter,
    notes: [
      ...config.notes,
      ...(!cleanupAfter.clean ? ["Run-scoped Docker resources remained after Harbor exited."] : []),
      ...(frozenRuntimeIntegrityError
        ? [`Frozen Harbor runtime postflight failed: ${frozenRuntimeIntegrityError}`]
        : [])
    ]
  };
  await writeJson(path.join(runDir, "config.json"), config);
  await ensurePlaceholderTask(runDir, {
    status: statusFromExitCode(harborExitCode),
    exit_code: harborExitCode,
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
