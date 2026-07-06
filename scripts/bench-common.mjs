import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const artifactsDir = path.join(rootDir, ".artifacts");
export const benchRootDir = path.join(artifactsDir, "bench");
export const terminalBenchDataset = "terminal-bench/terminal-bench-2";
export const agentImportPath = "integrations.harbor.agent:AgentCliHarborAgent";
export const defaultAgentCliTarball = path.join(artifactsDir, "agent-cli-linux.tgz");

const COUNT_KEYS = ["passed", "failed", "infra_failed", "timeout", "api_error", "unknown"];
const FAILURE_COUNT_BUCKETS = new Map([
  ["node_missing", "infra_failed"],
  ["agent_setup_failed", "infra_failed"],
  ["api_error", "api_error"],
  ["agent_timeout", "timeout"],
  ["max_turns", "timeout"],
  ["tool_timeout", "timeout"],
  ["verifier_failed", "failed"],
  ["agent_crashed", "failed"],
  ["unknown", "unknown"]
]);

function pad2(value) {
  return String(value).padStart(2, "0");
}

function packageManagerCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

export function parseArgs(argv) {
  const flags = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      flags._.push(token);
      continue;
    }

    const eqIndex = token.indexOf("=");
    if (eqIndex !== -1) {
      flags[token.slice(2, eqIndex)] = token.slice(eqIndex + 1);
      continue;
    }

    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

export function loadDotEnv(filePath = path.join(rootDir, ".env"), env = process.env) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();
    const quoted = value.match(/^(['"])(.*)\1$/);
    if (quoted) value = quoted[2];
    if (env[key] === undefined) {
      env[key] = value;
    }
  }
}

export function safePathPart(value, fallback = "default") {
  const safe = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || fallback;
}

export function makeRunId(date, provider, model) {
  const stamp = [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate())
  ].join("");
  const time = [pad2(date.getHours()), pad2(date.getMinutes()), pad2(date.getSeconds())].join("");
  return `${stamp}-${time}-${safePathPart(provider)}-${safePathPart(model || "default")}`;
}

