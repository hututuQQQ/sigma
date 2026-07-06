#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  benchRootDir,
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
  harborPythonCommand,
  harborEnvForRun,
  loadDotEnv,
  makeRunId,
  packageAgentCli,
  packageHarborRuntime,
  parseHarborTimeoutProbe,
  resolveHarborCommand,
  resolveRunOptions,
  rootDir,
  runProcess,
  terminalBenchDataset,
  writeJson
} from "./bench-common.mjs";

function statusFromExitCode(exitCode) {
  return exitCode === 0 ? "passed" : "failed";
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

  const runId = makeRunId(new Date(), options.provider, options.model);
  const runDir = path.join(benchRootDir, runId);
  const jobsDir = path.join(runDir, "harbor-jobs");
  const env = harborEnvForRun(runDir);
  const startedAt = new Date().toISOString();
  const runner = deps.runProcess ?? runProcess;
  const packager = deps.packageAgentCli ?? packageAgentCli;
  const harborRuntimePackager = deps.packageHarborRuntime ?? packageHarborRuntime;
  const harborCommandInfo = deps.resolveHarborCommand?.(env) ?? resolveHarborCommand(env);
  const harborCommand = harborCommandInfo.command;
  await mkdir(runDir, { recursive: true });

  let taskSelectionFlag = null;
  let capabilities = {};
  let harborVersion = null;
  let harborArgs = ["run", "--help"];
  let config = {
    run_id: runId,
    started_at: startedAt,
    finished_at: null,
    mode: options.mode,
    provider: options.provider,
    model: options.model ?? null,
    dataset: terminalBenchDataset,
    k: options.mode === "k" ? options.k : null,
    task_id: options.mode === "task" ? options.taskId : null,
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

  if (!existsSync(env.AGENT_CLI_TARBALL)) {
    return await failBeforeHarbor(
      runDir,
      config,
      `AGENT_CLI_TARBALL does not exist after packaging: ${env.AGENT_CLI_TARBALL}`,
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
  capabilities = detectHarborRunCapabilities(helpText);
  taskSelectionFlag = detectTaskSelectionFlag(helpText);

  let timeoutProbe = null;
  let timeoutPlan = null;
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

  let harborResult = null;
  let report = null;
  const resolvedJobConfigPath = path.join(runDir, "resolved-job.config.json");
  const attemptOptions = {
    ...options,
    agentCliTarball: env.AGENT_CLI_TARBALL
  };
  const resolvedJobConfig = buildHarborJobConfig(attemptOptions, jobsDir, timeoutPlan, timeoutProbe);
  await writeJson(resolvedJobConfigPath, resolvedJobConfig);
  harborArgs = buildHarborArgs({
    ...attemptOptions,
    taskSelectionFlag,
    capabilities,
    jobsDir,
    timeoutProbe,
    timeoutPlan,
    configPath: resolvedJobConfigPath
  });
  config = {
    ...config,
    finished_at: null,
    exit_code: null,
    status: "running",
    command: [harborCommand, ...harborArgs],
    command_text: commandText(harborCommand, harborArgs),
    harbor_capabilities: capabilities,
    task_selection_flag: taskSelectionFlag,
    timeout_probe: timeoutProbe,
    timeout_plan: timeoutPlan,
    score_mode: "standard_benchmark",
    resolved_job_config_path: path.relative(runDir, resolvedJobConfigPath).replace(/\\/g, "/")
  };
  await writeRunFiles(runDir, config, harborCommand, harborArgs, env);

  process.stdout.write(`Running Harbor benchmark: ${commandText(harborCommand, harborArgs)}\n`);
  harborResult = await runner(harborCommand, harborArgs, {
    cwd: rootDir,
    env,
    stdoutPath: path.join(runDir, "harbor.stdout.log"),
    stderrPath: path.join(runDir, "harbor.stderr.log"),
    rawPath: path.join(runDir, "result.raw.log")
  });

  const finishedAt = new Date().toISOString();
  config = {
    ...config,
    finished_at: finishedAt,
    exit_code: harborResult.exitCode,
    status: statusFromExitCode(harborResult.exitCode)
  };
  await writeJson(path.join(runDir, "config.json"), config);
  await ensurePlaceholderTask(runDir, {
    status: statusFromExitCode(harborResult.exitCode),
    exit_code: harborResult.exitCode,
    artifact_note: "Per-task Sigma traces are mirrored here when Harbor exposes task context to the adapter. If this is the only task entry, inspect harbor.stdout.log and harbor.stderr.log."
  });

  report = await generateBenchReport(runDir);

  process.stdout.write(`Benchmark artifacts: ${runDir}\n`);
  process.stdout.write(`Report: ${path.join(runDir, "report.md")}\n`);
  const exitCode = report?.status === "passed"
    ? 0
    : harborResult?.exitCode && harborResult.exitCode !== 0
      ? harborResult.exitCode
      : 1;
  return { exitCode, runDir, report };
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
