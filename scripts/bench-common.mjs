import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const artifactsDir = path.join(rootDir, ".artifacts");
export const benchRootDir = path.join(artifactsDir, "bench");
export const harborRuntimeDir = path.join(artifactsDir, "harbor-runtime");
export const terminalBenchDataset = "terminal-bench/terminal-bench-2";
export const portableAgentImportPath = "sigma_harbor_agent:SigmaCliHarborAgent";
export const agentImportPath = portableAgentImportPath;
export const removedHarborPackageName = ["integrations", "harbor"].join(".");
export const removedHarborDirectoryName = ["integrations", "harbor"].join("/");
export const removedHarborAdapterErrorMessage =
  `${removedHarborDirectoryName} has been removed. Use portable runtime import path ${portableAgentImportPath}.`;
export const defaultAgentCliTarball = path.join(artifactsDir, "agent-cli-linux-x64.tgz");
export const defaultAgentTimeoutFallbackSec = 1800;
export const defaultAgentTimeoutGraceSec = 120;
export const defaultAgentTimeoutLeniencyMultiplier = 1.5;
export const defaultAgentTimeoutLeniencyMinExtraSec = 600;
export const defaultBenchmarkTurnCadenceSec = 5;
export const defaultBenchmarkMaxTurnsCap = 1000;