function asString(value, fallback = undefined) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asPositiveInt(value, fallback, name) {
  if (value === undefined || value === null || value === true || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function resolveRunOptions(argv, env = process.env) {
  const flags = parseArgs(argv);
  const mode = flags.smoke ? "smoke" : asString(flags.mode, "k");
  if (!["smoke", "k", "task"].includes(mode)) {
    throw new Error(`Unsupported benchmark mode: ${mode}`);
  }

  return {
    mode,
    provider: asString(flags.provider, env.AGENT_PROVIDER ?? "deepseek"),
    model: asString(flags.model, env.AGENT_MODEL),
    k: asPositiveInt(flags.k, 1, "--k"),
    taskId: asString(flags["task-id"]),
    maxTurns: asPositiveInt(env.AGENT_MAX_TURNS, 200, "AGENT_MAX_TURNS"),
    commandTimeoutSec: asPositiveInt(env.AGENT_COMMAND_TIMEOUT_SEC, 180, "AGENT_COMMAND_TIMEOUT_SEC"),
    maxWallTimeSec: asPositiveInt(env.AGENT_MAX_WALL_TIME_SEC, 7200, "AGENT_MAX_WALL_TIME_SEC")
  };
}

export function detectTaskSelectionFlag(helpText) {
  const candidates = ["--task-id", "--task", "--tasks", "--include-task"];
  return candidates.find((candidate) => new RegExp(`${candidate.replace("-", "\\-")}(?![A-Za-z0-9_-])`).test(helpText)) ?? null;
}

export function detectHarborRunCapabilities(helpText = "") {
  const hasAgentImportPath = /--agent-import-path\b/.test(helpText);
  const hasPlainAgentKwargs = /key=value/.test(helpText) || /format\s+'key=value'/.test(helpText);
  const hasNTasks = /--n-tasks\b/.test(helpText);
  const hasYes = /--yes\b/.test(helpText);

  return {
    agentFlag: hasAgentImportPath ? "--agent-import-path" : "--agent",
    agentKwargStyle: hasPlainAgentKwargs ? "plain" : "typed",
    taskLimitFlag: hasNTasks ? "-l" : "-k",
    yesFlag: hasYes ? "--yes" : null,
    taskSelectionFlag: detectTaskSelectionFlag(helpText)
  };
}

function formatAgentKwarg(key, type, value, capabilities) {
  const style = capabilities?.agentKwargStyle ?? "typed";
  return style === "plain" ? `${key}=${value}` : `${key}:${type}=${value}`;
}

export function buildHarborArgs(options) {
  const capabilities = options.capabilities ?? {};
  if (options.mode === "smoke") {
    const args = ["run", "-d", terminalBenchDataset, "-a", "oracle", "-l", "5"];
    if (options.jobsDir) args.push("--jobs-dir", options.jobsDir);
    if (capabilities.yesFlag) args.push(capabilities.yesFlag);
    return args;
  }

  const args = [
    "run",
    "-d",
    terminalBenchDataset,
    capabilities.agentFlag ?? "--agent-import-path",
    agentImportPath
  ];
  if (options.jobsDir) args.push("--jobs-dir", options.jobsDir);
  if (capabilities.yesFlag) args.push(capabilities.yesFlag);

  if (options.mode === "task") {
    if (!options.taskId) {
      throw new Error("Task mode requires --task-id <task-id>.");
    }
    const taskSelectionFlag = options.taskSelectionFlag ?? capabilities.taskSelectionFlag;
    if (!taskSelectionFlag) {
      throw new Error("Task mode requires a detected Harbor task selection flag.");
    }
    args.push(taskSelectionFlag, options.taskId);
  } else {
    args.push(capabilities.taskLimitFlag ?? "-k", String(options.k ?? 1));
  }

  args.push("--ak", formatAgentKwarg("provider", "str", options.provider, capabilities));
  if (options.model) {
    args.push("--ak", formatAgentKwarg("model", "str", options.model, capabilities));
  }
  args.push("--ak", formatAgentKwarg("max_turns", "int", options.maxTurns, capabilities));
  args.push("--ak", formatAgentKwarg("command_timeout_sec", "int", options.commandTimeoutSec, capabilities));
  args.push("--ak", formatAgentKwarg("max_wall_time_sec", "int", options.maxWallTimeSec, capabilities));
  return args;
}

export function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

export function commandText(command, args) {
  return [command, ...args].map(shellQuote).join(" ");
}

export function buildCommandScript(harborArgs, env) {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `cd ${shellQuote(rootDir)}`,
    `export AGENT_CLI_TARBALL=${shellQuote(env.AGENT_CLI_TARBALL)}`,
    `export PYTHONPATH=${shellQuote(rootDir)}"\${PYTHONPATH:+:\${PYTHONPATH}}"`,
    `harbor ${harborArgs.map(shellQuote).join(" ")}`,
    ""
  ].join("\n");
}

async function writeText(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

export async function runProcess(command, args, options = {}) {
  const cwd = options.cwd ?? rootDir;
  const env = options.env ?? process.env;
  let stdout = "";
  let stderr = "";

  const result = await new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
        windowsHide: true
      });
    } catch (error) {
      resolve({
        command,
        args,
        cwd,
        exitCode: 1,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}Failed to start ${command}: ${error instanceof Error ? error.message : String(error)}`,
        error
      });
      return;
    }

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      options.onStderr?.(text);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({
        command,
        args,
        cwd,
        exitCode: 1,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}Failed to start ${command}: ${error.message}`,
        error
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({
        command,
        args,
        cwd,
        exitCode: code ?? 1,
        stdout,
        stderr
      });
    });
  });

  if (options.stdoutPath) await writeText(options.stdoutPath, result.stdout);
  if (options.stderrPath) await writeText(options.stderrPath, result.stderr);
  if (options.rawPath) {
    await writeText(
      options.rawPath,
      [
        `$ ${commandText(command, args)}`,
        `cwd: ${cwd}`,
        `exit_code: ${result.exitCode}`,
        "stdout:",
        result.stdout,
        "stderr:",
        result.stderr,
        ""
      ].join("\n")
    );
  }

  return result;
}

export async function packageAgentCli(options = {}) {
  return await runProcess(packageManagerCommand(), ["package:agent-cli"], options);
}

async function readTextSafe(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export async function readJsonSafe(filePath) {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export async function readTraceEvents(tracePath) {
  const text = await readTextSafe(tracePath);
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Ignore malformed trace lines so one bad record does not hide the rest of the report.
    }
  }
  return events;
}

function containsTimedOut(value) {
  if (!value || typeof value !== "object") return false;
  if (value.timedOut === true) return true;
  return Object.values(value).some((nested) => containsTimedOut(nested));
}

