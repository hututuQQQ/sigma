import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertUniqueHarborTaskExecutionIdentities,
  buildResolvedTaskAttestationV2,
  harborTaskExecutionIdentity,
  harborTaskExecutionIdentitySha256,
  projectHarborTaskConfig,
  taskSelectionIdentity,
  taskSelectionIdentitySha256,
  validateExternalTaskRecord
} from "./harbor-task-identity.mjs";

export {
  assertUniqueHarborTaskExecutionIdentities,
  buildResolvedTaskAttestationV2,
  harborTaskExecutionIdentity,
  harborTaskExecutionIdentitySha256,
  projectHarborTaskConfig,
  taskSelectionIdentity,
  taskSelectionIdentitySha256
};

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const artifactsDir = path.join(rootDir, ".artifacts");
export const benchRootDir = path.join(artifactsDir, "bench");
export const harborRuntimeDir = path.join(artifactsDir, "harbor-runtime");
export const harborSandboxComposePath = path.join(
  harborRuntimeDir,
  "docker-compose-sigma-sandbox.yaml"
);
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
export const defaultConcurrentTrials = 5;

const COUNT_KEYS = [
  "passed", "failed", "infra_failed", "structured_blocker", "timeout", "api_error",
  "needs_input", "tool_error", "verifier_failure", "unknown"
];
const FAILURE_COUNT_BUCKETS = new Map([
  ["host_proxy_error", "infra_failed"],
  ["host_encoding_error", "infra_failed"],
  ["harbor_cli_error", "infra_failed"],
  ["node_missing", "infra_failed"],
  ["agent_setup_failed", "infra_failed"],
  ["infrastructure_incomplete", "infra_failed"],
  ["verifier_setup_failed", "infra_failed"],
  ["api_error", "api_error"],
  ["needs_input", "needs_input"],
  ["timeout", "timeout"],
  ["tool_error", "tool_error"],
  ["verifier_failure", "verifier_failure"],
  ["structured_blocker", "structured_blocker"],
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
  ["infrastructure_incomplete", "environment"],
  ["verifier_setup_failed", "environment"],
  ["api_error", "agent-model"],
  ["needs_input", "agent-runtime"],
  ["timeout", "agent-runtime"],
  ["tool_error", "agent-tools"],
  ["verifier_failure", "agent-runtime"],
  ["structured_blocker", "agent-runtime"],
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

function asNonNegativeInt(value, fallback, name) {
  if (value === undefined || value === null || value === true || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer.`);
  return parsed;
}

function networkMode(value, fallback = "none") {
  const mode = asString(value, fallback);
  if (mode !== "none" && mode !== "loopback" && mode !== "full") {
    throw new Error("network mode must be none, loopback, or full.");
  }
  return mode;
}

function executionMode(value, fallback = "sandboxed") {
  const mode = asString(value, fallback);
  if (mode !== "sandboxed" && mode !== "container") {
    throw new Error("execution mode must be sandboxed or container.");
  }
  return mode;
}

function managedEnvironmentMode(value, fallback = "disabled") {
  const mode = asString(value, fallback);
  if (mode !== "disabled" && mode !== "required") {
    throw new Error("managed environment mode must be disabled or required.");
  }
  return mode;
}

function harborTopology(value, fallback = "main_only") {
  const topology = asString(value, fallback);
  if (topology !== "main_only" && topology !== "managed_three_role") {
    throw new Error("Harbor topology must be main_only or managed_three_role.");
  }
  return topology;
}

function benchmarkClass(value, fallback = "standard") {
  const classification = asString(value, fallback);
  if (classification !== "standard" && classification !== "diagnostic") {
    throw new Error("benchmark class must be standard or diagnostic.");
  }
  return classification;
}

function normalizedSha256(value, name) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(text)) throw new Error(`${name} must be a SHA-256 digest.`);
  return text;
}

export function readTaskSelectionFile(filePath) {
  if (!filePath) return [];
  const resolved = path.resolve(filePath);
  const parsed = JSON.parse(readFileSync(resolved, "utf8"));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("--tasks-file must contain a non-empty JSON array.");
  }
  const tasks = parsed.map((record, index) => validateExternalTaskRecord(record, index, path.dirname(resolved)));
  assertUniqueHarborTaskExecutionIdentities(tasks);
  return tasks;
}

export function resolveRunOptions(argv, env = process.env) {
  const flags = parseArgs(argv);
  const mode = flags.smoke ? "smoke" : asString(flags.mode, "k");
  if (!["smoke", "k", "task", "batch"].includes(mode)) {
    throw new Error(`Unsupported benchmark mode: ${mode}`);
  }

  const tasksFile = asString(flags["tasks-file"]);
  const tasks = tasksFile ? readTaskSelectionFile(tasksFile) : [];
  if (mode === "batch" && tasks.length === 0) throw new Error("Batch mode requires --tasks-file <json>.");
  if (mode !== "batch" && tasks.length > 0) throw new Error("--tasks-file requires --mode batch.");
  const expectedArchiveSha256 = normalizedSha256(
    flags["expected-archive-sha256"], "--expected-archive-sha256"
  );
  if (flags["reuse-package"] === true && !expectedArchiveSha256) {
    throw new Error("--reuse-package requires --expected-archive-sha256.");
  }

  const runClass = benchmarkClass(flags["benchmark-class"] ?? env.SIGMA_BENCHMARK_CLASS);
  const requestedLeniencyMultiplier = flags["timeout-leniency-multiplier"]
    ?? env.AGENT_TIMEOUT_LENIENCY_MULTIPLIER;
  const requestedLeniencyExtra = flags["timeout-leniency-min-extra-sec"]
    ?? env.AGENT_TIMEOUT_LENIENCY_MIN_EXTRA_SEC;
  if (runClass === "standard" && (env.AGENT_MAX_WALL_TIME_SEC !== undefined
    || (requestedLeniencyMultiplier !== undefined && Number(requestedLeniencyMultiplier) !== 1)
    || (requestedLeniencyExtra !== undefined && Number(requestedLeniencyExtra) !== 0))) {
    throw new Error("Standard benchmark runs prohibit timeout/resource overrides; use --benchmark-class diagnostic.");
  }
  const resolvedNetworkMode = networkMode(flags.network ?? env.SIGMA_NETWORK);
  const resolvedExecutionMode = executionMode(flags["execution-mode"] ?? env.SIGMA_EXECUTION_MODE);
  const resolvedManagedEnvironmentMode = managedEnvironmentMode(
    flags["managed-environment-mode"] ?? env.SIGMA_MANAGED_ENVIRONMENT_MODE
  );
  const resolvedHarborTopology = harborTopology(
    flags["harbor-topology"] ?? env.SIGMA_HARBOR_TOPOLOGY,
    resolvedManagedEnvironmentMode === "required" ? "managed_three_role" : "main_only"
  );
  if (resolvedManagedEnvironmentMode === "required"
    && (resolvedExecutionMode !== "container" || resolvedNetworkMode !== "full"
      || resolvedHarborTopology !== "managed_three_role")) {
    throw new Error(
      "managed environment mode required needs execution-mode container, network full, and Harbor topology managed_three_role."
    );
  }
  if (resolvedHarborTopology === "managed_three_role" && resolvedManagedEnvironmentMode !== "required") {
    throw new Error("Harbor topology managed_three_role requires managed environment mode required.");
  }
  const configuredMaxTurns = flags["max-turns"] ?? env.AGENT_MAX_TURNS;
  return {
    mode,
    benchmarkClass: runClass,
    dataset: asString(flags.dataset ?? env.SIGMA_BENCH_DATASET, terminalBenchDataset),
    provider: asString(flags.provider, env.AGENT_PROVIDER ?? "deepseek"),
    model: asString(flags.model, env.AGENT_MODEL),
    agentProfile: asString(flags["agent-profile"], env.SIGMA_AGENT_PROFILE ?? "standard"),
    networkMode: resolvedNetworkMode,
    executionMode: resolvedExecutionMode,
    managedEnvironmentMode: resolvedManagedEnvironmentMode,
    harborTopology: resolvedHarborTopology,
    runLabel: asString(flags["run-label"]),
    k: asPositiveInt(flags.k, 1, "--k"),
    nConcurrentTrials: asPositiveInt(
      flags.concurrency ?? env.AGENT_BENCH_CONCURRENCY,
      defaultConcurrentTrials,
      "--concurrency"
    ),
    attemptsPerTask: asPositiveInt(flags.attempts, 1, "--attempts"),
    retries: asNonNegativeInt(flags.retries, 0, "--retries"),
    taskId: asString(flags["task-id"]),
    tasksFile: tasksFile ? path.resolve(tasksFile) : null,
    tasksFileSha256: tasksFile
      ? createHash("sha256").update(readFileSync(path.resolve(tasksFile))).digest("hex")
      : null,
    tasks,
    reusePackage: flags["reuse-package"] === true,
    expectedArchiveSha256,
    maxTurns: asPositiveInt(configuredMaxTurns, 200, "--max-turns"),
    maxTurnsExplicit: configuredMaxTurns !== undefined && configuredMaxTurns !== null && configuredMaxTurns !== "",
    commandTimeoutSec: asPositiveInt(
      flags["command-timeout-sec"] ?? env.AGENT_COMMAND_TIMEOUT_SEC,
      180,
      "--command-timeout-sec"
    ),
    maxWallTimeSec: asOptionalPositiveInt(env.AGENT_MAX_WALL_TIME_SEC, "AGENT_MAX_WALL_TIME_SEC"),
    agentTimeoutGraceSec: asPositiveInt(
      flags["agent-timeout-grace-sec"] ?? env.AGENT_TIMEOUT_GRACE_SEC,
      defaultAgentTimeoutGraceSec,
      "--agent-timeout-grace-sec"
    ),
    agentTimeoutLeniencyMultiplier: asPositiveNumber(
      flags["timeout-leniency-multiplier"] ?? env.AGENT_TIMEOUT_LENIENCY_MULTIPLIER,
      runClass === "diagnostic" ? defaultAgentTimeoutLeniencyMultiplier : 1,
      "--timeout-leniency-multiplier"
    ),
    agentTimeoutLeniencyMinExtraSec: asNonNegativeInt(
      flags["timeout-leniency-min-extra-sec"] ?? env.AGENT_TIMEOUT_LENIENCY_MIN_EXTRA_SEC,
      runClass === "diagnostic" ? defaultAgentTimeoutLeniencyMinExtraSec : 0,
      "--timeout-leniency-min-extra-sec"
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

function asFiniteNonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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
  // Direct library callers retain the historical diagnostic planning unless
  // they classify the run. The CLI always resolves an explicit class and
  // defaults it to standard.
  const runClass = options.benchmarkClass ?? "diagnostic";
  const recommendedAgentTimeoutSec =
    maxProbeNumber(timeoutProbe, "agent_timeout_sec") ?? defaultAgentTimeoutFallbackSec;
  const requestedWallTimeSec = asFinitePositiveNumber(options.maxWallTimeSec);
  const leniencyMultiplier =
    asFinitePositiveNumber(options.agentTimeoutLeniencyMultiplier) ?? defaultAgentTimeoutLeniencyMultiplier;
  const leniencyMinExtraSec = Math.max(
    0,
    Math.ceil(
      asFiniteNonNegativeNumber(options.agentTimeoutLeniencyMinExtraSec) ?? defaultAgentTimeoutLeniencyMinExtraSec
    )
  );
  const lenientAgentWallTimeSec = Math.ceil(
    Math.max(recommendedAgentTimeoutSec * leniencyMultiplier, recommendedAgentTimeoutSec + leniencyMinExtraSec)
  );
  const graceSec = Math.max(
    0,
    Math.ceil(asFinitePositiveNumber(options.agentTimeoutGraceSec) ?? defaultAgentTimeoutGraceSec)
  );
  const cleanupGraceSec = graceSec;
  // The task-declared timeout belongs to solving. Settlement and container
  // cleanup use a separate outer grace window; subtracting that window from
  // the solver silently changes the benchmark contract.
  const standardAgentWallTimeSec = Math.max(1, Math.floor(recommendedAgentTimeoutSec));
  const agentWallTimeSec = runClass === "standard"
    ? standardAgentWallTimeSec
    : Math.ceil(requestedWallTimeSec ?? lenientAgentWallTimeSec);
  const harnessTimeoutSec = agentWallTimeSec + cleanupGraceSec;
  const agentTimeoutMultiplier = harnessTimeoutSec > recommendedAgentTimeoutSec
    ? formatMultiplier(harnessTimeoutSec / recommendedAgentTimeoutSec)
    : null;
  const timeoutTasks = Array.isArray(timeoutProbe?.tasks) ? timeoutProbe.tasks : [];
  const taskAgentTimeouts = timeoutTasks
    .map((task) => asFinitePositiveNumber(task?.agent_timeout_sec));
  const knownTaskAgentTimeouts = taskAgentTimeouts.filter((value) => value !== null);
  const allTaskTimeoutsAvailable = timeoutTasks.length > 0
    && knownTaskAgentTimeouts.length === timeoutTasks.length;
  const uniformTaskTimeout = allTaskTimeoutsAvailable
    && knownTaskAgentTimeouts.every((value) => value === knownTaskAgentTimeouts[0]);
  const outerTrialDeadlineSec = uniformTaskTimeout
    ? harnessTimeoutSec
    : null;
  const outerTrialDeadlineScope = uniformTaskTimeout
    ? "uniform_task_timeout"
    : allTaskTimeoutsAvailable && knownTaskAgentTimeouts.length > 1
      ? "harbor_per_trial"
      : "unavailable";
  const safeChildDeadlineSec = outerTrialDeadlineSec === null
    ? agentWallTimeSec
    : Math.max(1, Math.floor(outerTrialDeadlineSec - cleanupGraceSec));
  const effectiveAgentWallTimeSec = Math.min(agentWallTimeSec, safeChildDeadlineSec);

  return {
    requested_agent_wall_time_sec: agentWallTimeSec,
    agent_wall_time_sec: effectiveAgentWallTimeSec,
    child_deadline_sec: effectiveAgentWallTimeSec,
    outer_trial_deadline_sec: outerTrialDeadlineSec === null
      ? null
      : Math.floor(outerTrialDeadlineSec),
    outer_trial_deadline_scope: outerTrialDeadlineScope,
    deadline_cleanup_grace_sec: cleanupGraceSec,
    deadline_clamped: effectiveAgentWallTimeSec < agentWallTimeSec,
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
    verifier_timeout_multiplier: runClass === "diagnostic" ? agentTimeoutMultiplier : null,
    environment_build_timeout_multiplier: runClass === "diagnostic" ? agentTimeoutMultiplier : null,
    benchmark_class: runClass,
    source: runClass === "standard" ? "standard_task_timeout"
      : requestedWallTimeSec ? "explicit_max_wall_time" : timeoutProbe ? "harbor_task_metadata" : "fallback"
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
      if (task?.name) return projectHarborTaskConfig(task);
      if (task?.path) return projectHarborTaskConfig(task);
      return null;
    })
    .filter(Boolean);
}

function benchmarkAgentKwargs(options, timeoutPlan = null) {
  const agentKwargs = {
    agent_cli_tarball: resolveAgentCliTarballPath(options, options.env ?? process.env),
    provider: options.provider,
    agent_profile: options.agentProfile ?? "standard",
    network_mode: options.networkMode ?? "none",
    execution_mode: options.executionMode ?? "sandboxed",
    managed_environment_mode: options.managedEnvironmentMode ?? "disabled",
    harbor_topology: options.harborTopology ?? "main_only"
  };
  if (options.model) {
    agentKwargs.model = options.model;
  }

  if (timeoutPlan?.agent_wall_time_sec) {
    agentKwargs.max_wall_time_sec = timeoutPlan.agent_wall_time_sec;
  }
  if (timeoutPlan?.outer_trial_deadline_sec) {
    agentKwargs.outer_trial_deadline_sec = timeoutPlan.outer_trial_deadline_sec;
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
    n_attempts: options.attemptsPerTask ?? 1,
    retry: { max_retries: options.retries ?? 0 },
    n_concurrent_trials: options.nConcurrentTrials ?? defaultConcurrentTrials,
    agents: [
      {
        name: agentName,
        kwargs: agentKwargs
      }
    ]
  };

  if (options.mode !== "smoke") {
    config.environment = {
      type: "docker",
      extra_docker_compose: [path.resolve(options.harborSandboxComposePath ?? harborSandboxComposePath)]
    };
  }

  const configuredTasks = Array.isArray(options.tasks) ? options.tasks : [];
  const resolvedTasks = selectedTaskRecords(timeoutProbe);
  if (configuredTasks.length > 0) {
    // Harbor 0.17 does not resolve metrics for explicit task sources. Leaving
    // source unset selects its supported adhoc Mean metric while Git/path
    // provenance remains frozen in the external control-plane task file.
    assertUniqueHarborTaskExecutionIdentities(configuredTasks);
    config.tasks = configuredTasks.map(projectHarborTaskConfig);
  } else if (resolvedTasks.length > 0) {
    config.tasks = resolvedTasks;
  } else if (options.mode === "task") {
    config.tasks = [{ name: normalizedTerminalBenchTaskName(options.taskId) }];
  } else {
    config.datasets = [
      {
        name: options.dataset ?? terminalBenchDataset,
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

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const jsonLine = text
      .split(/\r?\n/)
      .reverse()
      .find((line) => line.trim().startsWith("{") && line.trim().endsWith("}"));
    if (!jsonLine) {
      throw new Error("Harbor timeout probe output did not contain a JSON object.");
    }
    parsed = JSON.parse(jsonLine);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const resolvedTasks = Array.isArray(parsed.resolved_tasks)
    ? parsed.resolved_tasks.map((task) => {
        if (!task || typeof task !== "object" || Array.isArray(task)
          || typeof task.path !== "string" || !task.git_url) return task;
        // Harbor resolves Git task paths with host-native separators. This is
        // a trusted process boundary, so normalize only this derived field and
        // then let the existing portable-path projector reject absolute paths,
        // traversal, UNC paths, and drive-qualified paths. External task files
        // remain strict and continue to reject backslashes.
        return { ...task, path: task.path.replace(/\\/gu, "/") };
      })
    : parsed.resolved_tasks;
  return { ...parsed, ...(resolvedTasks ? { resolved_tasks: resolvedTasks } : {}) };
}

/** Partitions resolved trials by their Harbor agent timeout. Each partition
 * can be launched with one truthful runtime deadline without exposing task
 * identity to the solving agent. If metadata is incomplete, the original
 * single group is retained so the caller fails conservatively. */
export function groupHarborTimeoutProbe(timeoutProbe, configuredTasks = []) {
  const tasks = Array.isArray(timeoutProbe?.tasks) ? timeoutProbe.tasks : [];
  const resolved = Array.isArray(timeoutProbe?.resolved_tasks) ? timeoutProbe.resolved_tasks : [];
  if (tasks.length === 0 || resolved.length !== tasks.length
    || tasks.some((task) => asFinitePositiveNumber(task?.agent_timeout_sec) === null)) {
    return [{
      agent_timeout_sec: maxProbeNumber(timeoutProbe, "agent_timeout_sec"),
      task_indexes: tasks.map((_task, index) => index),
      tasks,
      resolved_tasks: resolved,
      configured_tasks: configuredTasks.length === tasks.length ? configuredTasks : [],
      timeout_probe: timeoutProbe
    }];
  }
  const groups = new Map();
  for (let index = 0; index < tasks.length; index += 1) {
    const timeout = asFinitePositiveNumber(tasks[index]?.agent_timeout_sec);
    const group = groups.get(timeout) ?? { indexes: [], tasks: [], resolved: [], configured: [] };
    group.indexes.push(index);
    group.tasks.push(tasks[index]);
    group.resolved.push(resolved[index]);
    if (configuredTasks.length === tasks.length) group.configured.push(configuredTasks[index]);
    groups.set(timeout, group);
  }
  return [...groups.entries()].sort(([left], [right]) => left - right).map(([timeout, group]) => {
    const probe = {
      tasks: group.tasks,
      resolved_tasks: group.resolved,
      max_agent_timeout_sec: timeout,
      max_verifier_timeout_sec: Math.max(...group.tasks
        .map((task) => asFinitePositiveNumber(task?.verifier_timeout_sec) ?? 0)),
      max_environment_build_timeout_sec: Math.max(...group.tasks
        .map((task) => asFinitePositiveNumber(task?.environment_build_timeout_sec) ?? 0))
    };
    return {
      agent_timeout_sec: timeout,
      task_indexes: group.indexes,
      tasks: group.tasks,
      resolved_tasks: group.resolved,
      configured_tasks: group.configured,
      timeout_probe: probe
    };
  });
}

export function buildHarborArgs(options) {
  const capabilities = options.capabilities ?? {};
  if (options.configPath) {
    const args = ["run", "--config", options.configPath];
    if (capabilities.yesFlag) args.push(capabilities.yesFlag);
    return args;
  }

  if (options.mode === "smoke") {
    const args = [
      "run", "-d", options.dataset ?? terminalBenchDataset,
      "-a", "oracle", capabilities.taskLimitFlag ?? "-l", "5"
    ];
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
    options.dataset ?? terminalBenchDataset,
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
  args.push("--ak", formatAgentKwarg("agent_profile", "str", options.agentProfile ?? "standard", capabilities));
  if (options.networkMode !== undefined) {
    args.push("--ak", formatAgentKwarg("network_mode", "str", options.networkMode, capabilities));
  }
  if (options.executionMode !== undefined) {
    args.push("--ak", formatAgentKwarg("execution_mode", "str", options.executionMode, capabilities));
  }
  if (options.managedEnvironmentMode !== undefined) {
    args.push("--ak", formatAgentKwarg(
      "managed_environment_mode", "str", options.managedEnvironmentMode, capabilities
    ));
  }
  if (options.harborTopology !== undefined) {
    args.push("--ak", formatAgentKwarg("harbor_topology", "str", options.harborTopology, capabilities));
  }
  if (options.model) {
    args.push("--ak", formatAgentKwarg("model", "str", options.model, capabilities));
  }
  args.push("--ak", formatAgentKwarg("max_turns", "int", options.maxTurns, capabilities));
  args.push("--ak", formatAgentKwarg("command_timeout_sec", "int", options.commandTimeoutSec, capabilities));
  args.push("--ak", formatAgentKwarg("max_wall_time_sec", "int", timeoutPlan.agent_wall_time_sec, capabilities));
  if (timeoutPlan.outer_trial_deadline_sec) {
    args.push("--ak", formatAgentKwarg("outer_trial_deadline_sec", "int", timeoutPlan.outer_trial_deadline_sec, capabilities));
  }
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
    `export PYTHONDONTWRITEBYTECODE=${shellQuote(env.PYTHONDONTWRITEBYTECODE ?? "1")}`,
    `export PYTHONPYCACHEPREFIX=${shellQuote(env.PYTHONPYCACHEPREFIX ?? "")}`,
    `export SIGMA_BENCH_RUN_DIR=${shellQuote(env.SIGMA_BENCH_RUN_DIR ?? "")}`,
    `export SIGMA_BENCH_RUN_SLOT=${shellQuote(env.SIGMA_BENCH_RUN_SLOT ?? "")}`,
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
  return events.some((event) => event?.type === "tool_end" && (
    containsTimedOut(event.metadata) || containsTimedOut(event.sigma_event?.payload)
  ));
}

function summaryHasFinishReason(summary, finishReason) {
  return summary?.finish_reason === finishReason || summary?.finishReason === finishReason;
}

export function classifyFailure(input = {}) {
  const summary = input.summary ?? {};
  const logText = String(input.logText ?? "");
  const events = input.traceEvents ?? [];

  const declared = input.failureKind
    ?? input.metadata?.failure_kind
    ?? summary.failure_kind;
  if ([
    "needs_input", "timeout", "tool_error", "api_error", "verifier_failure", "structured_blocker",
    "agent_setup_failed", "infrastructure_incomplete"
  ].includes(declared)) {
    return declared;
  }

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
  if (/agent_setup_failed/i.test(logText) || /harbor setup failed/i.test(logText)
    || /\/usr\/local\/bin\/agent (?:--help|doctor .*--strict).*failed/i.test(logText)) {
    return "agent_setup_failed";
  }
  if (/api request failed|rate limit|missing api key/i.test(logText) || /\b(401|403|429|500)\b/.test(logText)) {
    return "api_error";
  }
  if (summaryHasFinishReason(summary, "max_turns")) return "max_turns";
  if (traceHasToolTimeout(events)) return "tool_timeout";
  if (summaryHasFinishReason(summary, "max_wall_time")
    || summary.terminal_origin === "adapter_timeout"
    || summary.termination_source === "adapter_timeout") {
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

  if (summaryHasFinishReason(summary, "max_wall_time")
    || summary.terminal_origin === "adapter_timeout"
    || summary.termination_source === "adapter_timeout") {
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
  const taskExitCode = metadata.exit_code ?? runExitCode;
  if (summary.status === "completed" && taskExitCode === 0) return "passed";
  if (summary.status === "error" || summary.status === "stopped") return "failed";
  if (taskExitCode !== undefined && taskExitCode !== 0) return "failed";
  return taskExitCode === 0 ? "passed" : "unknown";
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
    reasoning_tokens: 0,
    cache_tokens: 0,
    cache_read_tokens: 0,
    length_finish_count: 0,
    converge_turns: 0,
    cost_usd: null,
    duration_ms: 0,
    suspension_to_exit_ms: null,
    terminal_origin: null,
    termination_source: null,
    network_mode_effective: null,
    execution_mode: null,
    managed_environment_mode: null,
    harbor_topology: null,
    agent_profile: null,
    harbor_deadline_sec: null,
    sigma_deadline_sec: null,
    last_error: null
  };

  for (const event of events) {
    const metadata = event?.metadata ?? {};
    const sigmaEvent = event?.sigma_event && typeof event.sigma_event === "object"
      ? event.sigma_event : {};
    const payload = sigmaEvent.payload && typeof sigmaEvent.payload === "object"
      ? sigmaEvent.payload : metadata.payload && typeof metadata.payload === "object"
        ? metadata.payload : {};
    if (event?.type === "usage") {
      const usage = metadata.usage ?? payload;
      summary.input_tokens += Number(usage.inputTokens ?? usage.input_tokens ?? 0);
      summary.output_tokens += Number(usage.outputTokens ?? usage.output_tokens ?? 0);
      summary.reasoning_tokens += Number(usage.reasoningTokens ?? usage.reasoning_tokens ?? 0);
      summary.cache_tokens += Number(usage.cacheTokens ?? usage.cache_tokens
        ?? Number(usage.cacheReadTokens ?? 0) + Number(usage.cacheWriteTokens ?? 0));
      summary.cache_read_tokens += Number(usage.cacheReadTokens ?? usage.cache_read_tokens ?? 0);
      const usageCost = Number(usage.costUsd ?? usage.cost_usd
        ?? (Number.isFinite(Number(usage.costMicroUsd)) ? Number(usage.costMicroUsd) / 1_000_000 : NaN));
      if (Number.isFinite(usageCost)) summary.cost_usd = (summary.cost_usd ?? 0) + usageCost;
    }
    if (event?.type === "model_end"
      && (metadata.finishReason ?? metadata.finish_reason) === "length") {
      summary.length_finish_count += 1;
    }
    if (event?.type === "diagnostic") {
      const diagnostic = Object.keys(payload).length > 0 ? payload : metadata;
      if (diagnostic.kind === "deadline.stage" && diagnostic.stage === "converge") summary.converge_turns += 1;
    }
    if (event?.type === "tool_end" && metadata.toolName === "bash") {
      summary.commands_executed += 1;
    }
    if (event?.type === "error" && (payload.message || metadata.message)) {
      summary.last_error = String(payload.message ?? metadata.message);
    }
    if (event?.type === "run_end") {
      const result = metadata.result && typeof metadata.result === "object"
        ? metadata.result : { ...payload, ...metadata };
      const durableType = sigmaEvent.type;
      summary.status = result.status ?? summary.status;
      if (!summary.status && durableType === "run.completed") summary.status = "completed";
      if (!summary.status && durableType === "run.failed") summary.status = "error";
      if (!summary.status && durableType === "run.cancelled") summary.status = "cancelled";
      summary.finish_reason = result.finishReason ?? result.finish_reason ?? summary.finish_reason;
      summary.commands_executed = Number(result.commandsExecuted ?? result.commands_executed ?? summary.commands_executed);
      summary.input_tokens = Number(result.usage?.inputTokens ?? result.input_tokens ?? summary.input_tokens);
      summary.output_tokens = Number(result.usage?.outputTokens ?? result.output_tokens ?? summary.output_tokens);
      summary.reasoning_tokens = Number(
        result.usage?.reasoningTokens ?? result.reasoning_tokens ?? summary.reasoning_tokens
      );
      summary.cache_tokens = Number(result.usage?.cacheTokens ?? result.cache_tokens ?? summary.cache_tokens);
      summary.cache_read_tokens = Number(
        result.usage?.cacheReadTokens ?? result.cache_read_tokens ?? summary.cache_read_tokens
      );
      summary.length_finish_count = Number(result.length_finish_count ?? summary.length_finish_count);
      summary.converge_turns = Number(result.converge_turns ?? summary.converge_turns);
      const resultCost = Number(result.usage?.costUsd ?? result.cost_usd ?? summary.cost_usd);
      summary.cost_usd = Number.isFinite(resultCost) ? resultCost : summary.cost_usd;
      summary.duration_ms = Number(result.durationMs ?? result.duration_ms ?? summary.duration_ms);
      summary.suspension_to_exit_ms = result.suspension_to_exit_ms ?? summary.suspension_to_exit_ms;
      summary.terminal_origin = result.terminal_origin ?? summary.terminal_origin;
      summary.termination_source = result.termination_source ?? summary.termination_source;
      summary.execution_mode = result.execution_mode ?? summary.execution_mode;
      summary.agent_profile = result.agent_profile ?? summary.agent_profile;
      summary.harbor_deadline_sec = result.harbor_deadline_sec ?? summary.harbor_deadline_sec;
      summary.sigma_deadline_sec = result.sigma_deadline_sec ?? summary.sigma_deadline_sec;
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

function verifierInfrastructureEvidence(stdoutText, failedTests) {
  if (failedTests.length > 0) return [];
  const text = String(stdoutText ?? "");
  const hasProductTestResult = /(?:^|\n)FAILED\s+\S+|\bAssertionError\b|\b\d+\s+(?:passed|failed)\b|=+\s+.*\b(?:passed|failed)\b.*=+/imu
    .test(text);
  if (hasProductTestResult) return [];
  const evidence = [];
  const checks = [
    ["dependency_install_network", /(?:failed to fetch|bad gateway|temporary failure resolving|could not resolve|network is unreachable|connection (?:timed out|reset))/iu],
    ["dependency_install_failed", /(?:unable to fetch some archives|could not install packages|subprocess-exited-with-error|npm err!|pnpm.*err)/iu],
    ["verifier_launch_failed", /\/tests\/[^\s:]+:\s*(?:no such file or directory|permission denied)/iu],
    ["verifier_toolchain_missing", /(?:pytest|uvx|curl|node|python\d*):\s*(?:command not found|no such file or directory)/iu],
    ["verifier_module_missing", /(?:error collecting|ModuleNotFoundError:\s*No module named)/iu]
  ];
  for (const [code, pattern] of checks) {
    if (pattern.test(text)) evidence.push(code);
  }
  return evidence;
}

async function readVerifierDetails(runDir, trialDir) {
  const verifierDir = path.join(trialDir, "verifier");
  const ctrfPath = path.join(verifierDir, "ctrf.json");
  const stdoutPath = path.join(verifierDir, "test-stdout.txt");
  const ctrf = await readJsonSafe(ctrfPath);
  const stdoutText = await readTextSafe(stdoutPath);
  const parsedFailures = parseVerifierFailures(ctrf);
  const failedTests = parsedFailures.length > 0 ? parsedFailures : parseStdoutVerifierFailures(stdoutText);
  const infrastructureEvidence = verifierInfrastructureEvidence(stdoutText, failedTests);
  return {
    verifier_failed_tests: failedTests,
    verifier_log_path: relativePathOrNull(runDir, stdoutPath),
    verifier_infrastructure_evidence: infrastructureEvidence
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

async function readHarborTrialResults(runDir, jobsDir) {
  const resultFiles = await listJsonFiles(jobsDir);
  const results = [];
  for (const filePath of resultFiles) {
    const value = await readJsonSafe(filePath);
    if (value && typeof value === "object" && value.trial_name && value.task_name) {
      const trialDir = path.dirname(filePath);
      const relativeParts = path.relative(jobsDir, filePath).split(path.sep);
      results.push({
        ...value,
        ...(await readVerifierDetails(runDir, trialDir)),
        ...(await readTrialTraceFallback(runDir, trialDir)),
        result_path: path.relative(runDir, filePath).replace(/\\/g, "/"),
        run_slot: relativeParts.length > 1 ? relativeParts[0] : null,
        trial_dir: trialDir
      });
    }
  }
  return results.sort((a, b) => String(a.trial_name).localeCompare(String(b.trial_name)));
}

async function readHarborJobAccounting(runDir, jobsDir) {
  const resultFiles = await listJsonFiles(jobsDir);
  const jobs = [];
  for (const filePath of resultFiles) {
    const value = await readJsonSafe(filePath);
    if (value?.trial_name || value?.task_name || !Number.isInteger(value?.n_total_trials)) continue;
    jobs.push({
      result_path: path.relative(runDir, filePath).replace(/\\/g, "/"),
      total: value.n_total_trials,
      completed: Number(value?.stats?.n_completed_trials ?? 0),
      errored: Number(value?.stats?.n_errored_trials ?? 0),
      retries: Number(value?.stats?.n_retries ?? 0)
    });
  }
  if (jobs.length === 0) return null;
  return {
    jobs,
    total: jobs.reduce((sum, job) => sum + job.total, 0),
    completed: jobs.reduce((sum, job) => sum + job.completed, 0),
    errored: jobs.reduce((sum, job) => sum + job.errored, 0),
    retries: jobs.reduce((sum, job) => sum + job.retries, 0)
  };
}

async function resolvedJobConfigForReport(runDir, config) {
  if (Array.isArray(config.resolved_job_config_paths) && config.resolved_job_config_paths.length > 1) {
    const records = await Promise.all(config.resolved_job_config_paths.map(async (configured) => {
      const filePath = path.isAbsolute(configured) ? configured : path.join(runDir, configured);
      return existsSync(filePath) ? await readJsonSafe(filePath) : null;
    }));
    const available = records.filter(Boolean);
    return {
      n_concurrent_trials: config.n_concurrent_trials,
      tasks: available.flatMap((record) => Array.isArray(record.tasks) ? record.tasks : []),
      datasets: available.flatMap((record) => Array.isArray(record.datasets) ? record.datasets : [])
    };
  }
  const configured = typeof config.resolved_job_config_path === "string"
    ? config.resolved_job_config_path
    : "resolved-job.config.json";
  const filePath = path.isAbsolute(configured) ? configured : path.join(runDir, configured);
  return existsSync(filePath) ? await readJsonSafe(filePath) : null;
}

async function runSlotIntegrityReasons(runDir, config) {
  const slots = Array.isArray(config.run_slots) ? config.run_slots : [];
  if (slots.length === 0) return [];
  const reasons = [];
  const slotIds = new Set();
  const executionIds = new Set();
  for (const slot of slots) {
    if (typeof slot?.run_slot !== "string" || !slot.run_slot) {
      reasons.push("Harbor run-slot manifest contains an invalid slot identifier.");
      continue;
    }
    if (slotIds.has(slot.run_slot)) reasons.push(`Harbor run-slot manifest repeats ${slot.run_slot}.`);
    slotIds.add(slot.run_slot);
    if (typeof slot.harbor_task_identity_sha256 === "string") {
      if (executionIds.has(slot.harbor_task_identity_sha256)) {
        reasons.push("Harbor run-slot manifest repeats a task execution identity.");
      }
      executionIds.add(slot.harbor_task_identity_sha256);
    }
    if (typeof slot.job_config_sha256 !== "string") continue;
    const configured = slot.resolved_job_config_path;
    const configPath = typeof configured === "string"
      ? path.resolve(runDir, configured)
      : null;
    if (!configPath || !(configPath === path.resolve(runDir) || configPath.startsWith(`${path.resolve(runDir)}${path.sep}`))
      || !existsSync(configPath)) {
      reasons.push(`Harbor run slot ${slot.run_slot} has no readable frozen JobConfig.`);
      continue;
    }
    const jobConfigBytes = await readFile(configPath);
    const actualConfigSha256 = createHash("sha256").update(jobConfigBytes).digest("hex");
    if (actualConfigSha256 !== slot.job_config_sha256) {
      reasons.push(`Harbor run slot ${slot.run_slot} JobConfig digest does not match its manifest.`);
      continue;
    }
    const jobConfig = await readJsonSafe(configPath);
    if (config.mode !== "smoke") {
      const kwargs = Array.isArray(jobConfig.agents) && jobConfig.agents.length === 1
        && jobConfig.agents[0] && typeof jobConfig.agents[0] === "object"
        ? jobConfig.agents[0].kwargs : null;
      const frozenControls = {
        network_mode: config.network_mode,
        execution_mode: config.execution_mode,
        managed_environment_mode: config.managed_environment_mode,
        harbor_topology: config.harbor_topology
      };
      if (!kwargs || typeof kwargs !== "object" || Array.isArray(kwargs)) {
        reasons.push(`Harbor run slot ${slot.run_slot} has no unique agent execution controls.`);
      } else {
        for (const [key, expected] of Object.entries(frozenControls)) {
          if (typeof expected === "string" && kwargs[key] !== expected) {
            reasons.push(`Harbor run slot ${slot.run_slot} agent control ${key} does not match its frozen run.`);
          }
        }
      }
    }
    if (slot.harbor_task_identity) {
      if (!Array.isArray(jobConfig.tasks) || jobConfig.tasks.length !== 1) {
        reasons.push(`Harbor run slot ${slot.run_slot} does not contain exactly one task.`);
      } else {
        const task = jobConfig.tasks[0];
        if (!task || typeof task !== "object" || Array.isArray(task)) {
          reasons.push(`Harbor run slot ${slot.run_slot} JobConfig task identity is invalid.`);
          continue;
        }
        if (Object.hasOwn(task, "source") || Object.hasOwn(task, "provenance_source")) {
          reasons.push(`Harbor run slot ${slot.run_slot} leaked provenance into JobConfig.`);
        }
        try {
          if (harborTaskExecutionIdentitySha256(task) !== slot.harbor_task_identity_sha256) {
            reasons.push(`Harbor run slot ${slot.run_slot} JobConfig task identity does not match its manifest.`);
          }
        } catch {
          reasons.push(`Harbor run slot ${slot.run_slot} JobConfig task identity is invalid.`);
        }
      }
    }
    if (slot.harbor_task_identity && typeof slot.resolved_task_attestation_path !== "string") {
      reasons.push(`Harbor run slot ${slot.run_slot} is missing its resolved-task attestation.`);
    } else if (typeof slot.resolved_task_attestation_path === "string") {
      const attestationPath = path.resolve(runDir, slot.resolved_task_attestation_path);
      const attestation = await readJsonSafe(attestationPath);
      if (attestation.schema_version === 2) {
        if (attestation.job_config_sha256 !== slot.job_config_sha256
          || attestation.task_selection_sha256 !== config.task_selection_sha256) {
          reasons.push(`Harbor run slot ${slot.run_slot} V2 attestation does not match frozen controls.`);
        }
      } else if (attestation.schema_version !== 1) {
        reasons.push(`Harbor run slot ${slot.run_slot} task attestation is missing or unsupported.`);
      }
    }
  }
  return reasons;
}

function expectedTrialCount(config, resolvedJobConfig) {
  if (Array.isArray(resolvedJobConfig?.tasks)) return resolvedJobConfig.tasks.length;
  if (Array.isArray(resolvedJobConfig?.datasets)) {
    const count = resolvedJobConfig.datasets.reduce((sum, dataset) => {
      const value = Number(dataset?.n_tasks ?? 0);
      return sum + (Number.isInteger(value) && value > 0 ? value : 0);
    }, 0);
    if (count > 0) return count;
  }
  if (Number.isInteger(config.k) && config.k > 0) return config.k;
  if (config.mode === "task") return 1;
  if (config.mode === "smoke") return 5;
  return 0;
}

function trialAccounting(expected, trialResults) {
  const scoredRewards = trialResults
    .filter((trial) => !trial?.exception_info && typeof trial?.verifier_result?.rewards?.reward === "number")
    .map((trial) => trial.verifier_result.rewards.reward);
  const errored = trialResults.filter((trial) => Boolean(trial?.exception_info)).length;
  return {
    expected,
    observed: trialResults.length,
    scored: scoredRewards.length,
    errored,
    missing: Math.max(0, expected - trialResults.length),
    meanReward: scoredRewards.length > 0
      ? scoredRewards.reduce((sum, reward) => sum + reward, 0) / scoredRewards.length
      : null
  };
}

function normalizedArtifactPath(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const normalized = path.resolve(value).replace(/\\/g, "/").replace(/\/+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function artifactMatchesTrial(task, trialResult) {
  const source = normalizedArtifactPath(task.source_logs_dir);
  const trialDir = normalizedArtifactPath(trialResult.trial_dir);
  if (!source || !trialDir) return false;
  return source === `${trialDir}/agent` || source.startsWith(`${trialDir}/agent/`);
}

function emptyTaskForTrial(trialResult, index) {
  return {
    task_id: trialResult?.task_name ?? `trial-${index + 1}`,
    index,
    status: "unknown",
    failure_category: "unknown",
    failure_signals: [],
    summary_path: null,
    trace_path: null,
    commands_executed: 0,
    input_tokens: 0,
    cache_tokens: 0,
    cache_read_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    length_finish_count: 0,
    converge_turns: 0,
    cost_usd: null,
    duration_ms: 0,
    suspension_to_exit_ms: null,
    terminal_origin: null,
    termination_source: null,
    execution_mode: null,
    agent_profile: null,
    harbor_deadline_sec: null,
    sigma_deadline_sec: null,
    last_error: null,
    trial_name: null,
    harbor_result_path: null,
    reward: null,
    verifier_status: null,
    agent_exception: null,
    infra_warnings: [],
    verifier_failed_tests: [],
    verifier_log_path: null,
    harness_service_cleanup_stopped: []
  };
}

function withLayeredOutcomes(task, trialResult) {
  const traceSummary = trialResult?.agent_trace_summary ?? {};
  const metadata = trialResult?.agent_result?.metadata ?? {};
  const agentFailed = Boolean(trialResult?.exception_info)
    || (typeof metadata.exit_code === "number" && metadata.exit_code !== 0)
    || ["error", "failed", "cancelled"].includes(traceSummary.status);
  const agentOutcome = task.agent_outcome ?? (traceSummary.status === "completed" || (!agentFailed && metadata.exit_code === 0)
    ? "completed" : agentFailed ? "failed" : "unknown");
  const reward = trialResult?.verifier_result?.rewards?.reward;
  const infrastructureEvidence = Array.isArray(trialResult?.verifier_infrastructure_evidence)
    ? trialResult.verifier_infrastructure_evidence : [];
  if (FAILURE_COUNT_BUCKETS.get(task.failure_category) === "infra_failed") {
    return withSuggestedOwner({
      ...task,
      status: "infra_failed",
      agent_outcome: "infrastructure_incomplete",
      verifier_status: "not_run",
      verifier_outcome: "not_run",
      validity: "infra_failed",
      verifier_infrastructure_evidence: []
    });
  }
  if (task.failure_category === "structured_blocker") {
    return withSuggestedOwner({
      ...task,
      status: "failed",
      agent_outcome: "blocked",
      agent_exception_audit: task.agent_exception ?? null,
      agent_exception: null,
      verifier_status: "not_run",
      verifier_outcome: "not_run",
      validity: "valid",
      verifier_infrastructure_evidence: []
    });
  }
  if (infrastructureEvidence.length > 0) {
    return withSuggestedOwner({
      ...task,
      status: "infra_failed",
      failure_category: "verifier_setup_failed",
      verifier_status: "infra_failed",
      agent_outcome: agentOutcome,
      verifier_outcome: "infra_failed",
      validity: "infra_failed",
      verifier_infrastructure_evidence: infrastructureEvidence,
      last_error: `Verifier infrastructure failed before product assertions: ${infrastructureEvidence.join(", ")}.`
    });
  }
  const verifierOutcome = typeof reward === "number"
    ? reward >= 1 ? "passed" : "failed"
    : (trialResult?.verifier_failed_tests?.length ?? 0) > 0 ? "failed" : "not_run";
  return withSuggestedOwner({
    ...task,
    agent_outcome: agentOutcome,
    verifier_outcome: verifierOutcome,
    validity: "valid",
    verifier_infrastructure_evidence: []
  });
}

function slotMatchesObservedTask(slot, trialResult) {
  const expected = slot?.harbor_task_identity;
  if (!expected || expected.kind !== "name") return true;
  return expected.name === trialResult?.task_name;
}

function mergeHarborTrialResults(mirroredTasks, harborTrialResults, runSlots = []) {
  const unused = new Set(mirroredTasks.map((_task, index) => index));
  const slots = new Map(runSlots
    .filter((slot) => typeof slot?.run_slot === "string")
    .map((slot) => [slot.run_slot, slot]));
  const slotTrialCounts = new Map();
  const mappingErrors = [];
  const tasks = harborTrialResults.map((trialResult, index) => {
    const slot = slots.get(trialResult.run_slot);
    if (slots.size > 0 && !slot) {
      mappingErrors.push(`Harbor trial ${trialResult.trial_name} has unknown run slot ${trialResult.run_slot ?? "none"}.`);
    }
    if (slot) {
      slotTrialCounts.set(slot.run_slot, (slotTrialCounts.get(slot.run_slot) ?? 0) + 1);
      if (!slotMatchesObservedTask(slot, trialResult)) {
        mappingErrors.push(
          `Harbor trial ${trialResult.trial_name} task identity does not match run slot ${slot.run_slot}.`
        );
      }
    }
    const mirrorIndex = mirroredTasks.findIndex((task, candidateIndex) => unused.has(candidateIndex) && (
      slot ? task.run_slot === slot.run_slot : artifactMatchesTrial(task, trialResult)
    ));
    const mirror = mirrorIndex >= 0 ? mirroredTasks[mirrorIndex] : emptyTaskForTrial(trialResult, index);
    if (mirrorIndex >= 0) unused.delete(mirrorIndex);
    const merged = withLayeredOutcomes(
      mergeHarborTrialResult({ ...mirror, index }, trialResult),
      trialResult
    );
    return slot ? {
      ...merged,
      run_slot: slot.run_slot,
      provenance_source: slot.provenance_source ?? null,
      selection_identity: slot.selection_identity ?? null,
      selection_identity_sha256: slot.selection_identity_sha256 ?? null,
      harbor_task_identity: slot.harbor_task_identity ?? null,
      observed_harbor_task_name: trialResult.task_name ?? null
    } : merged;
  });
  for (const slot of slots.values()) {
    if (!slot.harbor_task_identity) continue;
    const count = slotTrialCounts.get(slot.run_slot) ?? 0;
    if (count !== 1) mappingErrors.push(`Harbor run slot ${slot.run_slot} contains ${count} trial results; expected 1.`);
  }
  const orphanArtifacts = [...unused].map((index) => {
    const task = mirroredTasks[index];
    return {
      artifact_task_id: task.task_id,
      source_logs_dir: task.source_logs_dir ?? null,
      summary_path: task.summary_path,
      trace_path: task.trace_path,
      last_error: task.last_error
    };
  });
  return { tasks, orphanArtifacts, mappingErrors };
}

function mergeHarborTrialResult(task, trialResult) {
  const reward = trialResult?.verifier_result?.rewards?.reward;
  const exceptionMessage = trialResult?.exception_info?.exception_message;
  const agentResult = trialResult?.agent_result ?? {};
  const agentMetadata = agentResult?.metadata ?? {};
  const agentExitCode = typeof agentMetadata.exit_code === "number" ? agentMetadata.exit_code : null;
  const agentErrorMessage = typeof agentMetadata.error_message === "string" && agentMetadata.error_message
    ? agentMetadata.error_message
    : null;
  const traceSummary = {
    ...(task.runtime_status ? { status: task.runtime_status } : {}),
    ...(task.finish_reason ? { finish_reason: task.finish_reason } : {}),
    ...(task.terminal_origin ? { terminal_origin: task.terminal_origin } : {}),
    ...(task.termination_source ? { termination_source: task.termination_source } : {}),
    ...(trialResult?.agent_trace_summary ?? {})
  };
  const verifierFailedTests = Array.isArray(trialResult?.verifier_failed_tests) ? trialResult.verifier_failed_tests : [];
  const next = {
    ...task,
    task_id: trialResult?.task_name ?? task.task_id,
    run_slot: trialResult?.run_slot ?? task.run_slot ?? null,
    trial_name: trialResult?.trial_name ?? null,
    harbor_result_path: trialResult?.result_path ?? null,
    reward: typeof reward === "number" ? reward : null,
    verifier_status: verifierStatusFromReward(reward, verifierFailedTests),
    agent_exception: agentExceptionFromTrial(trialResult, exceptionMessage),
    infra_warnings: Array.isArray(task.infra_warnings) ? [...task.infra_warnings] : [],
    trace_path: task.trace_path ?? trialResult?.agent_trace_path ?? null,
    commands_executed: Number(
      agentMetadata.commands_executed ?? (task.commands_executed || traceSummary.commands_executed || 0)
    ),
    input_tokens: Number(agentResult.n_input_tokens ?? (task.input_tokens || traceSummary.input_tokens || 0)),
    cache_tokens: Number(agentResult.n_cache_tokens ?? (task.cache_tokens || traceSummary.cache_tokens || 0)),
    cache_read_tokens: Number(
      task.cache_read_tokens || traceSummary.cache_read_tokens || agentResult.n_cache_read_tokens
      || 0
    ),
    output_tokens: Number(agentResult.n_output_tokens ?? (task.output_tokens || traceSummary.output_tokens || 0)),
    reasoning_tokens: Number(
      task.reasoning_tokens || traceSummary.reasoning_tokens || agentResult.n_reasoning_tokens || 0
    ),
    length_finish_count: Number(
      task.length_finish_count || traceSummary.length_finish_count || agentResult.length_finish_count || 0
    ),
    converge_turns: Number(task.converge_turns || traceSummary.converge_turns || agentResult.converge_turns || 0),
    cost_usd: Number.isFinite(Number(agentResult.cost_usd ?? task.cost_usd ?? traceSummary.cost_usd))
      ? Number(agentResult.cost_usd ?? task.cost_usd ?? traceSummary.cost_usd)
      : null,
    duration_ms: task.duration_ms || Number(traceSummary.duration_ms ?? 0),
    suspension_to_exit_ms: task.suspension_to_exit_ms
      ?? traceSummary.suspension_to_exit_ms ?? agentMetadata.suspension_to_exit_ms ?? null,
    terminal_origin: task.terminal_origin ?? traceSummary.terminal_origin ?? agentMetadata.terminal_origin ?? null,
    termination_source: task.termination_source ?? traceSummary.termination_source
      ?? agentMetadata.termination_source ?? null,
    network_mode_effective: task.network_mode_effective ?? traceSummary.network_mode_effective
      ?? agentMetadata.network_mode_effective ?? null,
    execution_mode: task.execution_mode ?? traceSummary.execution_mode ?? agentMetadata.execution_mode ?? null,
    managed_environment_mode: task.managed_environment_mode ?? traceSummary.managed_environment_mode
      ?? agentMetadata.managed_environment_mode ?? null,
    harbor_topology: task.harbor_topology ?? traceSummary.harbor_topology
      ?? agentMetadata.harbor_topology ?? null,
    agent_profile: task.agent_profile ?? traceSummary.agent_profile ?? agentMetadata.agent_profile ?? null,
    harbor_deadline_sec: task.harbor_deadline_sec ?? traceSummary.harbor_deadline_sec
      ?? agentMetadata.harbor_deadline_sec ?? null,
    sigma_deadline_sec: task.sigma_deadline_sec ?? traceSummary.sigma_deadline_sec
      ?? agentMetadata.sigma_deadline_sec ?? null,
    last_error: agentErrorMessage ?? task.last_error ?? traceSummary.last_error ?? null,
    failure_code: agentMetadata.failure_code ?? traceSummary.failure_code ?? task.failure_code ?? null,
    verifier_failed_tests: verifierFailedTests,
    verifier_log_path: trialResult?.verifier_log_path ?? null,
    failure_signals: Array.isArray(task.failure_signals) ? [...task.failure_signals] : [],
    harness_service_cleanup_stopped: Array.isArray(task.harness_service_cleanup_stopped)
      ? [...task.harness_service_cleanup_stopped]
      : []
  };
  const trialLogText = `${exceptionMessage ?? ""}\n${agentErrorMessage ?? ""}\n${JSON.stringify(trialResult)}`;

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
      exitCode: 1,
      failureKind: agentMetadata.failure_kind ?? task.failure_category
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

  if (typeof reward === "number" && reward >= 1 && (agentErrorMessage || (agentExitCode !== null && agentExitCode !== 0))) {
    next.status = "passed";
    next.failure_category = null;
    next.failure_signals = [];
    addSignal(next.infra_warnings, "agent_error_after_verifier_pass");
    return next;
  }

  if (agentErrorMessage || (agentExitCode !== null && agentExitCode !== 0)) {
    next.status = "failed";
    next.failure_category = classifyFailure({
      summary: traceSummary,
      traceEvents: trialResult?.agent_trace_events ?? [],
      logText: trialLogText,
      exitCode: agentExitCode ?? 1,
      failureKind: agentMetadata.failure_kind ?? task.failure_category
    });
    next.last_error = agentErrorMessage ?? `agent exited with code ${agentExitCode}`;
    next.failure_signals = collectFailureSignals({
      existingSignals: next.failure_signals,
      summary: traceSummary,
      traceEvents: trialResult?.agent_trace_events ?? [],
      logText: trialLogText,
      verifierFailures: next.verifier_failed_tests,
      verifierFailed: false,
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
    metadata,
    failureKind: metadata.failure_kind,
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
        verifierFailed: status === "failed" && ["verifier_failed", "verifier_failure"].includes(failureCategory)
      });
  if (status === "failed" && ["verifier_failed", "verifier_failure"].includes(failureCategory) && summary.status === "completed") {
    addSignal(failureSignals, "agent_completed_but_verifier_failed");
  }

  return {
    task_id: metadata.task_id ?? metadata.task_name ?? path.basename(taskDir),
    run_slot: metadata.run_slot ?? metadata.task_id ?? path.basename(taskDir),
    source_logs_dir: typeof metadata.source_logs_dir === "string" ? metadata.source_logs_dir : null,
    artifact_dir: path.relative(runDir, taskDir).replace(/\\/g, "/"),
    index,
    status,
    runtime_status: summary.status ?? null,
    finish_reason: summary.finish_reason ?? summary.finishReason ?? null,
    agent_outcome: summary.status === "completed" ? "completed"
      : ["error", "failed", "cancelled"].includes(summary.status) ? "failed" : "unknown",
    failure_category: failureCategory,
    failure_signals: failureSignals,
    summary_path: relativePathOrNull(runDir, summaryPath),
    trace_path: relativePathOrNull(runDir, tracePath),
    commands_executed: Number(summary.commands_executed ?? metadata.commands_executed ?? 0),
    input_tokens: Number(summary.input_tokens ?? metadata.n_input_tokens ?? 0),
    cache_tokens: Number(summary.cache_tokens ?? metadata.n_cache_tokens ?? 0),
    cache_read_tokens: Number(summary.cache_read_tokens ?? metadata.n_cache_read_tokens ?? 0),
    output_tokens: Number(summary.output_tokens ?? metadata.n_output_tokens ?? 0),
    reasoning_tokens: Number(summary.reasoning_tokens ?? metadata.n_reasoning_tokens ?? 0),
    length_finish_count: Number(summary.length_finish_count ?? metadata.length_finish_count ?? 0),
    converge_turns: Number(summary.converge_turns ?? metadata.converge_turns ?? 0),
    cost_usd: Number.isFinite(Number(summary.cost_usd ?? metadata.cost_usd))
      ? Number(summary.cost_usd ?? metadata.cost_usd)
      : null,
    duration_ms: Number(summary.duration_ms ?? metadata.duration_ms ?? 0),
    suspension_to_exit_ms: summary.suspension_to_exit_ms ?? metadata.suspension_to_exit_ms ?? null,
    terminal_origin: summary.terminal_origin ?? metadata.terminal_origin ?? null,
    termination_source: summary.termination_source ?? metadata.termination_source ?? null,
    network_mode_effective: summary.network_mode_effective ?? metadata.network_mode_effective ?? null,
    execution_mode: summary.execution_mode ?? metadata.execution_mode ?? null,
    managed_environment_mode: summary.managed_environment_mode ?? metadata.managed_environment_mode ?? null,
    harbor_topology: summary.harbor_topology ?? metadata.harbor_topology ?? null,
    agent_profile: summary.agent_profile ?? metadata.agent_profile ?? null,
    harbor_deadline_sec: summary.harbor_deadline_sec ?? metadata.harbor_deadline_sec ?? null,
    sigma_deadline_sec: summary.sigma_deadline_sec ?? metadata.sigma_deadline_sec ?? null,
    last_error: summary.last_error ?? metadata.error_message ?? null,
    failure_code: summary.failure_code ?? metadata.failure_code ?? null,
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
  const status = config.exit_code === 0
    ? "passed"
    : config.exit_code === null || config.exit_code === undefined
      ? "unknown"
      : "failed";
  const failureCategory =
    status === "passed"
      ? null
      : status === "unknown"
        ? "unknown"
      : classifyFailure({
          summary: {},
          traceEvents: [],
          logText: globalLogText,
          exitCode: config.exit_code
        });
  return {
    task_id: "run",
    source_logs_dir: null,
    artifact_dir: null,
    index: 0,
    status,
    failure_category: failureCategory,
    failure_signals: status === "passed" ? [] : collectFailureSignals({ logText: globalLogText }),
    summary_path: null,
    trace_path: null,
    commands_executed: 0,
    input_tokens: 0,
    cache_tokens: 0,
    cache_read_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    length_finish_count: 0,
    converge_turns: 0,
    cost_usd: null,
    duration_ms: 0,
    suspension_to_exit_ms: null,
    terminal_origin: null,
    termination_source: null,
    execution_mode: null,
    agent_profile: null,
    harbor_deadline_sec: null,
    sigma_deadline_sec: null,
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

function normalizedTaskKey(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/").replace(/\/+$/u, "");
  return normalized.split("/").at(-1) ?? normalized;
}

function deadlineFieldsForTask(task, config) {
  const key = normalizedTaskKey(task.task_id);
  const timeoutRecord = (Array.isArray(config.timeout_probe?.tasks) ? config.timeout_probe.tasks : [])
    .find((item) => normalizedTaskKey(item?.task_name ?? item?.task_path) === key);
  const timeoutGroup = (Array.isArray(config.timeout_groups) ? config.timeout_groups : [])
    .find((group) => Array.isArray(group?.task_names)
      && group.task_names.some((name) => normalizedTaskKey(name) === key));
  const harborDeadline = Number(timeoutRecord?.agent_timeout_sec);
  const sigmaDeadline = Number(timeoutGroup?.timeout_plan?.agent_wall_time_sec
    ?? (config.timeout_plan?.outer_trial_deadline_scope === "uniform_task_timeout"
      ? config.timeout_plan?.agent_wall_time_sec : NaN));
  return {
    harbor_deadline_sec: task.harbor_deadline_sec
      ?? (Number.isFinite(harborDeadline) ? harborDeadline : null),
    sigma_deadline_sec: task.sigma_deadline_sec
      ?? (Number.isFinite(sigmaDeadline) ? sigmaDeadline : null),
    termination_source: task.termination_source ?? task.terminal_origin
      ?? (task.verifier_status ? "harbor_verifier" : null)
  };
}

function reportProfile(report) {
  if (typeof report?.agent_profile === "string" && report.agent_profile) return report.agent_profile;
  const profiles = [...new Set((Array.isArray(report?.tasks) ? report.tasks : [])
    .map((task) => task?.agent_profile).filter(Boolean))];
  return profiles.length === 1 ? profiles[0] : null;
}

/** Comparison consumers must never combine solving and conformance lanes. */
export function assertComparableBenchmarkReports(...reports) {
  const profiles = [...new Set(reports.map(reportProfile).filter(Boolean))];
  if (profiles.length > 1) {
    throw Object.assign(new Error(
      `Benchmark reports use different agent profiles (${profiles.join(", ")}) and cannot be combined.`
    ), { code: "benchmark_profile_mismatch" });
  }
  const lanes = [...new Set(reports.map((report) => report?.evaluation_lane).filter(Boolean))];
  if (lanes.length > 1) {
    throw Object.assign(new Error(
      `Benchmark reports use different evaluation lanes (${lanes.join(", ")}) and cannot be combined.`
    ), { code: "benchmark_lane_mismatch" });
  }
}

function taskHasSignal(task, pattern) {
  return pattern.test(JSON.stringify({
    category: task.failure_category,
    signals: task.failure_signals,
    error: task.last_error
  }));
}

export function laneMetrics(tasks, evaluationLane) {
  const valid = tasks.filter((task) => task.validity === "valid");
  const verifierReached = valid.filter((task) => task.verifier_outcome === "passed"
    || task.verifier_outcome === "failed");
  const verifierPassed = verifierReached.filter((task) => task.verifier_outcome === "passed").length;
  if (evaluationLane !== "strict_conformance") {
    return {
      verifier_reached: verifierReached.length,
      verifier_passed: verifierPassed,
      verifier_pass_rate: verifierReached.length > 0 ? verifierPassed / verifierReached.length : null
    };
  }
  return {
    review_blocked: valid.filter((task) => taskHasSignal(task, /review_evidence|required review|strict review/iu)).length,
    validation_blocked: valid.filter((task) => taskHasSignal(task, /validation_evidence|validation_failed|semantic validation/iu)).length,
    deadline_blocked: valid.filter((task) => task.failure_category === "timeout"
      || taskHasSignal(task, /max_wall_time|deadline|timed out/iu)).length,
    budget_blocked: valid.filter((task) => taskHasSignal(task, /budget_exhausted|budget.*remain/iu)).length,
    total: valid.length
  };
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
    `- Agent profile: ${report.agent_profile ?? "unknown"}`,
    `- Evaluation lane: ${report.evaluation_lane ?? "unknown"}`,
    `- Score mode: ${report.score_mode ?? "standard_benchmark"}`,
    `- Started: ${report.started_at ?? "unknown"}`,
    `- Finished: ${report.finished_at ?? "unknown"}`,
    `- Exit code: ${report.exit_code}`,
    `- Harbor exit code: ${report.harbor_exit_code ?? report.exit_code}`,
    `- Command: ${markdownEscape(report.command ?? "")}`,
    `- Harbor: ${markdownEscape(report.harbor_command ?? "harbor")}${report.harbor_version ? ` (${markdownEscape(report.harbor_version)})` : ""}`,
    `- Concurrent trials: ${report.n_concurrent_trials ?? "unknown"}`,
    "",
    "## Trial Accounting",
    "",
    `- Expected: ${report.trial_accounting?.expected ?? "unknown"}`,
    `- Observed: ${report.trial_accounting?.observed ?? "unknown"}`,
    `- Scored: ${report.trial_accounting?.scored ?? "unknown"}`,
    `- Errored: ${report.trial_accounting?.errored ?? "unknown"}`,
    `- Missing: ${report.trial_accounting?.missing ?? "unknown"}`,
    `- Mean reward: ${report.trial_accounting?.meanReward ?? "unknown"}`,
    `- Input tokens: ${report.usage?.input_tokens ?? 0}`,
    `- Cache tokens: ${report.usage?.cache_tokens ?? 0}`,
    `- Cache read ratio: ${report.cache_read_ratio ?? "unknown"}`,
    `- Output tokens: ${report.usage?.output_tokens ?? 0}`,
    `- Reasoning tokens: ${report.reasoning_tokens ?? report.usage?.reasoning_tokens ?? 0}`,
    `- Reasoning/output ratio: ${report.reasoning_output_ratio ?? "unknown"}`,
    `- Length finishes: ${report.length_finish_count ?? 0}`,
    `- Converge turns: ${report.converge_turns ?? 0}`,
    `- Cost USD: ${report.cost_usd ?? 0}`,
    `- Lane metrics: ${markdownEscape(JSON.stringify(report.lane_metrics ?? {}))}`,
    "",
    "## Timeout Plan",
    "",
    `- Source: ${report.timeout_plan?.source ?? "unknown"}`,
    `- Recommended agent timeout sec: ${report.timeout_plan?.recommended_agent_timeout_sec ?? "unknown"}`,
    `- Agent wall time sec: ${report.timeout_plan?.agent_wall_time_sec ?? "unknown"}`,
    `- Harness timeout sec: ${report.timeout_plan?.harness_timeout_sec ?? "unknown"}`,
    `- Effective harness timeout sec: ${report.timeout_plan?.effective_harness_timeout_sec ?? report.timeout_plan?.harness_timeout_sec ?? "unknown"}`,
    `- Outer trial deadline scope: ${report.timeout_plan?.outer_trial_deadline_scope ?? "unavailable"}`,
    `- Agent timeout multiplier: ${report.timeout_plan?.agent_timeout_multiplier ?? "none"}`,
    "",
    "## Counts",
    "",
    "| passed | failed | infra_failed | structured_blocker | timeout | api_error | needs_input | tool_error | verifier_failure | unknown |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${report.counts.passed} | ${report.counts.failed} | ${report.counts.infra_failed} | ${report.counts.structured_blocker} | ${report.counts.timeout} | ${report.counts.api_error} | ${report.counts.needs_input} | ${report.counts.tool_error} | ${report.counts.verifier_failure} | ${report.counts.unknown} |`,
    "",
    "## Tasks",
    "",
    "| task | status | failure_category | suggested_owner | warnings | verifier_status | failure_signals | commands | input_tokens | cache_tokens | output_tokens | cost_usd | duration_ms | harbor_deadline_sec | sigma_deadline_sec | termination_source | execution_mode | agent_profile | last_error |",
    "| --- | --- | --- | --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |"
  ];

  for (const task of report.tasks) {
    const failureSignals = Array.isArray(task.failure_signals) ? task.failure_signals.join(", ") : "";
    const suggestedOwner = task.suggested_owner ?? suggestedOwnerForTask(task.status, task.failure_category, task.failure_signals) ?? "";
    const warningCount = Array.isArray(task.infra_warnings) ? task.infra_warnings.length : 0;
    lines.push(
      `| ${markdownEscape(task.task_id)} | ${task.status} | ${task.failure_category ?? ""} | ${markdownEscape(suggestedOwner)} | ${warningCount} | ${task.verifier_status ?? ""} | ${markdownEscape(failureSignals)} | ${task.commands_executed} | ${task.input_tokens} | ${task.cache_tokens ?? 0} | ${task.output_tokens} | ${task.cost_usd ?? ""} | ${task.duration_ms} | ${task.harbor_deadline_sec ?? ""} | ${task.sigma_deadline_sec ?? ""} | ${task.termination_source ?? ""} | ${task.execution_mode ?? ""} | ${task.agent_profile ?? ""} | ${markdownEscape(task.last_error ?? "")} |`
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
  if (config.frozen_runtime_integrity === "failed") {
    incompleteReason.push("Frozen Harbor runtime changed or became unverifiable during the run.");
  }
  if (missingLogFiles.length > 0) {
    incompleteReason.push(`missing expected log files: ${missingLogFiles.join(", ")}`);
  }
  incompleteReason.push(...await runSlotIntegrityReasons(runDir, config));
  const globalLogText = [
    await readTextSafe(path.join(runDir, "harbor.stdout.log")),
    await readTextSafe(path.join(runDir, "harbor.stderr.log")),
    await readTextSafe(path.join(runDir, "result.raw.log"))
  ].join("\n");
  const defaultJobsDir = path.join(runDir, "harbor-jobs");
  const configuredJobsDir = typeof config.harbor_jobs_dir === "string"
    ? path.resolve(config.harbor_jobs_dir)
    : defaultJobsDir;
  const allowedJobRoots = [path.resolve(runDir), path.resolve(os.tmpdir(), "sigma-harbor")];
  const jobsDirAllowed = allowedJobRoots.some((root) => {
    const relative = path.relative(root, configuredJobsDir);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
  });
  if (!jobsDirAllowed) {
    incompleteReason.push("Configured Harbor jobs directory is outside the run or runtime scratch roots.");
  }
  const taskDirs = await listTaskDirs(runDir);
  const mirroredTasks = taskDirs.length > 0
    ? await Promise.all(taskDirs.map((taskDir, index) => taskReportFromDir(runDir, taskDir, index, config, globalLogText)))
    : [syntheticRunTask(config, globalLogText)];
  const harborTrialResults = jobsDirAllowed ? await readHarborTrialResults(runDir, configuredJobsDir) : [];
  const harborJobAccounting = jobsDirAllowed ? await readHarborJobAccounting(runDir, configuredJobsDir) : null;
  const resolvedJobConfig = await resolvedJobConfigForReport(runDir, config);
  const expected = expectedTrialCount(config, resolvedJobConfig);
  const accounting = trialAccounting(expected, harborTrialResults);
  const hasHarborEvidence = jobsDirAllowed && existsSync(configuredJobsDir)
    || typeof config.resolved_job_config_path === "string";
  if (hasHarborEvidence && expected > 0) {
    if (accounting.observed !== expected) {
      incompleteReason.push(`Harbor trial result count ${accounting.observed} does not match expected ${expected}.`);
    }
    if (!harborJobAccounting) {
      incompleteReason.push("Harbor job result.json summary is missing.");
    } else {
      if (harborJobAccounting.total !== expected) {
        incompleteReason.push(`Harbor job total ${harborJobAccounting.total} does not match expected ${expected}.`);
      }
      if (harborJobAccounting.completed !== expected) {
        incompleteReason.push(`Harbor job completed count ${harborJobAccounting.completed} does not match expected ${expected}.`);
      }
      if (harborJobAccounting.errored !== accounting.errored) {
        incompleteReason.push(
          `Harbor job errored count ${harborJobAccounting.errored} does not match trial exceptions ${accounting.errored}.`
        );
      }
      if (harborJobAccounting.retries !== 0) {
        incompleteReason.push(`Harbor reported ${harborJobAccounting.retries} retries; benchmark retries are prohibited.`);
      }
    }
  }
  let tasks = mirroredTasks;
  let orphanArtifacts = [];
  if (harborTrialResults.length > 0) {
    const merged = mergeHarborTrialResults(
      mirroredTasks,
      harborTrialResults,
      Array.isArray(config.run_slots) ? config.run_slots : []
    );
    tasks = merged.tasks;
    orphanArtifacts = merged.orphanArtifacts;
    incompleteReason.push(...merged.mappingErrors);
  }
  tasks = tasks.map((task) => withSuggestedOwner({
    agent_outcome: task.agent_outcome ?? (task.status === "passed" ? "completed" : "unknown"),
    verifier_outcome: task.verifier_outcome ?? (task.verifier_status ?? "not_run"),
    validity: task.validity ?? "valid",
    verifier_infrastructure_evidence: task.verifier_infrastructure_evidence ?? [],
    ...task,
    agent_profile: task.agent_profile ?? config.agent_profile ?? null,
    ...deadlineFieldsForTask(task, config)
  }));
  const taskProfiles = [...new Set(tasks.map((task) => task.agent_profile).filter(Boolean))];
  if (taskProfiles.length > 1) {
    incompleteReason.push(`Benchmark report contains mixed agent profiles: ${taskProfiles.join(", ")}.`);
  }

  const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, 0]));
  for (const task of tasks) {
    addCount(counts, task.status, task.failure_category);
  }
  const validity = {
    valid: tasks.filter((task) => task.validity === "valid").length,
    infra_failed: tasks.filter((task) => task.validity === "infra_failed").length
  };
  const effectiveTasks = tasks.filter((task) => task.validity === "valid");
  const effectivePassed = effectiveTasks.filter((task) => task.verifier_outcome === "passed").length;

  const commandScript = await readTextSafe(commandPath);
  const notes = Array.isArray(config.notes) ? [...config.notes] : [];
  if (taskDirs.length === 0 && harborTrialResults.length === 0) {
    notes.push("Harbor did not expose per-task trace/summary files in a predictable place for this run; inspect harbor.stdout.log and harbor.stderr.log.");
  }

  const failedCount = counts.failed + counts.infra_failed + counts.timeout + counts.api_error
    + counts.structured_blocker + counts.needs_input + counts.tool_error
    + counts.verifier_failure + counts.unknown;
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
  const usage = tasks.reduce((total, task) => ({
    input_tokens: total.input_tokens + Number(task.input_tokens ?? 0),
    cache_tokens: total.cache_tokens + Number(task.cache_tokens ?? 0),
    cache_read_tokens: total.cache_read_tokens + Number(task.cache_read_tokens ?? 0),
    output_tokens: total.output_tokens + Number(task.output_tokens ?? 0),
    reasoning_tokens: total.reasoning_tokens + Number(task.reasoning_tokens ?? 0)
  }), { input_tokens: 0, cache_tokens: 0, cache_read_tokens: 0, output_tokens: 0, reasoning_tokens: 0 });
  const cacheReadRatio = usage.input_tokens > 0 ? usage.cache_read_tokens / usage.input_tokens : null;
  const reasoningOutputRatio = usage.output_tokens > 0 ? usage.reasoning_tokens / usage.output_tokens : null;
  const lengthFinishCount = tasks.reduce(
    (total, task) => total + Number(task.length_finish_count ?? 0), 0
  );
  const convergeTurns = tasks.reduce((total, task) => total + Number(task.converge_turns ?? 0), 0);
  const costUsd = tasks.reduce((total, task) => {
    const value = Number(task.cost_usd);
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
  const report = {
    run_id: config.run_id ?? path.basename(runDir),
    started_at: config.started_at ?? null,
    finished_at: config.finished_at ?? null,
    provider: config.provider ?? "unknown",
    model: config.model ?? null,
    dataset: config.dataset ?? terminalBenchDataset,
    agent_profile: taskProfiles.length === 1 ? taskProfiles[0] : config.agent_profile ?? null,
    evaluation_lane: config.evaluation_lane
      ?? ((taskProfiles.length === 1 ? taskProfiles[0] : config.agent_profile) === "strict"
        ? "strict_conformance" : "solving"),
    k: config.k ?? null,
    command: config.command_text ?? commandScript.trim(),
    harbor_command: config.harbor_command ?? config.command?.[0] ?? null,
    harbor_version: config.harbor_version ?? null,
    harbor_capabilities: config.harbor_capabilities ?? null,
    timeout_plan: config.timeout_plan ?? null,
    timeout_probe_tasks: Array.isArray(config.timeout_probe?.tasks) ? config.timeout_probe.tasks : [],
    resolved_job_config_path: config.resolved_job_config_path ?? null,
    tasks_file_sha256: config.tasks_file_sha256 ?? null,
    task_selection_sha256: config.task_selection_sha256 ?? null,
    run_slots: Array.isArray(config.run_slots) ? config.run_slots : [],
    agent_cli_sha256: config.agent_cli_sha256 ?? null,
    package_reused: config.package_reused ?? false,
    n_concurrent_trials: resolvedJobConfig?.n_concurrent_trials ?? config.n_concurrent_trials ?? null,
    trial_accounting: accounting,
    validity,
    effective_correctness: {
      passed: effectivePassed,
      total: effectiveTasks.length,
      pass_rate: effectiveTasks.length > 0 ? effectivePassed / effectiveTasks.length : null
    },
    harbor_job_accounting: harborJobAccounting,
    orphan_artifacts: orphanArtifacts,
    usage,
    reasoning_tokens: usage.reasoning_tokens,
    cache_read_ratio: cacheReadRatio,
    reasoning_output_ratio: reasoningOutputRatio,
    length_finish_count: lengthFinishCount,
    converge_turns: convergeTurns,
    cost_usd: costUsd,
    incomplete_reason: incompleteReason.length > 0 ? incompleteReason : null,
    exit_code: exitCode,
    harbor_exit_code: exitCode,
    score_status: scoreStatus,
    infra_status: infraStatus,
    network_mode: config.network_mode ?? null,
    execution_mode: config.execution_mode ?? "sandboxed",
    managed_environment_mode: config.managed_environment_mode ?? "disabled",
    harbor_topology: config.harbor_topology ?? "main_only",
    score_mode: config.score_mode ?? (config.benchmark_class === "diagnostic" ? "diagnostic" : "standard_benchmark"),
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
  report.lane_metrics = laneMetrics(tasks, report.evaluation_lane);

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
    SIGMA_HARBOR_RUN_ID: safePathPart(path.basename(path.resolve(runDir))),
    PYTHONIOENCODING: env.PYTHONIOENCODING || "utf-8",
    PYTHONUTF8: env.PYTHONUTF8 || "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPYCACHEPREFIX: path.join(path.resolve(runDir), "runtime-scratch", "pycache"),
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
