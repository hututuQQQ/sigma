#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  benchRootDir,
  buildCommandScript,
  buildHarborArgs,
  commandText,
  detectHarborRunCapabilities,
  detectTaskSelectionFlag,
  ensurePlaceholderTask,
  generateBenchReport,
  harborEnvForRun,
  loadDotEnv,
  makeRunId,
  packageAgentCli,
  resolveRunOptions,
  rootDir,
  runProcess,
  terminalBenchDataset,
  writeJson
} from "./bench-common.mjs";

function statusFromExitCode(exitCode) {
  return exitCode === 0 ? "passed" : "failed";
}

async function writeRunFiles(runDir, config, harborArgs, env) {
  await writeJson(path.join(runDir, "config.json"), config);
  await writeFile(path.join(runDir, "command.sh"), buildCommandScript(harborArgs, env), "utf8");
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
  await mkdir(runDir, { recursive: true });

  let taskSelectionFlag = null;
  let capabilities = {};
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
    command: ["harbor", ...harborArgs],
    command_text: commandText("harbor", harborArgs),
    exit_code: null,
    status: "running",
    notes: []
  };
  await writeRunFiles(runDir, config, harborArgs, env);

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

  process.stdout.write(`Inspecting Harbor run CLI support...\n`);
  const helpResult = await runner("harbor", ["run", "--help"], {
    cwd: rootDir,
    env,
    stdoutPath: path.join(runDir, "harbor-run-help.stdout.log"),
    stderrPath: path.join(runDir, "harbor-run-help.stderr.log"),
    rawPath: path.join(runDir, "harbor-run-help.raw.log")
  });
  const helpText = `${helpResult.stdout}\n${helpResult.stderr}`;
  await writeFile(path.join(runDir, "harbor-run-help.txt"), helpText, "utf8");
  capabilities = detectHarborRunCapabilities(helpText);
  taskSelectionFlag = detectTaskSelectionFlag(helpText);

  if (options.mode === "task") {
    if (!taskSelectionFlag) {
      return await failBeforeHarbor(
        runDir,
        config,
        "The installed Harbor CLI does not expose a recognized task selection flag. See harbor-run-help.txt.",
        2
      );
    }
  }

  harborArgs = buildHarborArgs({
    ...options,
    taskSelectionFlag,
    capabilities,
    jobsDir
  });
  config = {
    ...config,
    command: ["harbor", ...harborArgs],
    command_text: commandText("harbor", harborArgs),
    harbor_capabilities: capabilities,
    task_selection_flag: taskSelectionFlag
  };
  await writeRunFiles(runDir, config, harborArgs, env);

  process.stdout.write(`Running Harbor benchmark: ${commandText("harbor", harborArgs)}\n`);
  const harborResult = await runner("harbor", harborArgs, {
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

  const report = await generateBenchReport(runDir);
  process.stdout.write(`Benchmark artifacts: ${runDir}\n`);
  process.stdout.write(`Report: ${path.join(runDir, "report.md")}\n`);
  return { exitCode: harborResult.exitCode, runDir, report };
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