export function traceHasToolTimeout(events) {
  return events.some((event) => event?.type === "tool_end" && containsTimedOut(event.metadata));
}

export function classifyFailure(input = {}) {
  const summary = input.summary ?? {};
  const logText = String(input.logText ?? "");
  const lower = logText.toLowerCase();
  const events = input.traceEvents ?? [];

  if (/node is required/i.test(logText) || /command -v node/i.test(logText)) return "node_missing";
  if (/harbor setup failed/i.test(logText) || /\/usr\/local\/bin\/agent --help failed/i.test(logText)) {
    return "agent_setup_failed";
  }
  if (/api request failed|rate limit|missing api key/i.test(logText) || /\b(401|403|429|500)\b/.test(logText)) {
    return "api_error";
  }
  if (summary.finish_reason === "max_turns") return "max_turns";
  if (traceHasToolTimeout(events)) return "tool_timeout";
  if (/max_wall_time|finish_reason[^\n]*max_wall_time/.test(lower) || /\btimeout\b|\btimed out\b/.test(lower)) {
    return "agent_timeout";
  }
  if (
    (summary.status === "completed" || /agent completed/i.test(logText)) &&
    /verifier failed|verify failed|benchmark failed|tests failed/i.test(logText)
  ) {
    return "verifier_failed";
  }
  if (input.exitCode !== undefined && input.exitCode !== 0) return "agent_crashed";
  if (summary.status === "error") return "agent_crashed";
  return "unknown";
}

function normalizeStatus(value) {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (["pass", "passed", "success", "succeeded"].includes(text)) return "passed";
  if (["fail", "failed", "error", "errored"].includes(text)) return "failed";
  if (["timeout", "timed_out"].includes(text)) return "failed";
  if (["unknown", "skipped"].includes(text)) return "unknown";
  return undefined;
}

function taskStatus(summary, metadata, runExitCode) {
  const metadataStatus = normalizeStatus(metadata.status ?? metadata.outcome ?? metadata.result);
  if (metadataStatus) return metadataStatus;
  if (summary.status === "completed" && runExitCode === 0) return "passed";
  if (summary.status === "error" || summary.status === "stopped") return "failed";
  if (runExitCode !== undefined && runExitCode !== 0) return "failed";
  return runExitCode === 0 ? "passed" : "unknown";
}

function addCount(counts, status, failureCategory) {
  if (status === "passed") {
    counts.passed += 1;
    return;
  }
  const bucket = FAILURE_COUNT_BUCKETS.get(failureCategory ?? "unknown") ?? "unknown";
  counts[bucket] += 1;
}

function relativePathOrNull(runDir, filePath) {
  if (!existsSync(filePath)) return null;
  return path.relative(runDir, filePath).replace(/\\/g, "/");
}

async function listTaskDirs(runDir) {
  const tasksDir = path.join(runDir, "tasks");
  if (!existsSync(tasksDir)) return [];
  const entries = await readdir(tasksDir);
  const dirs = [];
  for (const entry of entries.sort()) {
    const entryPath = path.join(tasksDir, entry);
    if ((await stat(entryPath)).isDirectory()) dirs.push(entryPath);
  }
  return dirs;
}

async function listJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const files = [];
  for (const entry of entries.sort()) {
    const entryPath = path.join(dir, entry);
    const entryStat = await stat(entryPath);
    if (entryStat.isDirectory()) {
      files.push(...(await listJsonFiles(entryPath)));
    } else if (entry === "result.json") {
      files.push(entryPath);
    }
  }
  return files;
}

function verifierMessage(trialResult) {
  if (trialResult?.exception_info?.exception_message) return trialResult.exception_info.exception_message;
  const rewards = trialResult?.verifier_result?.rewards;
  if (rewards && typeof rewards === "object") {
    const reward = rewards.reward;
    if (typeof reward === "number" && reward < 1) return `Harbor verifier reward was ${reward}.`;
  }
  return null;
}

async function readHarborTrialResults(runDir) {
  const jobsDir = path.join(runDir, "harbor-jobs");
  const resultFiles = await listJsonFiles(jobsDir);
  const results = [];
  for (const filePath of resultFiles) {
    const value = await readJsonSafe(filePath);
    if (value && typeof value === "object" && value.trial_name && value.task_name) {
      results.push({ ...value, result_path: path.relative(runDir, filePath).replace(/\\/g, "/") });
    }
  }
  return results.sort((a, b) => String(a.trial_name).localeCompare(String(b.trial_name)));
}