const COUNT_KEYS = ["passed", "failed", "infra_failed", "timeout", "api_error", "unknown"];
const FAILURE_COUNT_BUCKETS = new Map([
  ["host_proxy_error", "infra_failed"],
  ["host_encoding_error", "infra_failed"],
  ["harbor_cli_error", "infra_failed"],
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
const SUGGESTED_OWNER_BY_FAILURE_CATEGORY = new Map([
  ["host_proxy_error", "environment"],
  ["host_encoding_error", "environment"],
  ["harbor_cli_error", "scripts/bench"],
  ["node_missing", "package-agent-cli"],
  ["agent_setup_failed", "portable/harbor"],
  ["api_error", "agent-model"],
  ["agent_timeout", "agent-runtime"],
  ["max_turns", "agent-runtime"],
  ["tool_timeout", "agent-tools"],
  ["verifier_failed", "agent-runtime"],
  ["agent_crashed", "agent-runtime"],
  ["unknown", "inspect"]
]);

export function suggestedOwnerForFailureCategory(failureCategory) {
  const normalized = typeof failureCategory === "string" && failureCategory.length > 0 ? failureCategory : "unknown";
  return SUGGESTED_OWNER_BY_FAILURE_CATEGORY.get(normalized) ?? "inspect";
}

function suggestedOwnerForTask(status, failureCategory, failureSignals = []) {
  if (status !== "passed" && Array.isArray(failureSignals) && failureSignals.includes("service_stopped_before_verifier")) {
    return "agent-tools/service";
  }
  return status === "passed" ? null : suggestedOwnerForFailureCategory(failureCategory);
}

function withSuggestedOwner(task) {
  const { harness_service_cleanup_stopped: _harnessServiceCleanupStopped, ...publicTask } = task;
  return {
    ...publicTask,
    suggested_owner: suggestedOwnerForTask(task.status, task.failure_category, task.failure_signals)
  };
}

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

export function defaultAgentCliTarballForEnv(env = process.env) {
  const targetArch = env.AGENT_TARGET_ARCH || "x64";
  return path.join(artifactsDir, `agent-cli-linux-${targetArch}.tgz`);
}

export function resolveHarborAgentImportPath(env = process.env) {
  if (typeof env.SIGMA_HARBOR_AGENT_IMPORT_PATH === "string" && env.SIGMA_HARBOR_AGENT_IMPORT_PATH.trim()) {
    return assertSupportedHarborAgentImportPath(env.SIGMA_HARBOR_AGENT_IMPORT_PATH.trim());
  }
  return portableAgentImportPath;
}

function isRemovedHarborAgentImportPath(importPath) {
  const text = String(importPath ?? "").trim();
  return text === removedHarborPackageName || text.startsWith(`${removedHarborPackageName}.`);
}

function assertSupportedHarborAgentImportPath(importPath) {
  if (isRemovedHarborAgentImportPath(importPath)) {
    throw new Error(removedHarborAdapterErrorMessage);
  }
  return importPath;
}

function resolveAgentCliTarballPath(options = {}, env = process.env) {
  return path.resolve(options.agentCliTarball ?? env.AGENT_CLI_TARBALL ?? defaultAgentCliTarballForEnv(env));
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

function asPositiveNumber(value, fallback, name) {
  if (value === undefined || value === null || value === true || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
}

function asOptionalPositiveInt(value, name) {
  if (value === undefined || value === null || value === true || value === "") return null;
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
    maxTurnsExplicit: env.AGENT_MAX_TURNS !== undefined && env.AGENT_MAX_TURNS !== null && env.AGENT_MAX_TURNS !== "",
    commandTimeoutSec: asPositiveInt(env.AGENT_COMMAND_TIMEOUT_SEC, 180, "AGENT_COMMAND_TIMEOUT_SEC"),
    maxWallTimeSec: asOptionalPositiveInt(env.AGENT_MAX_WALL_TIME_SEC, "AGENT_MAX_WALL_TIME_SEC"),
    agentTimeoutGraceSec: asPositiveInt(
      env.AGENT_TIMEOUT_GRACE_SEC,
      defaultAgentTimeoutGraceSec,
      "AGENT_TIMEOUT_GRACE_SEC"
    ),
    agentTimeoutLeniencyMultiplier: asPositiveNumber(
      env.AGENT_TIMEOUT_LENIENCY_MULTIPLIER,
      defaultAgentTimeoutLeniencyMultiplier,
      "AGENT_TIMEOUT_LENIENCY_MULTIPLIER"
    ),
    agentTimeoutLeniencyMinExtraSec: asPositiveInt(
      env.AGENT_TIMEOUT_LENIENCY_MIN_EXTRA_SEC,
      defaultAgentTimeoutLeniencyMinExtraSec,
      "AGENT_TIMEOUT_LENIENCY_MIN_EXTRA_SEC"
    )
  };
}

export function resolveHarborCommand(env = process.env, platform = process.platform) {
  if (typeof env.HARBOR_BIN === "string" && env.HARBOR_BIN.trim()) {
    const command = env.HARBOR_BIN.trim();
    return {
      command,
      source: "HARBOR_BIN",
      exists: existsSync(command)
    };
  }

  const candidates = [];
  if (platform === "win32") {
    if (env.APPDATA) {
      candidates.push({
        command: path.join(env.APPDATA, "uv", "tools", "harbor", "Scripts", "harbor.exe"),
        source: "APPDATA_UV_TOOL"
      });
    }
    if (env.USERPROFILE) {
      candidates.push({
        command: path.join(env.USERPROFILE, ".local", "bin", "harbor.exe"),
        source: "USERPROFILE_LOCAL_BIN"
      });
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate.command)) {
      return {
        ...candidate,
        exists: true
      };
    }
  }

  return {
    command: "harbor",
    source: "PATH",
    exists: null
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
  const hasAgentTimeoutMultiplier =
    /--agent-timeout-multi/i.test(helpText) ||
    /multiplier for agent\s+execution timeout/i.test(helpText);

  return {
    agentFlag: hasAgentImportPath ? "--agent-import-path" : "--agent",
    agentKwargStyle: hasPlainAgentKwargs ? "plain" : "typed",
    taskLimitFlag: hasNTasks ? "-l" : "-k",
    yesFlag: hasYes ? "--yes" : null,
    agentTimeoutMultiplierFlag: hasAgentTimeoutMultiplier ? "--agent-timeout-multiplier" : null,
    taskSelectionFlag: detectTaskSelectionFlag(helpText)
  };
}

function formatAgentKwarg(key, type, value, capabilities) {
  const style = capabilities?.agentKwargStyle ?? "typed";
  return style === "plain" ? `${key}=${value}` : `${key}:${type}=${value}`;
}

function asFinitePositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function maxProbeNumber(timeoutProbe, key) {
  const direct = asFinitePositiveNumber(timeoutProbe?.[`max_${key}`]);
  if (direct !== null) return direct;

  const tasks = Array.isArray(timeoutProbe?.tasks) ? timeoutProbe.tasks : [];
  const values = tasks
    .map((task) => asFinitePositiveNumber(task?.[key]))
    .filter((value) => value !== null);
  return values.length > 0 ? Math.max(...values) : null;
}

function formatMultiplier(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return String(Math.ceil(value * 100) / 100)
    .replace(/\.0+$/, "")
    .replace(/(\.\d)0$/, "$1");
}

export function computeHarborTimeoutPlan(options = {}, timeoutProbe = null) {
  const recommendedAgentTimeoutSec =
    maxProbeNumber(timeoutProbe, "agent_timeout_sec") ?? defaultAgentTimeoutFallbackSec;
  const requestedWallTimeSec = asFinitePositiveNumber(options.maxWallTimeSec);
  const leniencyMultiplier =
    asFinitePositiveNumber(options.agentTimeoutLeniencyMultiplier) ?? defaultAgentTimeoutLeniencyMultiplier;
  const leniencyMinExtraSec = Math.max(
    0,
    Math.ceil(asFinitePositiveNumber(options.agentTimeoutLeniencyMinExtraSec) ?? defaultAgentTimeoutLeniencyMinExtraSec)
  );
  const lenientAgentWallTimeSec = Math.ceil(
    Math.max(recommendedAgentTimeoutSec * leniencyMultiplier, recommendedAgentTimeoutSec + leniencyMinExtraSec)
  );
  const agentWallTimeSec = Math.ceil(requestedWallTimeSec ?? lenientAgentWallTimeSec);
  const graceSec = Math.max(
    0,
    Math.ceil(asFinitePositiveNumber(options.agentTimeoutGraceSec) ?? defaultAgentTimeoutGraceSec)
  );
  const cleanupGraceSec = graceSec;
  const harnessTimeoutSec = agentWallTimeSec + cleanupGraceSec;
  const agentTimeoutMultiplier =
    harnessTimeoutSec > recommendedAgentTimeoutSec
      ? formatMultiplier(harnessTimeoutSec / recommendedAgentTimeoutSec)
      : null;

  return {
    agent_wall_time_sec: agentWallTimeSec,
    agent_timeout_grace_sec: graceSec,
    cleanup_grace_sec: cleanupGraceSec,
    harness_timeout_sec: harnessTimeoutSec,
    effective_harness_timeout_sec: harnessTimeoutSec,
    leniency_multiplier: leniencyMultiplier,
    leniency_min_extra_sec: leniencyMinExtraSec,
    recommended_agent_timeout_sec: recommendedAgentTimeoutSec,
    recommended_verifier_timeout_sec: maxProbeNumber(timeoutProbe, "verifier_timeout_sec"),
    recommended_environment_build_timeout_sec: maxProbeNumber(timeoutProbe, "environment_build_timeout_sec"),
    agent_timeout_multiplier: agentTimeoutMultiplier,
    verifier_timeout_multiplier: agentTimeoutMultiplier,
    environment_build_timeout_multiplier: agentTimeoutMultiplier,
    source: requestedWallTimeSec ? "explicit_max_wall_time" : timeoutProbe ? "harbor_task_metadata" : "fallback"
  };
}

function normalizedTerminalBenchTaskName(taskId) {
  const text = String(taskId ?? "").trim();
  if (!text) return text;
  return text.includes("/") ? text : `terminal-bench/${text}`;
}

function selectedTaskRecords(timeoutProbe) {
  const tasks = Array.isArray(timeoutProbe?.resolved_tasks)
    ? timeoutProbe.resolved_tasks
    : Array.isArray(timeoutProbe?.tasks)
      ? timeoutProbe.tasks.map((task) => {
          if (task?.task_name) return { name: task.task_name };
          if (task?.task_path) return { path: task.task_path };
          return null;
        }).filter(Boolean)
      : [];
  return tasks
    .map((task) => {
      if (task?.name) return { name: task.name };
      if (task?.path) return { path: task.path };
      return null;
    })
    .filter(Boolean);
}

function benchmarkAgentKwargs(options, timeoutPlan = null) {
  const agentKwargs = {
    agent_cli_tarball: resolveAgentCliTarballPath(options, options.env ?? process.env),
    provider: options.provider
  };
  if (options.model) {
    agentKwargs.model = options.model;
  }

  if (timeoutPlan?.agent_wall_time_sec) {
    agentKwargs.max_wall_time_sec = timeoutPlan.agent_wall_time_sec;
  }
  if (timeoutPlan?.cleanup_grace_sec !== undefined) {
    agentKwargs.agent_timeout_grace_sec = timeoutPlan.cleanup_grace_sec;
  }
  return agentKwargs;
}

export function buildHarborJobConfig(options, jobsDir, timeoutPlan = null, timeoutProbe = null) {
  const agentName = options.mode === "smoke"
    ? "oracle"
    : assertSupportedHarborAgentImportPath(
        options.agentImportPath ?? resolveHarborAgentImportPath(options.env ?? process.env)
      );
  const agentKwargs = options.mode === "smoke" ? {} : benchmarkAgentKwargs(options, timeoutPlan);

  const config = {
    jobs_dir: jobsDir,
    agents: [
      {
        name: agentName,
        kwargs: agentKwargs
      }
    ]
  };

  const resolvedTasks = selectedTaskRecords(timeoutProbe);
  if (resolvedTasks.length > 0) {
    config.tasks = resolvedTasks;
  } else if (options.mode === "task") {
    config.tasks = [{ name: normalizedTerminalBenchTaskName(options.taskId) }];
  } else {
    config.datasets = [
      {
        name: terminalBenchDataset,
        n_tasks: options.mode === "smoke" ? 5 : options.k
      }
    ];
  }

  if (timeoutPlan?.agent_timeout_multiplier) {
    config.agent_timeout_multiplier = Number(timeoutPlan.agent_timeout_multiplier);
  }
  if (timeoutPlan?.verifier_timeout_multiplier) {
    config.verifier_timeout_multiplier = Number(timeoutPlan.verifier_timeout_multiplier);
  }
  if (timeoutPlan?.environment_build_timeout_multiplier) {
    config.environment_build_timeout_multiplier = Number(timeoutPlan.environment_build_timeout_multiplier);
  }

  return config;
}

export function buildHarborTimeoutProbeConfig(options, jobsDir) {
  return buildHarborJobConfig(options, jobsDir, null, null);
}

export function harborPythonCommand(env = process.env) {
  if (env.HARBOR_PYTHON) return env.HARBOR_PYTHON;
  if (process.platform === "win32" && env.HARBOR_BIN) {
    const sibling = path.join(path.dirname(env.HARBOR_BIN), "python.exe");
    if (existsSync(sibling)) return sibling;
  }
  if (process.platform === "win32" && env.APPDATA) {
    const candidate = path.join(env.APPDATA, "uv", "tools", "harbor", "Scripts", "python.exe");
    if (existsSync(candidate)) return candidate;
  }
  return "python";
}

export function parseHarborTimeoutProbe(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) {
    throw new Error("Harbor timeout probe did not print JSON.");
  }

  try {
    return JSON.parse(text);
  } catch {
    const jsonLine = text
      .split(/\r?\n/)
      .reverse()
      .find((line) => line.trim().startsWith("{") && line.trim().endsWith("}"));
    if (!jsonLine) {
      throw new Error("Harbor timeout probe output did not contain a JSON object.");
    }
    return JSON.parse(jsonLine);
  }
}

export function buildHarborArgs(options) {
  const capabilities = options.capabilities ?? {};
  if (options.configPath) {
    const args = ["run", "--config", options.configPath];
    if (capabilities.yesFlag) args.push(capabilities.yesFlag);
    return args;
  }

  if (options.mode === "smoke") {
    const args = ["run", "-d", terminalBenchDataset, "-a", "oracle", capabilities.taskLimitFlag ?? "-l", "5"];
    if (options.jobsDir) args.push("--jobs-dir", options.jobsDir);
    if (capabilities.yesFlag) args.push(capabilities.yesFlag);
    return args;
  }

  const selectedAgentImportPath = assertSupportedHarborAgentImportPath(
    options.agentImportPath ?? resolveHarborAgentImportPath(options.env ?? process.env)
  );
  const args = [
    "run",
    "-d",
    terminalBenchDataset,
    capabilities.agentFlag ?? "--agent-import-path",
    selectedAgentImportPath
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

  const timeoutPlan = options.timeoutPlan ?? computeHarborTimeoutPlan(options, options.timeoutProbe);
  const agentTimeoutMultiplier = timeoutPlan.agent_timeout_multiplier;
  if (capabilities.agentTimeoutMultiplierFlag && agentTimeoutMultiplier) {
    args.push(capabilities.agentTimeoutMultiplierFlag, agentTimeoutMultiplier);
  }

  args.push("--ak", formatAgentKwarg("agent_cli_tarball", "str", resolveAgentCliTarballPath(options, options.env ?? process.env), capabilities));
  args.push("--ak", formatAgentKwarg("provider", "str", options.provider, capabilities));
  if (options.model) {
    args.push("--ak", formatAgentKwarg("model", "str", options.model, capabilities));
  }
  args.push("--ak", formatAgentKwarg("max_turns", "int", options.maxTurns, capabilities));
  args.push("--ak", formatAgentKwarg("command_timeout_sec", "int", options.commandTimeoutSec, capabilities));
  args.push("--ak", formatAgentKwarg("max_wall_time_sec", "int", timeoutPlan.agent_wall_time_sec, capabilities));
  args.push("--ak", formatAgentKwarg("harness_timeout_sec", "int", timeoutPlan.effective_harness_timeout_sec, capabilities));
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

export function buildCommandScript(commandOrArgs, maybeArgs, maybeEnv) {
  const harborCommand = Array.isArray(commandOrArgs) ? "harbor" : commandOrArgs;
  const harborArgs = Array.isArray(commandOrArgs) ? commandOrArgs : maybeArgs;
  const env = Array.isArray(commandOrArgs) ? maybeArgs : maybeEnv;
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `cd ${shellQuote(rootDir)}`,
    `export AGENT_CLI_TARBALL=${shellQuote(env.AGENT_CLI_TARBALL)}`,
    `export PYTHONPATH=${shellQuote(env.PYTHONPATH ?? "")}`,
    `${shellQuote(harborCommand)} ${harborArgs.map(shellQuote).join(" ")}`,
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

export async function packageHarborRuntime(options = {}) {
  return await runProcess(packageManagerCommand(), ["package:harbor-runtime"], options);
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

function summaryHasFinishReason(summary, finishReason) {
  return summary?.finish_reason === finishReason || summary?.finishReason === finishReason;
}

function logIndicatesMaxWallTime(logText = "") {
  return (
    /finish[_ ]?reason"?\s*[:=]\s*"?max_wall_time/i.test(logText) ||
    /finishReason"?\s*[:=]\s*"?max_wall_time/.test(logText) ||
    /agent execution timed out|timed out after|max wall time/i.test(logText)
  );
}

function logIndicatesGenericTimeout(logText = "") {
  return /agent execution timed out|execution timed out|timed out after|\btimed out\b/i.test(logText);
}

export function classifyFailure(input = {}) {
  const summary = input.summary ?? {};
  const logText = String(input.logText ?? "");
  const events = input.traceEvents ?? [];

  if (/unknown scheme for proxy url/i.test(logText) || /\bhtpp:\/\//i.test(logText)) return "host_proxy_error";
  if (/unicodeencodeerror/i.test(logText) || /codec can't encode character/i.test(logText) || /illegal multibyte sequence/i.test(logText)) {
    return "host_encoding_error";
  }
  if (
    /harbor timeout probe (?:failed|output)|failed to start harbor|spawn harbor enoent|harbor(?:\.exe)?[^\n]*(?:enoent|command not found|not recognized)/i.test(
      logText
    )
  ) {
    return "harbor_cli_error";
  }
  if (/traceback \(most recent call last\)/i.test(logText) && /site-packages[\\/]+harbor|harbor[\\/]+cli/i.test(logText)) {
    return "harbor_cli_error";
  }
  if (/node is required|no bundled node and no system node/i.test(logText) || /command -v node/i.test(logText)) {
    return "node_missing";
  }
  if (/harbor setup failed/i.test(logText) || /\/usr\/local\/bin\/agent --help failed/i.test(logText)) {
    return "agent_setup_failed";
  }
  if (/api request failed|rate limit|missing api key/i.test(logText) || /\b(401|403|429|500)\b/.test(logText)) {
    return "api_error";
  }
  if (summaryHasFinishReason(summary, "max_turns")) return "max_turns";
  if (traceHasToolTimeout(events)) return "tool_timeout";
  if (summaryHasFinishReason(summary, "max_wall_time") || logIndicatesMaxWallTime(logText) || logIndicatesGenericTimeout(logText)) {
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

function addSignal(signals, signal) {
  if (signal && !signals.includes(signal)) signals.push(signal);
}

function missingPythonModuleSignals(logText = "") {
  const signals = [];
  const pattern = /ModuleNotFoundError:\s+No module named ['"]([^'"]+)['"]/g;
  for (let match = pattern.exec(logText); match !== null; match = pattern.exec(logText)) {
    addSignal(signals, `missing_python_module:${match[1]}`);
  }
  return signals;
}

function serviceCleanupStoppedFromSummary(summary = {}) {
  const harness = summary && typeof summary === "object" && summary.harness && typeof summary.harness === "object"
    ? summary.harness
    : {};
  const serviceCleanup = harness.service_cleanup && typeof harness.service_cleanup === "object"
    ? harness.service_cleanup
    : {};
  return Array.isArray(serviceCleanup.stopped) ? serviceCleanup.stopped.filter(Boolean).map(String) : [];
}

function collectFailureSignals(input = {}) {
  const signals = [];
  for (const signal of Array.isArray(input.existingSignals) ? input.existingSignals : []) {
    addSignal(signals, String(signal));
  }

  const metadata = input.metadata ?? {};
  for (const signal of Array.isArray(metadata.failure_signals) ? metadata.failure_signals : []) {
    addSignal(signals, String(signal));
  }

  for (const precheck of Array.isArray(metadata.precheck_results) ? metadata.precheck_results : []) {
    if (Number(precheck?.exit_code ?? 0) !== 0) {
      addSignal(signals, precheck?.kind === "validation" ? "validation_failed" : "precheck_failed");
    }
  }

  const summary = input.summary ?? {};
  const harness = summary && typeof summary === "object" && summary.harness && typeof summary.harness === "object"
    ? summary.harness
    : {};

  for (const result of [
    ...(Array.isArray(harness.validation_results) ? harness.validation_results : []),
    ...(Array.isArray(harness.precheck_results) ? harness.precheck_results : [])
  ]) {
    if (Number(result?.exit_code ?? 0) !== 0) {
      addSignal(signals, result?.kind === "precheck" ? "precheck_failed" : "validation_failed");
    }
  }

  for (const decision of Array.isArray(metadata.retry_decisions) ? metadata.retry_decisions : []) {
    if (decision?.action === "skipped") {
      addSignal(signals, "retry_cut_short_by_harbor");
    }
    if (decision?.action === "started" && String(decision?.trigger ?? "").includes("validation")) {
      addSignal(signals, "validation_retry_used");
    }
  }

  for (const decision of Array.isArray(harness.retry_decisions) ? harness.retry_decisions : []) {
    if (decision?.action === "skipped") {
      addSignal(signals, "retry_cut_short_by_budget");
    }
    if (decision?.action === "started" && String(decision?.trigger ?? "").includes("validation")) {
      addSignal(signals, "validation_retry_used");
    }
  }

  if (harness.post_run_cleanup?.warning) {
    addSignal(signals, "post_run_cleanup_warning");
  }
  const stoppedServices = [
    ...serviceCleanupStoppedFromSummary(summary),
    ...(Array.isArray(input.serviceCleanupStopped) ? input.serviceCleanupStopped.filter(Boolean).map(String) : [])
  ];
  if (input.verifierFailed === true && stoppedServices.length > 0) {
    addSignal(signals, "service_stopped_before_verifier");
  }

  const events = input.traceEvents ?? [];
  const verifierFailures = Array.isArray(input.verifierFailures) ? input.verifierFailures : [];
  const verifierText = verifierFailures
    .map((failure) => `${failure?.name ?? ""}\n${failure?.message ?? ""}\n${failure?.trace ?? ""}`)
    .join("\n");
  const logText = `${input.logText ?? ""}\n${verifierText}`;

  if (
    summaryHasFinishReason(summary, "max_wall_time") ||
    logIndicatesMaxWallTime(logText)
  ) {
    addSignal(signals, "max_wall_time");
  }
  if (traceHasToolTimeout(events)) {
    addSignal(signals, "tool_timeout");
  }
  for (const signal of missingPythonModuleSignals(logText)) {
    addSignal(signals, signal);
  }

  return signals;
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

async function listNamedFiles(dir, fileName) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const files = [];
  for (const entry of entries.sort()) {
    const entryPath = path.join(dir, entry);
    const entryStat = await stat(entryPath);
    if (entryStat.isDirectory()) {
      files.push(...(await listNamedFiles(entryPath, fileName)));
    } else if (entry === fileName) {
      files.push(entryPath);
    }
  }
  return files;
}

function summarizeTraceEvents(events) {
  const summary = {
    status: undefined,
    finish_reason: undefined,
    commands_executed: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_tokens: 0,
    duration_ms: 0,
    last_error: null
  };

  for (const event of events) {
    const metadata = event?.metadata ?? {};
    if (event?.type === "usage") {
      const usage = metadata.usage ?? {};
      summary.input_tokens += Number(usage.inputTokens ?? usage.input_tokens ?? 0);
      summary.output_tokens += Number(usage.outputTokens ?? usage.output_tokens ?? 0);
      summary.cache_tokens += Number(usage.cacheTokens ?? usage.cache_tokens ?? 0);
    }
    if (event?.type === "tool_end" && metadata.toolName === "bash") {
      summary.commands_executed += 1;
    }
    if (event?.type === "error" && metadata.message) {
      summary.last_error = String(metadata.message);
    }
    if (event?.type === "run_end" && metadata.result && typeof metadata.result === "object") {
      const result = metadata.result;
      summary.status = result.status ?? summary.status;
      summary.finish_reason = result.finishReason ?? result.finish_reason ?? summary.finish_reason;
      summary.commands_executed = Number(result.commandsExecuted ?? result.commands_executed ?? summary.commands_executed);
      summary.input_tokens = Number(result.usage?.inputTokens ?? result.input_tokens ?? summary.input_tokens);
      summary.output_tokens = Number(result.usage?.outputTokens ?? result.output_tokens ?? summary.output_tokens);
      summary.cache_tokens = Number(result.usage?.cacheTokens ?? result.cache_tokens ?? summary.cache_tokens);
      summary.duration_ms = Number(result.durationMs ?? result.duration_ms ?? summary.duration_ms);
      summary.last_error = result.lastError ?? result.last_error ?? summary.last_error;
    }
  }

  return summary;
}

async function readTrialTraceFallback(runDir, trialDir) {
  const traceFiles = await listNamedFiles(trialDir, "trace.jsonl");
  const preferred = traceFiles.find((filePath) => /[\\/]agent[\\/]trace\.jsonl$/i.test(filePath)) ?? traceFiles[0];
  if (!preferred) {
    return {
      agent_trace_path: null,
      agent_trace_summary: {},
      agent_trace_events: []
    };
  }
  const events = await readTraceEvents(preferred);
  return {
    agent_trace_path: relativePathOrNull(runDir, preferred),
    agent_trace_summary: summarizeTraceEvents(events),
    agent_trace_events: events
  };
}

function normalizeTaskKeys(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return [];
  const lastSlash = text.split("/").filter(Boolean).pop();
  const withoutTerminalBench = text.replace(/^terminal-bench\//, "");
  return [...new Set([text, lastSlash, withoutTerminalBench].filter(Boolean))];
}

function tasksMatchTrial(task, trialResult) {
  const taskKeys = normalizeTaskKeys(task.task_id);
  const trialKeys = [
    ...normalizeTaskKeys(trialResult?.task_name),
    ...normalizeTaskKeys(trialResult?.trial_name)
  ];
  if (task.trial_name && String(task.trial_name) === String(trialResult?.trial_name)) return true;
  return taskKeys.some((key) => trialKeys.includes(key));
}

function shortVerifierText(value, maxChars = 600) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function parseVerifierFailures(ctrf) {
  const tests = ctrf?.results?.tests;
  if (!Array.isArray(tests)) return [];
  return tests
    .filter((test) => test && typeof test === "object" && String(test.status ?? "").toLowerCase() !== "passed")
    .map((test) => ({
      name: String(test.name ?? "unknown"),
      status: String(test.status ?? test.raw_status ?? "failed"),
      message: shortVerifierText(test.message ?? ""),
      trace: shortVerifierText(test.trace ?? "", 1000)
    }));
}

function parseStdoutVerifierFailures(stdoutText) {
  const failures = [];
  for (const line of String(stdoutText ?? "").split(/\r?\n/)) {
    const match = line.match(/^FAILED\s+(.+?)(?:\s+-\s+(.+))?$/);
    if (!match) continue;
    failures.push({
      name: match[1],
      status: "failed",
      message: shortVerifierText(match[2] ?? ""),
      trace: ""
    });
  }
  return failures;
}

async function readVerifierDetails(runDir, trialDir) {
  const verifierDir = path.join(trialDir, "verifier");
  const ctrfPath = path.join(verifierDir, "ctrf.json");
  const stdoutPath = path.join(verifierDir, "test-stdout.txt");
  const ctrf = await readJsonSafe(ctrfPath);
  const stdoutText = await readTextSafe(stdoutPath);
  const failedTests = parseVerifierFailures(ctrf);
  return {
    verifier_failed_tests: failedTests.length > 0 ? failedTests : parseStdoutVerifierFailures(stdoutText),
    verifier_log_path: relativePathOrNull(runDir, stdoutPath)
  };
}

function verifierMessage(trialResult) {
  const failedTest = trialResult?.verifier_failed_tests?.[0];
  if (failedTest) {
    const detail = failedTest.message || failedTest.trace;
    return detail ? `${failedTest.name}: ${detail}` : `${failedTest.name} failed.`;
  }
  if (trialResult?.exception_info?.exception_message) return trialResult.exception_info.exception_message;
  const rewards = trialResult?.verifier_result?.rewards;
  if (rewards && typeof rewards === "object") {
    const reward = rewards.reward;
    if (typeof reward === "number" && reward < 1) return `Harbor verifier reward was ${reward}.`;
  }
  return null;
}

function verifierStatusFromReward(reward, failedTests = []) {
  if (typeof reward === "number") return reward >= 1 ? "passed" : "failed";
  return Array.isArray(failedTests) && failedTests.length > 0 ? "failed" : null;
}

function agentExceptionFromTrial(trialResult, exceptionMessage) {
  if (!exceptionMessage) return null;
  const exceptionInfo = trialResult?.exception_info;
  return {
    message: exceptionMessage,
    type: typeof exceptionInfo?.exception_type === "string" ? exceptionInfo.exception_type : null
  };
}

async function readHarborTrialResults(runDir) {
  const jobsDir = path.join(runDir, "harbor-jobs");
  const resultFiles = await listJsonFiles(jobsDir);
  const results = [];
  for (const filePath of resultFiles) {
    const value = await readJsonSafe(filePath);
    if (value && typeof value === "object" && value.trial_name && value.task_name) {
      const trialDir = path.dirname(filePath);
      results.push({
        ...value,
        ...(await readVerifierDetails(runDir, trialDir)),
        ...(await readTrialTraceFallback(runDir, trialDir)),
        result_path: path.relative(runDir, filePath).replace(/\\/g, "/")
      });
    }
  }
  return results.sort((a, b) => String(a.trial_name).localeCompare(String(b.trial_name)));
}

function mergeHarborTrialResults(tasks, harborTrialResults) {
  const remaining = [...harborTrialResults];
  const merged = tasks.map((task) => {
    const matchIndex = remaining.findIndex((trialResult) => tasksMatchTrial(task, trialResult));
    if (matchIndex === -1) return task;
    const [trialResult] = remaining.splice(matchIndex, 1);
    return mergeHarborTrialResult(task, trialResult);
  });

  if (remaining.length === harborTrialResults.length && harborTrialResults.length === tasks.length) {
    return tasks.map((task, index) => mergeHarborTrialResult(task, harborTrialResults[index]));
  }

  return merged;
}

function mergeHarborTrialResult(task, trialResult) {
  const reward = trialResult?.verifier_result?.rewards?.reward;
  const exceptionMessage = trialResult?.exception_info?.exception_message;
  const traceSummary = trialResult?.agent_trace_summary ?? {};
  const verifierFailedTests = Array.isArray(trialResult?.verifier_failed_tests) ? trialResult.verifier_failed_tests : [];
  const next = {
    ...task,
    task_id: trialResult?.task_name ?? task.task_id,
    trial_name: trialResult?.trial_name ?? null,
    harbor_result_path: trialResult?.result_path ?? null,
    reward: typeof reward === "number" ? reward : null,
    verifier_status: verifierStatusFromReward(reward, verifierFailedTests),
    agent_exception: agentExceptionFromTrial(trialResult, exceptionMessage),
    infra_warnings: Array.isArray(task.infra_warnings) ? [...task.infra_warnings] : [],
    trace_path: task.trace_path ?? trialResult?.agent_trace_path ?? null,
    commands_executed: task.commands_executed || Number(traceSummary.commands_executed ?? 0),
    input_tokens: task.input_tokens || Number(traceSummary.input_tokens ?? 0),
    output_tokens: task.output_tokens || Number(traceSummary.output_tokens ?? 0),
    duration_ms: task.duration_ms || Number(traceSummary.duration_ms ?? 0),
    last_error: task.last_error ?? traceSummary.last_error ?? null,
    verifier_failed_tests: verifierFailedTests,
    verifier_log_path: trialResult?.verifier_log_path ?? null,
    failure_signals: Array.isArray(task.failure_signals) ? [...task.failure_signals] : [],
    harness_service_cleanup_stopped: Array.isArray(task.harness_service_cleanup_stopped)
      ? [...task.harness_service_cleanup_stopped]
      : []
  };
  const trialLogText = `${exceptionMessage ?? ""}\n${JSON.stringify(trialResult)}`;

  if (exceptionMessage && typeof reward === "number" && reward >= 1) {
    next.status = "passed";
    next.failure_category = null;
    next.failure_signals = [];
    addSignal(next.infra_warnings, "agent_exception_after_verifier_pass");
    return next;
  }

  if (exceptionMessage) {
    next.status = "failed";
    next.failure_category = classifyFailure({
      summary: traceSummary,
      traceEvents: trialResult?.agent_trace_events ?? [],
      logText: exceptionMessage,
      exitCode: 1
    });
    next.last_error = exceptionMessage;
    next.failure_signals = collectFailureSignals({
      existingSignals: next.failure_signals,
      summary: traceSummary,
      traceEvents: trialResult?.agent_trace_events ?? [],
      logText: trialLogText,
      verifierFailures: next.verifier_failed_tests,
      verifierFailed: next.failure_category === "verifier_failed",
      serviceCleanupStopped: next.harness_service_cleanup_stopped
    });
    return next;
  }

  if (typeof reward === "number") {
    if (reward >= 1) {
      next.status = "passed";
      next.failure_category = null;
      next.failure_signals = [];
    } else {
      next.status = "failed";
      next.failure_category = "verifier_failed";
      next.last_error = next.last_error ?? verifierMessage(trialResult);
    }
  } else if (traceSummary.status && next.status === "unknown") {
    next.status = taskStatus(traceSummary, {}, undefined);
    next.failure_category =
      next.status === "passed"
        ? null
        : classifyFailure({
            summary: traceSummary,
            traceEvents: trialResult?.agent_trace_events ?? [],
            logText: JSON.stringify(trialResult),
            exitCode: undefined
          });
  }

  next.failure_signals = next.status === "passed"
    ? []
    : collectFailureSignals({
        existingSignals: next.failure_signals,
        summary: traceSummary,
        traceEvents: trialResult?.agent_trace_events ?? [],
        logText: trialLogText,
        verifierFailures: next.verifier_failed_tests,
        verifierFailed: next.status === "failed" && next.failure_category === "verifier_failed",
        serviceCleanupStopped: next.harness_service_cleanup_stopped
      });
  if (next.status === "failed" && next.failure_category === "verifier_failed" && traceSummary.status === "completed") {
    addSignal(next.failure_signals, "agent_completed_but_verifier_failed");
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
  const classifyExitCode = summary.status === "completed" ? 0 : metadata.exit_code ?? config.exit_code;
  let failureCategory = status === "passed" ? null : classifyFailure({
    summary,
    traceEvents,
    logText: combinedLogText,
    exitCode: classifyExitCode
  });

  if (status === "failed" && failureCategory === "unknown" && summary.status === "completed") {
    failureCategory = "verifier_failed";
  }
  const failureSignals = status === "passed"
    ? []
    : collectFailureSignals({
        metadata,
        summary,
        traceEvents,
        logText: combinedLogText,
        verifierFailed: status === "failed" && failureCategory === "verifier_failed"
      });
  if (status === "failed" && failureCategory === "verifier_failed" && summary.status === "completed") {
    addSignal(failureSignals, "agent_completed_but_verifier_failed");
  }

  return {
    task_id: metadata.task_id ?? metadata.task_name ?? path.basename(taskDir),
    index,
    status,
    failure_category: failureCategory,
    failure_signals: failureSignals,
    summary_path: relativePathOrNull(runDir, summaryPath),
    trace_path: relativePathOrNull(runDir, tracePath),
    commands_executed: Number(summary.commands_executed ?? metadata.commands_executed ?? 0),
    input_tokens: Number(summary.input_tokens ?? metadata.n_input_tokens ?? 0),
    output_tokens: Number(summary.output_tokens ?? metadata.n_output_tokens ?? 0),
    duration_ms: Number(summary.duration_ms ?? metadata.duration_ms ?? 0),
    last_error: summary.last_error ?? metadata.error_message ?? null,
    trial_name: null,
    harbor_result_path: null,
    reward: null,
    verifier_status: null,
    agent_exception: null,
    infra_warnings: [],
    verifier_failed_tests: [],
    verifier_log_path: null,
    harness_service_cleanup_stopped: serviceCleanupStoppedFromSummary(summary)
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
    failure_signals: status === "passed" ? [] : collectFailureSignals({ logText: globalLogText }),
    summary_path: null,
    trace_path: null,
    commands_executed: 0,
    input_tokens: 0,
    output_tokens: 0,
    duration_ms: 0,
    last_error: status === "passed" ? null : "No per-task artifacts were available; inspect harbor logs.",
    trial_name: null,
    harbor_result_path: null,
    reward: null,
    verifier_status: null,
    agent_exception: null,
    infra_warnings: [],
    verifier_failed_tests: [],
    verifier_log_path: null
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
    `- Score status: ${report.score_status ?? report.status}`,
    `- Infra status: ${report.infra_status ?? "unknown"}`,
    `- Provider: ${report.provider}`,
    `- Model: ${report.model ?? "default"}`,
    `- Dataset: ${report.dataset}`,
    `- Score mode: ${report.score_mode ?? "standard_benchmark"}`,
    `- Started: ${report.started_at ?? "unknown"}`,
    `- Finished: ${report.finished_at ?? "unknown"}`,
    `- Exit code: ${report.exit_code}`,
    `- Harbor exit code: ${report.harbor_exit_code ?? report.exit_code}`,
    `- Command: ${markdownEscape(report.command ?? "")}`,
    `- Harbor: ${markdownEscape(report.harbor_command ?? "harbor")}${report.harbor_version ? ` (${markdownEscape(report.harbor_version)})` : ""}`,
    "",
    "## Timeout Plan",
    "",
    `- Source: ${report.timeout_plan?.source ?? "unknown"}`,
    `- Recommended agent timeout sec: ${report.timeout_plan?.recommended_agent_timeout_sec ?? "unknown"}`,
    `- Agent wall time sec: ${report.timeout_plan?.agent_wall_time_sec ?? "unknown"}`,
    `- Harness timeout sec: ${report.timeout_plan?.harness_timeout_sec ?? "unknown"}`,
    `- Effective harness timeout sec: ${report.timeout_plan?.effective_harness_timeout_sec ?? report.timeout_plan?.harness_timeout_sec ?? "unknown"}`,
    `- Agent timeout multiplier: ${report.timeout_plan?.agent_timeout_multiplier ?? "none"}`,
    "",
    "## Counts",
    "",
    "| passed | failed | infra_failed | timeout | api_error | unknown |",
    "| ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${report.counts.passed} | ${report.counts.failed} | ${report.counts.infra_failed} | ${report.counts.timeout} | ${report.counts.api_error} | ${report.counts.unknown} |`,
    "",
    "## Tasks",
    "",
    "| task | status | failure_category | suggested_owner | warnings | verifier_status | failure_signals | commands | input_tokens | output_tokens | duration_ms | last_error |",
    "| --- | --- | --- | --- | ---: | --- | --- | ---: | ---: | ---: | ---: | --- |"
  ];

  for (const task of report.tasks) {
    const failureSignals = Array.isArray(task.failure_signals) ? task.failure_signals.join(", ") : "";
    const suggestedOwner = task.suggested_owner ?? suggestedOwnerForTask(task.status, task.failure_category, task.failure_signals) ?? "";
    const warningCount = Array.isArray(task.infra_warnings) ? task.infra_warnings.length : 0;
    lines.push(
      `| ${markdownEscape(task.task_id)} | ${task.status} | ${task.failure_category ?? ""} | ${markdownEscape(suggestedOwner)} | ${warningCount} | ${task.verifier_status ?? ""} | ${markdownEscape(failureSignals)} | ${task.commands_executed} | ${task.input_tokens} | ${task.output_tokens} | ${task.duration_ms} | ${markdownEscape(task.last_error ?? "")} |`
    );
  }

  const tasksWithWarnings = report.tasks.filter((task) => {
    return (Array.isArray(task.infra_warnings) && task.infra_warnings.length > 0) || task.agent_exception;
  });
  if (tasksWithWarnings.length > 0) {
    lines.push("", "## Infra Warnings", "");
    for (const task of tasksWithWarnings) {
      lines.push(`### ${markdownEscape(task.task_id)}`);
      for (const warning of Array.isArray(task.infra_warnings) ? task.infra_warnings : []) {
        lines.push(`- ${markdownEscape(warning)}`);
      }
      if (task.agent_exception?.message) {
        lines.push(`- agent_exception: ${markdownEscape(task.agent_exception.message)}`);
      }
      lines.push("");
    }
  }

  const tasksWithVerifierFailures = report.tasks.filter(
    (task) => Array.isArray(task.verifier_failed_tests) && task.verifier_failed_tests.length > 0
  );
  if (tasksWithVerifierFailures.length > 0) {
    lines.push("", "## Verifier Failures", "");
    for (const task of tasksWithVerifierFailures) {
      lines.push(`### ${markdownEscape(task.task_id)}`);
      if (task.reward !== null && task.reward !== undefined) {
        lines.push(`- Reward: ${task.reward}`);
      }
      if (task.verifier_log_path) {
        lines.push(`- Log: ${markdownEscape(task.verifier_log_path)}`);
      }
      for (const failure of task.verifier_failed_tests) {
        const detail = failure.message || failure.trace || failure.status;
        lines.push(`- ${markdownEscape(failure.name)}: ${markdownEscape(detail)}`);
      }
      lines.push("");
    }
  }

  if (report.incomplete_reason) {
    lines.push("", "## Incomplete Run", "");
    for (const reason of report.incomplete_reason) {
      lines.push(`- ${markdownEscape(reason)}`);
    }
  }

  if (report.notes.length > 0) {
    lines.push("", "## Notes", "");
    for (const note of report.notes) {
      lines.push(`- ${note}`);
    }
  }

  lines.push(
    "",
    "## Ownership Guidance",
    "",
    "- If `suggested_owner` is not `portable/harbor` or `scripts/bench`, do not start by changing Harbor adapter plumbing.",
    "- The portable Harbor runtime is an adapter layer, not the agent harness itself.",
    "- Solving quality issues should start in `agent-runtime`, `agent-model`, `agent-tools`, context, or CLI behavior."
  );

  lines.push("");
  return lines.join("\n");
}

export async function generateBenchReport(runDir) {
  const configPath = path.join(runDir, "config.json");
  const commandPath = path.join(runDir, "command.sh");
  const config = await readJsonSafe(configPath);
  const expectedLogFiles = ["harbor.stdout.log", "harbor.stderr.log", "result.raw.log"];
  const missingLogFiles = expectedLogFiles.filter((name) => !existsSync(path.join(runDir, name)));
  const incompleteReason = [];
  if (config.status === "running") {
    incompleteReason.push("config.json still marks this benchmark run as running.");
  }
  if (config.finished_at === null || (config.status === "running" && !config.finished_at)) {
    incompleteReason.push("config.json does not contain a finished_at timestamp.");
  }
  if (config.exit_code === null || config.exit_code === undefined) {
    incompleteReason.push("config.json does not contain an exit_code.");
  }
  if (missingLogFiles.length > 0) {
    incompleteReason.push(`missing expected log files: ${missingLogFiles.join(", ")}`);
  }
  const globalLogText = [
    await readTextSafe(path.join(runDir, "harbor.stdout.log")),
    await readTextSafe(path.join(runDir, "harbor.stderr.log")),
    await readTextSafe(path.join(runDir, "result.raw.log"))
  ].join("\n");
  const taskDirs = await listTaskDirs(runDir);
  let tasks = taskDirs.length > 0
    ? await Promise.all(taskDirs.map((taskDir, index) => taskReportFromDir(runDir, taskDir, index, config, globalLogText)))
    : [syntheticRunTask(config, globalLogText)];
  const harborTrialResults = await readHarborTrialResults(runDir);
  if (harborTrialResults.length > 0) {
    tasks = mergeHarborTrialResults(tasks, harborTrialResults);
  }
  if (incompleteReason.length > 0) {
    tasks = tasks.map((task) => ({
      ...task,
      status: task.status === "passed" ? "failed" : task.status,
      failure_category:
        task.failure_category && task.failure_category !== "agent_crashed"
          ? task.failure_category
          : classifyFailure({ summary: {}, traceEvents: [], logText: globalLogText, exitCode: config.exit_code }) === "agent_crashed"
            ? "unknown"
            : classifyFailure({ summary: {}, traceEvents: [], logText: globalLogText, exitCode: config.exit_code }),
      failure_signals: collectFailureSignals({
        existingSignals: task.failure_signals,
        logText: `${globalLogText}\n${incompleteReason.join("\n")}`
      }),
      last_error: task.last_error ?? `Incomplete benchmark run: ${incompleteReason.join("; ")}`
    }));
  }
  tasks = tasks.map(withSuggestedOwner);

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
  const exitCode = Number(config.exit_code ?? 1);
  const scoreStatus = incompleteReason.length > 0
    ? "incomplete"
    : failedCount > 0
      ? "failed"
      : counts.passed > 0
        ? "passed"
        : "unknown";
  const hasInfraWarning = tasks.some(
    (task) => (Array.isArray(task.infra_warnings) && task.infra_warnings.length > 0) || task.agent_exception
  );
  const infraStatus = incompleteReason.length > 0
    ? "incomplete"
    : hasInfraWarning
      ? "warning"
      : exitCode === 0
        ? "passed"
        : "failed";
  const report = {
    run_id: config.run_id ?? path.basename(runDir),
    started_at: config.started_at ?? null,
    finished_at: config.finished_at ?? null,
    provider: config.provider ?? "unknown",
    model: config.model ?? null,
    dataset: config.dataset ?? terminalBenchDataset,
    k: config.k ?? null,
    command: config.command_text ?? commandScript.trim(),
    harbor_command: config.harbor_command ?? config.command?.[0] ?? null,
    harbor_version: config.harbor_version ?? null,
    harbor_capabilities: config.harbor_capabilities ?? null,
    timeout_plan: config.timeout_plan ?? null,
    timeout_probe_tasks: Array.isArray(config.timeout_probe?.tasks) ? config.timeout_probe.tasks : [],
    resolved_job_config_path: config.resolved_job_config_path ?? null,
    incomplete_reason: incompleteReason.length > 0 ? incompleteReason : null,
    exit_code: exitCode,
    harbor_exit_code: exitCode,
    score_status: scoreStatus,
    infra_status: infraStatus,
    score_mode: "standard_benchmark",
    status: incompleteReason.length > 0
      ? "incomplete"
      : failedCount > 0
        ? "failed"
        : counts.passed > 0
          ? "passed"
          : config.status ?? (exitCode === 0 ? "passed" : "failed"),
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
  resolveHarborAgentImportPath(env);
  const pythonPathEntries = [harborRuntimeDir];
  if (env.PYTHONPATH) {
    pythonPathEntries.push(env.PYTHONPATH);
  }

  const next = {
    ...env,
    AGENT_CLI_TARBALL: env.AGENT_CLI_TARBALL || defaultAgentCliTarballForEnv(env),
    PYTHONPATH: pythonPathEntries.filter(Boolean).join(path.delimiter),
    SIGMA_BENCH_RUN_DIR: runDir,
    PYTHONIOENCODING: env.PYTHONIOENCODING || "utf-8",
    PYTHONUTF8: env.PYTHONUTF8 || "1",
    NO_COLOR: env.NO_COLOR || "1",
    FORCE_COLOR: "0",
    PY_COLORS: env.PY_COLORS || "0",
    RICH_NO_COLOR: env.RICH_NO_COLOR || "1",
    TERM: env.TERM || "dumb"
  };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    const value = next[key];
    if (typeof value === "string" && /^htpp:\/\//i.test(value)) {
      next[key] = `http://${value.slice(7)}`;
    }
  }
  return next;
}