function mergeHarborTrialResult(task, trialResult) {
  const reward = trialResult?.verifier_result?.rewards?.reward;
  const exceptionMessage = trialResult?.exception_info?.exception_message;
  const next = {
    ...task,
    task_id: trialResult?.task_name ?? task.task_id,
    trial_name: trialResult?.trial_name ?? null,
    harbor_result_path: trialResult?.result_path ?? null,
    reward: typeof reward === "number" ? reward : null
  };

  if (exceptionMessage) {
    next.status = "failed";
    next.failure_category = classifyFailure({
      summary: {},
      logText: exceptionMessage,
      exitCode: 1
    });
    next.last_error = exceptionMessage;
    return next;
  }

  if (typeof reward === "number") {
    if (reward >= 1) {
      next.status = "passed";
      next.failure_category = null;
    } else {
      next.status = "failed";
      next.failure_category = "verifier_failed";
      next.last_error = next.last_error ?? verifierMessage(trialResult);
    }
  }

  return next;
}

async function taskReportFromDir(runDir, taskDir, index, config, globalLogText) {
  const metadataPath = path.join(taskDir, "metadata.json");
  const summaryPath = path.join(taskDir, "summary.json");
  const tracePath = path.join(taskDir, "trace.jsonl");
  const agentLogPath = path.join(taskDir, "agent.log");
  const verifierLogPath = path.join(taskDir, "verifier.log");

  const metadata = await readJsonSafe(metadataPath);
  const summary = await readJsonSafe(summaryPath);
  const traceEvents = await readTraceEvents(tracePath);
  const localLogText = [
    await readTextSafe(agentLogPath),
    await readTextSafe(verifierLogPath),
    JSON.stringify(metadata),
    JSON.stringify(summary)
  ].join("\n");
  const combinedLogText = `${globalLogText}\n${localLogText}`;
  const status = taskStatus(summary, metadata, config.exit_code);
  let failureCategory = status === "passed" ? null : classifyFailure({
    summary,
    traceEvents,
    logText: combinedLogText,
    exitCode: metadata.exit_code ?? config.exit_code
  });

  if (status === "failed" && failureCategory === "unknown" && summary.status === "completed") {
    failureCategory = "verifier_failed";
  }

  return {
    task_id: metadata.task_id ?? metadata.task_name ?? path.basename(taskDir),
    index,
    status,
    failure_category: failureCategory,
    summary_path: relativePathOrNull(runDir, summaryPath),
    trace_path: relativePathOrNull(runDir, tracePath),
    commands_executed: Number(summary.commands_executed ?? metadata.commands_executed ?? 0),
    input_tokens: Number(summary.input_tokens ?? metadata.n_input_tokens ?? 0),
    output_tokens: Number(summary.output_tokens ?? metadata.n_output_tokens ?? 0),
    duration_ms: Number(summary.duration_ms ?? metadata.duration_ms ?? 0),
    last_error: summary.last_error ?? metadata.error_message ?? null
  };
}

function syntheticRunTask(config, globalLogText) {
  const status = config.exit_code === 0 ? "passed" : "failed";
  const failureCategory =
    status === "passed"
      ? null
      : classifyFailure({
          summary: {},
          traceEvents: [],
          logText: globalLogText,
          exitCode: config.exit_code
        });
  return {
    task_id: "run",
    index: 0,
    status,
    failure_category: failureCategory,
    summary_path: null,
    trace_path: null,
    commands_executed: 0,
    input_tokens: 0,
    output_tokens: 0,
    duration_ms: 0,
    last_error: status === "passed" ? null : "No per-task artifacts were available; inspect harbor logs."
  };
}

function markdownEscape(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function formatMarkdownReport(report) {
  const lines = [
    `# Terminal-Bench Run ${report.run_id}`,
    "",
    `- Status: ${report.status}`,
    `- Provider: ${report.provider}`,
    `- Model: ${report.model ?? "default"}`,
    `- Dataset: ${report.dataset}`,
    `- Started: ${report.started_at ?? "unknown"}`,
    `- Finished: ${report.finished_at ?? "unknown"}`,
    `- Exit code: ${report.exit_code}`,
    "",
    "## Counts",
    "",
    "| passed | failed | infra_failed | timeout | api_error | unknown |",
    "| ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${report.counts.passed} | ${report.counts.failed} | ${report.counts.infra_failed} | ${report.counts.timeout} | ${report.counts.api_error} | ${report.counts.unknown} |`,
    "",
    "## Tasks",
    "",
    "| task | status | failure_category | commands | input_tokens | output_tokens | duration_ms | last_error |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | --- |"
  ];

  for (const task of report.tasks) {
    lines.push(
      `| ${markdownEscape(task.task_id)} | ${task.status} | ${task.failure_category ?? ""} | ${task.commands_executed} | ${task.input_tokens} | ${task.output_tokens} | ${task.duration_ms} | ${markdownEscape(task.last_error ?? "")} |`
    );
  }

  if (report.notes.length > 0) {
    lines.push("", "## Notes", "");
    for (const note of report.notes) {
      lines.push(`- ${note}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

export async function generateBenchReport(runDir) {
  const configPath = path.join(runDir, "config.json");
  const commandPath = path.join(runDir, "command.sh");
  const config = await readJsonSafe(configPath);
  const globalLogText = [
    await readTextSafe(path.join(runDir, "harbor.stdout.log")),
    await readTextSafe(path.join(runDir, "harbor.stderr.log")),
    await readTextSafe(path.join(runDir, "result.raw.log"))
  ].join("\n");
  const taskDirs = await listTaskDirs(runDir);
  const tasks = taskDirs.length > 0
    ? await Promise.all(taskDirs.map((taskDir, index) => taskReportFromDir(runDir, taskDir, index, config, globalLogText)))
    : [syntheticRunTask(config, globalLogText)];
  const harborTrialResults = await readHarborTrialResults(runDir);
  if (harborTrialResults.length === tasks.length) {
    for (let index = 0; index < tasks.length; index += 1) {
      tasks[index] = mergeHarborTrialResult(tasks[index], harborTrialResults[index]);
    }
  }

  const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, 0]));
  for (const task of tasks) {
    addCount(counts, task.status, task.failure_category);
  }

  const commandScript = await readTextSafe(commandPath);
  const notes = Array.isArray(config.notes) ? [...config.notes] : [];
  if (taskDirs.length === 0) {
    notes.push("Harbor did not expose per-task trace/summary files in a predictable place for this run; inspect harbor.stdout.log and harbor.stderr.log.");
  }

  const failedCount = counts.failed + counts.infra_failed + counts.timeout + counts.api_error + counts.unknown;
  const report = {
    run_id: config.run_id ?? path.basename(runDir),
    started_at: config.started_at ?? null,
    finished_at: config.finished_at ?? null,
    provider: config.provider ?? "unknown",
    model: config.model ?? null,
    dataset: config.dataset ?? terminalBenchDataset,
    k: config.k ?? null,
    command: config.command_text ?? commandScript.trim(),
    exit_code: Number(config.exit_code ?? 1),
    status: failedCount > 0 ? "failed" : config.status ?? (config.exit_code === 0 ? "passed" : "failed"),
    counts,
    tasks,
    notes
  };

  await writeText(path.join(runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeText(path.join(runDir, "report.md"), formatMarkdownReport(report));
  return report;
}

export async function writeJson(filePath, value) {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function ensurePlaceholderTask(runDir, metadata) {
  const tasksDir = path.join(runDir, "tasks");
  const existing = existsSync(tasksDir) ? await listTaskDirs(runDir) : [];
  if (existing.length > 0) return;

  const taskDir = path.join(tasksDir, "run");
  await mkdir(taskDir, { recursive: true });
  await writeJson(path.join(taskDir, "metadata.json"), {
    task_id: "run",
    ...metadata
  });
}

export function harborEnvForRun(runDir, env = process.env) {
  const next = {
    ...env,
    AGENT_CLI_TARBALL: env.AGENT_CLI_TARBALL || defaultAgentCliTarball,
    PYTHONPATH: [rootDir, env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    SIGMA_BENCH_RUN_DIR: runDir,
    PYTHONIOENCODING: env.PYTHONIOENCODING || "utf-8",
    PYTHONUTF8: env.PYTHONUTF8 || "1",
    NO_COLOR: env.NO_COLOR || "1",
    FORCE_COLOR: "0"
  };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    const value = next[key];
    if (typeof value === "string" && /^htpp:\/\//i.test(value)) {
      next[key] = `http://${value.slice(7)}`;
    }
  }
  return next;
}
