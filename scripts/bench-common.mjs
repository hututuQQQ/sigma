import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  discoverArchiveRoot,
  extractArchiveMemberBytes,
  inspectArchiveBytes
} from "./archive-safety.mjs";

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const artifactsDir = path.join(rootDir, ".artifacts");
export const benchRootDir = path.join(artifactsDir, "bench");
export const harborRuntimeDir = path.join(artifactsDir, "harbor-runtime");
export const harborSandboxComposePath = path.join(
  harborRuntimeDir,
  "docker-compose-sigma-sandbox.yaml"
);
export const harborContainerComposePath = path.join(
  harborRuntimeDir,
  "docker-compose-sigma-container.yaml"
);
export function harborTopologyForOptions(options = {}) {
  return options.executionMode === "container" || options.managedProvenance === true
    ? "managed_three_role"
    : "main_only";
}
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

/** Build provenance is collected before packaging so reports can distinguish
 * immutable subjects from dirty working-tree builds. The archive digest remains
 * the authority for the exact bytes that were executed. */
export function repositorySourceIdentity(directory = rootDir) {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: directory, encoding: "utf8", windowsHide: true
  });
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: directory, encoding: "utf8", windowsHide: true
  });
  return {
    revision: revision.status === 0 && /^[a-f0-9]{40}$/u.test(revision.stdout.trim())
      ? revision.stdout.trim() : null,
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : null
  };
}

/** Read source provenance that is transitively bound by the exact archive
 * digest. Legacy archives may return null and require a launcher-pinned source
 * revision before they are eligible for a benchmark report. */
export function agentCliArchiveSourceIdentity(archivePath) {
  const bytes = readFileSync(path.resolve(archivePath));
  const bundleRoot = discoverArchiveRoot(bytes, "Sigma agent CLI benchmark archive");
  const inspection = inspectArchiveBytes(bytes, {
    root: bundleRoot,
    label: "Sigma agent CLI benchmark archive",
    allowedTypes: new Set(["-", "d"])
  });
  const member = `${bundleRoot}/package-metadata.json`;
  const record = inspection.records.find((item) => item.name === member && item.type === "-");
  if (!record) return null;
  if (record.size > 1024 * 1024) {
    throw new Error("Sigma agent CLI archive has no bounded package-metadata.json source record.");
  }
  const metadata = JSON.parse(extractArchiveMemberBytes(bytes, member, {
    label: "Sigma agent CLI benchmark metadata", maxBytes: 1024 * 1024
  }).toString("utf8"));
  const revision = metadata?.source?.revision;
  const dirty = metadata?.source?.dirty;
  if (revision === null || revision === undefined) return null;
  if (typeof revision !== "string" || !/^[a-f0-9]{40}$/u.test(revision)
    || (dirty !== null && typeof dirty !== "boolean")) {
    throw new Error("Sigma agent CLI package source provenance is invalid.");
  }
  return { revision, dirty: dirty ?? null };
}

const COUNT_KEYS = ["passed", "failed", "infra_failed", "timeout", "api_error", "needs_input", "tool_error", "verifier_failure", "unknown"];
const FAILURE_COUNT_BUCKETS = new Map([
  ["host_proxy_error", "infra_failed"],
  ["host_encoding_error", "infra_failed"],
  ["harbor_cli_error", "infra_failed"],
  ["node_missing", "infra_failed"],
  ["agent_setup_failed", "infra_failed"],
  ["verifier_setup_failed", "infra_failed"],
  ["api_error", "api_error"],
  ["needs_input", "needs_input"],
  ["timeout", "timeout"],
  ["tool_error", "tool_error"],
  ["verifier_failure", "verifier_failure"],
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
  ["verifier_setup_failed", "environment"],
  ["api_error", "agent-model"],
  ["needs_input", "agent-runtime"],
  ["timeout", "agent-runtime"],
  ["tool_error", "agent-tools"],
  ["verifier_failure", "agent-runtime"],
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

function benchmarkContainerEngine(value, fallback = "docker") {
  const engine = asString(value, fallback);
  if (engine !== "docker" && engine !== "podman") {
    throw new Error("benchmark container engine must be docker or podman.");
  }
  return engine;
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

function normalizedGitRevision(value, name) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(text)) throw new Error(`${name} must be a 40-character Git commit.`);
  return text;
}

function validateTaskRecord(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`tasks-file[${index}] must be an object.`);
  }
  const allowed = new Set(["name", "path", "git_url", "git_commit_id", "source"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`tasks-file[${index}] has unsupported fields: ${unknown.join(", ")}.`);
  const name = asString(value.name);
  const taskPath = asString(value.path);
  if (Boolean(name) === Boolean(taskPath)) {
    throw new Error(`tasks-file[${index}] must contain exactly one of name or path.`);
  }
  const gitUrl = asString(value.git_url);
  const gitCommit = asString(value.git_commit_id);
  if (Boolean(gitUrl) !== Boolean(gitCommit)) {
    throw new Error(`tasks-file[${index}] git_url and git_commit_id must be supplied together.`);
  }
  if (gitCommit && !/^[a-f0-9]{40}$/u.test(gitCommit)) {
    throw new Error(`tasks-file[${index}].git_commit_id must be a lowercase 40-character Git commit.`);
  }
  return {
    ...(name ? { name } : { path: taskPath }),
    ...(gitUrl ? { git_url: gitUrl, git_commit_id: gitCommit } : {}),
    ...(asString(value.source) ? { source: asString(value.source) } : {})
  };
}

export function readTaskSelectionFile(filePath) {
  if (!filePath) return [];
  const resolved = path.resolve(filePath);
  const parsed = JSON.parse(readFileSync(resolved, "utf8"));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("--tasks-file must contain a non-empty JSON array.");
  }
  const tasks = parsed.map(validateTaskRecord);
  const identities = tasks.map((task) => task.name ?? `${task.git_url}\0${task.git_commit_id}\0${task.path}`);
  if (new Set(identities).size !== identities.length) throw new Error("--tasks-file contains duplicate tasks.");
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
  const expectedSourceRevision = normalizedGitRevision(
    flags["expected-source-revision"], "--expected-source-revision"
  );
  const terminalBenchRevision = normalizedGitRevision(
    flags["terminal-bench-revision"], "--terminal-bench-revision"
  );
  if (mode === "batch" && terminalBenchRevision) {
    const unpinned = tasks
      .map((task, index) => ({ task, index }))
      .filter(({ task }) => task.git_commit_id !== terminalBenchRevision)
      .map(({ index }) => index);
    if (unpinned.length > 0) {
      throw new Error(
        `--terminal-bench-revision requires every batch task git_commit_id to equal the frozen revision; invalid indexes: ${unpinned.join(", ")}.`
      );
    }
  }
  const preregistrationSha256 = normalizedSha256(
    flags["preregistration-sha256"], "--preregistration-sha256"
  );
  const validationManifestPath = asString(flags["validation-manifest"]);
  const expectedValidationManifestSha256 = normalizedSha256(
    flags["expected-validation-manifest-sha256"], "--expected-validation-manifest-sha256"
  );
  if (Boolean(validationManifestPath) !== Boolean(expectedValidationManifestSha256)) {
    throw new Error("--validation-manifest and --expected-validation-manifest-sha256 are required together.");
  }
  let validationManifest = null;
  if (validationManifestPath) {
    const bytes = readFileSync(path.resolve(validationManifestPath));
    const observed = createHash("sha256").update(bytes).digest("hex");
    if (observed !== expectedValidationManifestSha256) {
      throw new Error(`Validation manifest SHA-256 ${observed} does not match the frozen digest.`);
    }
    validationManifest = JSON.parse(bytes.toString("utf8"));
  }
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
  return {
    mode,
    benchmarkClass: runClass,
    provider: asString(flags.provider, env.AGENT_PROVIDER ?? "deepseek"),
    model: asString(flags.model, env.AGENT_MODEL),
    agentProfile: asString(flags["agent-profile"], env.SIGMA_AGENT_PROFILE ?? "standard"),
    networkMode: networkMode(flags.network ?? env.SIGMA_NETWORK),
    executionMode: executionMode(flags["execution-mode"] ?? env.SIGMA_EXECUTION_MODE),
    managedProvenance: flags["managed-provenance"] === true,
    containerEngine: benchmarkContainerEngine(
      flags["container-engine"] ?? env.SIGMA_CONTAINER_ENGINE
    ),
    runLabel: asString(flags["run-label"]),
    k: asPositiveInt(flags.k, 1, "--k"),
    nConcurrentTrials: asPositiveInt(
      flags.concurrency ?? env.AGENT_BENCH_CONCURRENCY,
      defaultConcurrentTrials,
      "--concurrency"
    ),
    taskId: asString(flags["task-id"]),
    tasksFile: tasksFile ? path.resolve(tasksFile) : null,
    tasksFileSha256: tasksFile
      ? createHash("sha256").update(readFileSync(path.resolve(tasksFile))).digest("hex")
      : null,
    tasks,
    reusePackage: flags["reuse-package"] === true,
    expectedArchiveSha256,
    expectedSourceRevision,
    terminalBenchRevision,
    preregistrationSha256,
    validationManifest,
    validationManifestSha256: expectedValidationManifestSha256,
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
  const standardAgentWallTimeSec = Math.max(1, Math.floor(recommendedAgentTimeoutSec - cleanupGraceSec));
  const agentWallTimeSec = runClass === "standard"
    ? standardAgentWallTimeSec
    : Math.ceil(requestedWallTimeSec ?? lenientAgentWallTimeSec);
  const harnessTimeoutSec = agentWallTimeSec + cleanupGraceSec;
  const agentTimeoutMultiplier = runClass === "diagnostic" &&
    harnessTimeoutSec > recommendedAgentTimeoutSec
      ? formatMultiplier(harnessTimeoutSec / recommendedAgentTimeoutSec)
      : null;
  const timeoutTasks = Array.isArray(timeoutProbe?.tasks) ? timeoutProbe.tasks : [];
  const taskAgentTimeouts = timeoutTasks
    .map((task) => asFinitePositiveNumber(task?.agent_timeout_sec));
  const knownTaskAgentTimeouts = taskAgentTimeouts.filter((value) => value !== null);
  const appliedAgentTimeoutMultiplier = agentTimeoutMultiplier ? Number(agentTimeoutMultiplier) : 1;
  const allTaskTimeoutsAvailable = timeoutTasks.length > 0
    && knownTaskAgentTimeouts.length === timeoutTasks.length;
  const uniformTaskTimeout = allTaskTimeoutsAvailable
    && knownTaskAgentTimeouts.every((value) => value === knownTaskAgentTimeouts[0]);
  const outerTrialDeadlineSec = uniformTaskTimeout
    ? knownTaskAgentTimeouts[0] * appliedAgentTimeoutMultiplier
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
      if (task?.name) return { name: task.name };
      if (task?.path) return { path: task.path };
      return null;
    })
    .filter(Boolean);
}

function harborTaskRecord(task) {
  if (!task || typeof task !== "object") return task;
  const { source: _controlPlaneSource, ...record } = task;
  return record;
}

function benchmarkAgentKwargs(options, timeoutPlan = null) {
  const agentKwargs = {
    agent_cli_tarball: resolveAgentCliTarballPath(options, options.env ?? process.env),
    provider: options.provider,
    agent_profile: options.agentProfile ?? "standard",
    network_mode: options.networkMode ?? "none",
    execution_mode: options.executionMode ?? "sandboxed",
    managed_provenance: options.managedProvenance === true,
    container_engine: options.containerEngine ?? "docker",
    max_turns: asPositiveInt(options.maxTurns, 200, "maxTurns"),
    command_timeout_sec: asPositiveInt(options.commandTimeoutSec, 180, "commandTimeoutSec")
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
    n_concurrent_trials: options.nConcurrentTrials ?? defaultConcurrentTrials,
    agents: [
      {
        name: agentName,
        kwargs: agentKwargs
      }
    ]
  };

  if (options.mode !== "smoke") {
    const composePath = harborTopologyForOptions(options) === "managed_three_role"
      ? options.harborContainerComposePath ?? harborContainerComposePath
      : options.harborSandboxComposePath ?? harborSandboxComposePath;
    config.environment = {
      type: "docker",
      extra_docker_compose: [path.resolve(composePath)]
    };
  }

  const configuredTasks = Array.isArray(options.tasks) ? options.tasks : [];
  const resolvedTasks = selectedTaskRecords(timeoutProbe);
  if (configuredTasks.length > 0) {
    // Harbor 0.17 does not resolve metrics for explicit task sources. Leaving
    // source unset selects its supported adhoc Mean metric while Git/path
    // provenance remains frozen in the external control-plane task file.
    config.tasks = configuredTasks.map(harborTaskRecord);
  } else if (resolvedTasks.length > 0) {
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
  args.push("--ak", formatAgentKwarg("agent_profile", "str", options.agentProfile ?? "standard", capabilities));
  if (options.networkMode !== undefined) {
    args.push("--ak", formatAgentKwarg("network_mode", "str", options.networkMode, capabilities));
  }
  if (options.executionMode !== undefined) {
    args.push("--ak", formatAgentKwarg("execution_mode", "str", options.executionMode, capabilities));
  }
  if (options.managedProvenance === true) {
    args.push("--ak", formatAgentKwarg("managed_provenance", "bool", true, capabilities));
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
    `${shellQuote(harborCommand)} ${harborArgs.map(shellQuote).join(" ")}`,
    ""
  ].join("\n");
}

async function writeText(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

const DEFAULT_PROCESS_CAPTURE_BYTES = 8 * 1024 * 1024;
const DEFAULT_PROCESS_ABORT_GRACE_MS = 5_000;
const DEFAULT_PROCESS_ABORT_KILL_WAIT_MS = 5_000;
const DEFAULT_PROCESS_LOG_FLUSH_MS = 5_000;

class BoundedByteTail {
  constructor(limit) {
    this.limit = limit;
    this.chunks = [];
    this.retainedBytes = 0;
    this.totalBytes = 0;
  }

  append(value) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    this.totalBytes += chunk.length;
    if (chunk.length >= this.limit) {
      this.chunks = [Buffer.from(chunk.subarray(chunk.length - this.limit))];
      this.retainedBytes = this.limit;
      return;
    }
    this.chunks.push(Buffer.from(chunk));
    this.retainedBytes += chunk.length;
    while (this.retainedBytes > this.limit) {
      const overflow = this.retainedBytes - this.limit;
      const first = this.chunks[0];
      if (first.length <= overflow) {
        this.chunks.shift();
        this.retainedBytes -= first.length;
      } else {
        this.chunks[0] = first.subarray(overflow);
        this.retainedBytes -= overflow;
      }
    }
  }

  text() {
    return Buffer.concat(this.chunks, this.retainedBytes).toString("utf8");
  }

  get truncated() {
    return this.totalBytes > this.retainedBytes;
  }
}

function processOptionMilliseconds(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10 * 60 * 1_000) {
    throw new Error(`${name} must be an integer between 1 and 600000 milliseconds.`);
  }
  return value;
}

function processCaptureBytes(value) {
  if (value === undefined) return DEFAULT_PROCESS_CAPTURE_BYTES;
  if (!Number.isSafeInteger(value) || value < 1 || value > 64 * 1024 * 1024) {
    throw new Error("captureLimitBytes must be an integer between 1 and 67108864 bytes.");
  }
  return value;
}

function startTreeKill(child, force) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn(
        "taskkill",
        ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])],
        { windowsHide: true, stdio: "ignore" }
      );
      killer.on("error", () => {
        try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* already gone */ }
      });
      killer.unref();
    } catch {
      try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* already gone */ }
    }
    return;
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") return;
    try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* already gone */ }
  }
}

function observeProcessOutput(source, filePath, onChunk, limit) {
  const capture = new BoundedByteTail(limit);
  const errors = [];
  const onData = (chunk) => {
    capture.append(chunk);
    try {
      onChunk?.(chunk.toString("utf8"));
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  };
  source.on("data", onData);
  let destination = null;
  let completion;
  if (filePath) {
    destination = createWriteStream(filePath, { flags: "w", mode: 0o600 });
    source.pipe(destination);
    completion = finished(destination).then(() => null, (error) => error);
  } else {
    completion = finished(source).then(() => null, (error) => error);
  }
  return {
    capture,
    errors,
    completion,
    stop() {
      source.removeListener("data", onData);
      if (destination) {
        source.unpipe(destination);
        destination.end();
      }
      source.destroy();
    }
  };
}

async function finishObservedOutput(observation, timeoutMs) {
  let timeout;
  const outcome = await Promise.race([
    observation.completion,
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve(new Error(`log stream did not flush within ${timeoutMs}ms`)), timeoutMs);
    })
  ]);
  clearTimeout(timeout);
  if (outcome) observation.stop();
  return [outcome, ...observation.errors].filter(Boolean);
}

async function appendProcessDiagnostic(filePath, capture, diagnostic) {
  if (!diagnostic) return;
  const suffix = `${capture.totalBytes > 0 ? "\n" : ""}${diagnostic}\n`;
  capture.append(suffix);
  if (filePath) await appendFile(filePath, suffix, "utf8");
}

export async function runProcess(command, args, options = {}) {
  const cwd = options.cwd ?? rootDir;
  const env = options.env ?? process.env;
  const captureLimit = processCaptureBytes(options.captureLimitBytes);
  const abortGraceMs = processOptionMilliseconds(
    options.abortGraceMs, DEFAULT_PROCESS_ABORT_GRACE_MS, "abortGraceMs"
  );
  const abortKillWaitMs = processOptionMilliseconds(
    options.abortKillWaitMs, DEFAULT_PROCESS_ABORT_KILL_WAIT_MS, "abortKillWaitMs"
  );
  const logFlushMs = processOptionMilliseconds(
    options.logFlushMs, DEFAULT_PROCESS_LOG_FLUSH_MS, "logFlushMs"
  );
  for (const filePath of [options.stdoutPath, options.stderrPath, options.rawPath].filter(Boolean)) {
    await mkdir(path.dirname(filePath), { recursive: true });
  }

  let stdoutObservation;
  let stderrObservation;
  const processResult = await new Promise((resolve) => {
    let settled = false;
    let child;
    let gracefulTimer;
    let hardTimer;
    let interrupted = false;
    let forced = false;
    let abortReason = null;
    const settle = (exitCode, error = null, boundedTermination = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(gracefulTimer);
      clearTimeout(hardTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, error, interrupted, forced, abortReason, boundedTermination });
    };
    const onAbort = () => {
      if (interrupted || settled) return;
      interrupted = true;
      abortReason = options.signal?.reason instanceof Error
        ? options.signal.reason.message
        : String(options.signal?.reason ?? "aborted");
      startTreeKill(child, false);
      gracefulTimer = setTimeout(() => {
        if (settled) return;
        forced = true;
        startTreeKill(child, true);
      }, abortGraceMs);
      hardTimer = setTimeout(() => {
        stdoutObservation?.stop();
        stderrObservation?.stop();
        settle(1, new Error("process tree did not exit after forced termination"), true);
      }, abortGraceMs + abortKillWaitMs);
    };
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
        windowsHide: true,
        detached: process.platform !== "win32"
      });
    } catch (error) {
      settle(1, error instanceof Error ? error : new Error(String(error)));
      return;
    }

    stdoutObservation = observeProcessOutput(
      child.stdout, options.stdoutPath, options.onStdout, captureLimit
    );
    stderrObservation = observeProcessOutput(
      child.stderr, options.stderrPath, options.onStderr, captureLimit
    );
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      settle(1, error);
    });

    child.on("close", (code) => {
      settle(interrupted ? 1 : code ?? 1);
    });
  });

  const outputErrors = (await Promise.all([
    stdoutObservation
      ? finishObservedOutput(stdoutObservation, logFlushMs)
      : Promise.resolve([]),
    stderrObservation
      ? finishObservedOutput(stderrObservation, logFlushMs)
      : Promise.resolve([])
  ])).flat();
  const stdoutCapture = stdoutObservation?.capture ?? new BoundedByteTail(captureLimit);
  const stderrCapture = stderrObservation?.capture ?? new BoundedByteTail(captureLimit);
  if (options.stdoutPath && !stdoutObservation) await writeText(options.stdoutPath, "");
  if (options.stderrPath && !stderrObservation) await writeText(options.stderrPath, "");
  const diagnostics = [];
  if (processResult.interrupted) {
    diagnostics.push(`Process interrupted: ${processResult.abortReason ?? "aborted"}`);
  }
  if (processResult.boundedTermination) {
    diagnostics.push("Process tree exceeded the termination deadline after SIGKILL/taskkill /F.");
  }
  if (processResult.error) {
    diagnostics.push(`Failed to run ${command}: ${processResult.error.message}`);
  }
  if (outputErrors.length > 0) {
    diagnostics.push(`Process log capture failed: ${outputErrors.map((error) => error.message).join("; ")}`);
  }
  await appendProcessDiagnostic(options.stderrPath, stderrCapture, diagnostics.join("\n"));
  const result = {
    command,
    args,
    cwd,
    exitCode: outputErrors.length > 0 ? 1 : processResult.exitCode,
    stdout: stdoutCapture.text(),
    stderr: stderrCapture.text(),
    stdoutBytes: stdoutCapture.totalBytes,
    stderrBytes: stderrCapture.totalBytes,
    stdoutTruncated: stdoutCapture.truncated,
    stderrTruncated: stderrCapture.truncated,
    interrupted: processResult.interrupted,
    forcedTermination: processResult.forced,
    boundedTermination: processResult.boundedTermination,
    ...(processResult.error ? { error: processResult.error } : {})
  };
  if (options.rawPath) {
    await writeText(
      options.rawPath,
      [
        `$ ${commandText(command, args)}`,
        `cwd: ${cwd}`,
        `exit_code: ${result.exitCode}`,
        `stdout_bytes: ${result.stdoutBytes}`,
        `stdout_truncated_in_memory: ${result.stdoutTruncated}`,
        `stdout_log: ${options.stdoutPath ?? "not_requested"}`,
        "stdout_tail:",
        result.stdout,
        `stderr_bytes: ${result.stderrBytes}`,
        `stderr_truncated_in_memory: ${result.stderrTruncated}`,
        `stderr_log: ${options.stderrPath ?? "not_requested"}`,
        "stderr_tail:",
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

function isCompletedStatus(value) {
  return value === "completed" || value === "completed_with_limitations";
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

  const declared = input.failureKind
    ?? input.metadata?.failure_kind
    ?? summary.failure_kind;
  if (["needs_input", "timeout", "tool_error", "api_error", "verifier_failure"].includes(declared)) {
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
  if (summaryHasFinishReason(summary, "max_wall_time") || logIndicatesMaxWallTime(logText) || logIndicatesGenericTimeout(logText)) {
    return "agent_timeout";
  }
  if (
    (isCompletedStatus(summary.status) || /agent completed/i.test(logText)) &&
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
  const taskExitCode = metadata.exit_code ?? runExitCode;
  if (isCompletedStatus(summary.status) && taskExitCode === 0) return "passed";
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
    execution_mode: null,
    agent_profile: null,
    harbor_deadline_sec: null,
    sigma_deadline_sec: null,
    completion_limitations: [],
    completion_limitation_count: 0,
    last_error: null
  };

  for (const event of events) {
    const metadata = event?.metadata ?? {};
    if (event?.type === "usage") {
      const usage = metadata.usage ?? {};
      summary.input_tokens += Number(usage.inputTokens ?? usage.input_tokens ?? 0);
      summary.output_tokens += Number(usage.outputTokens ?? usage.output_tokens ?? 0);
      summary.reasoning_tokens += Number(usage.reasoningTokens ?? usage.reasoning_tokens ?? 0);
      summary.cache_tokens += Number(usage.cacheTokens ?? usage.cache_tokens ?? 0);
      summary.cache_read_tokens += Number(usage.cacheReadTokens ?? usage.cache_read_tokens ?? 0);
      const usageCost = Number(usage.costUsd ?? usage.cost_usd);
      if (Number.isFinite(usageCost)) summary.cost_usd = (summary.cost_usd ?? 0) + usageCost;
    }
    if (event?.type === "model_end"
      && (metadata.finishReason ?? metadata.finish_reason) === "length") {
      summary.length_finish_count += 1;
    }
    if (event?.type === "diagnostic") {
      const payload = metadata.payload ?? metadata;
      if (payload.kind === "deadline.stage" && payload.stage === "converge") summary.converge_turns += 1;
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
      summary.completion_limitations = Array.isArray(result.limitations)
        ? result.limitations : summary.completion_limitations;
      summary.completion_limitation_count = Number(
        result.limitation_count ?? summary.completion_limitations.length
      );
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
        result_path: path.relative(runDir, filePath).replace(/\\/g, "/"),
        trial_dir: trialDir
      });
    }
  }
  return results.sort((a, b) => String(a.trial_name).localeCompare(String(b.trial_name)));
}

async function readHarborJobAccounting(runDir) {
  const resultFiles = await listJsonFiles(path.join(runDir, "harbor-jobs"));
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

function expectedTrialCount(config, resolvedJobConfig) {
  if (Array.isArray(resolvedJobConfig?.tasks)) return resolvedJobConfig.tasks.length;
  if (Array.isArray(resolvedJobConfig?.datasets)) {
    const count = resolvedJobConfig.datasets.reduce((sum, dataset) => {
      const value = Number(dataset?.n_tasks ?? 0);
      return sum + (Number.isInteger(value) && value > 0 ? value : 0);
    }, 0);
    if (count > 0) return count;
  }
  if (Number.isInteger(config.task_count) && config.task_count > 0) return config.task_count;
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
    execution_backend: null,
    container_engine: null,
    container_target: null,
    target_image_id: null,
    task_image_digest: null,
    agent_profile: null,
    harbor_deadline_sec: null,
    sigma_deadline_sec: null,
    completion_limitations: [],
    completion_limitation_count: 0,
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
  const agentOutcome = task.agent_outcome ?? (traceSummary.status === "completed_with_limitations"
    ? "completed_with_limitations"
    : traceSummary.status === "completed" || (!agentFailed && metadata.exit_code === 0)
      ? "completed" : agentFailed ? "failed" : "unknown");
  const reward = trialResult?.verifier_result?.rewards?.reward;
  const infrastructureEvidence = Array.isArray(trialResult?.verifier_infrastructure_evidence)
    ? trialResult.verifier_infrastructure_evidence : [];
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

function mergeHarborTrialResults(mirroredTasks, harborTrialResults) {
  const unused = new Set(mirroredTasks.map((_task, index) => index));
  const tasks = harborTrialResults.map((trialResult, index) => {
    const mirrorIndex = mirroredTasks.findIndex((task, candidateIndex) => (
      unused.has(candidateIndex) && artifactMatchesTrial(task, trialResult)
    ));
    const mirror = mirrorIndex >= 0 ? mirroredTasks[mirrorIndex] : emptyTaskForTrial(trialResult, index);
    if (mirrorIndex >= 0) unused.delete(mirrorIndex);
    return withLayeredOutcomes(
      mergeHarborTrialResult({ ...mirror, index }, trialResult),
      trialResult
    );
  });
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
  return { tasks, orphanArtifacts };
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
    execution_mode: task.execution_mode ?? traceSummary.execution_mode ?? agentMetadata.execution_mode ?? null,
    execution_backend: task.execution_backend ?? traceSummary.execution_backend
      ?? agentMetadata.execution_backend ?? agentMetadata.executionBackend ?? null,
    container_engine: task.container_engine ?? traceSummary.container_engine
      ?? agentMetadata.container_engine ?? agentMetadata.containerEngine ?? null,
    container_target: task.container_target ?? traceSummary.container_target
      ?? agentMetadata.container_target ?? agentMetadata.containerTarget ?? null,
    target_image_id: task.target_image_id ?? traceSummary.target_image_id
      ?? agentMetadata.target_image_id ?? agentMetadata.targetImageId ?? null,
    task_image_digest: task.task_image_digest ?? traceSummary.task_image_digest
      ?? agentMetadata.task_image_digest ?? agentMetadata.taskImageDigest ?? null,
    agent_profile: task.agent_profile ?? traceSummary.agent_profile ?? agentMetadata.agent_profile ?? null,
    harbor_deadline_sec: task.harbor_deadline_sec ?? traceSummary.harbor_deadline_sec
      ?? agentMetadata.harbor_deadline_sec ?? null,
    sigma_deadline_sec: task.sigma_deadline_sec ?? traceSummary.sigma_deadline_sec
      ?? agentMetadata.sigma_deadline_sec ?? null,
    completion_limitations: Array.isArray(task.completion_limitations)
      ? task.completion_limitations
      : Array.isArray(traceSummary.completion_limitations) ? traceSummary.completion_limitations : [],
    completion_limitation_count: Number(
      task.completion_limitation_count ?? traceSummary.completion_limitation_count ?? 0
    ),
    last_error: agentErrorMessage ?? task.last_error ?? traceSummary.last_error ?? null,
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
      failureKind: agentMetadata.failure_kind
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
      failureKind: agentMetadata.failure_kind
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
  if (next.status === "failed" && next.failure_category === "verifier_failed" && isCompletedStatus(traceSummary.status)) {
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
  const classifyExitCode = isCompletedStatus(summary.status) ? 0 : metadata.exit_code ?? config.exit_code;
  let failureCategory = status === "passed" ? null : classifyFailure({
    summary,
    metadata,
    failureKind: metadata.failure_kind,
    traceEvents,
    logText: combinedLogText,
    exitCode: classifyExitCode
  });

  if (status === "failed" && failureCategory === "unknown" && isCompletedStatus(summary.status)) {
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
  if (status === "failed" && ["verifier_failed", "verifier_failure"].includes(failureCategory) && isCompletedStatus(summary.status)) {
    addSignal(failureSignals, "agent_completed_but_verifier_failed");
  }

  return {
    task_id: metadata.task_id ?? metadata.task_name ?? path.basename(taskDir),
    source_logs_dir: typeof metadata.source_logs_dir === "string" ? metadata.source_logs_dir : null,
    artifact_dir: path.relative(runDir, taskDir).replace(/\\/g, "/"),
    index,
    status,
    agent_outcome: summary.status === "completed_with_limitations" ? "completed_with_limitations"
      : summary.status === "completed" ? "completed"
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
    execution_mode: summary.execution_mode ?? metadata.execution_mode ?? null,
    execution_backend: summary.execution_backend ?? metadata.execution_backend ?? null,
    container_engine: summary.container_engine ?? metadata.container_engine ?? null,
    container_target: summary.container_target ?? metadata.container_target ?? null,
    target_image_id: summary.target_image_id ?? metadata.target_image_id ?? null,
    task_image_digest: summary.task_image_digest ?? metadata.task_image_digest ?? null,
    agent_profile: summary.agent_profile ?? metadata.agent_profile ?? null,
    harbor_deadline_sec: summary.harbor_deadline_sec ?? metadata.harbor_deadline_sec ?? null,
    sigma_deadline_sec: summary.sigma_deadline_sec ?? metadata.sigma_deadline_sec ?? null,
    completion_limitations: Array.isArray(summary.limitations)
      ? summary.limitations
      : Array.isArray(summary.completion_limitations) ? summary.completion_limitations : [],
    completion_limitation_count: Number(
      summary.limitation_count ?? summary.completion_limitation_count ?? 0
    ),
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
    execution_backend: null,
    container_engine: null,
    container_target: null,
    target_image_id: null,
    task_image_digest: null,
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

function reportIdentityValue(report, key) {
  const direct = report?.[key];
  if (direct !== undefined && direct !== null && direct !== "") return direct;
  const values = [...new Set((Array.isArray(report?.tasks) ? report.tasks : [])
    .map((task) => task?.[key]).filter((value) => value !== undefined && value !== null && value !== ""))];
  return values.length === 1 ? values[0] : null;
}

function assertUniformReportIdentity(reports, key, label) {
  const values = [...new Set(reports.map((report) => reportIdentityValue(report, key))
    .filter((value) => value !== null))];
  if (values.length > 1) {
    throw Object.assign(new Error(
      `Benchmark reports use different ${label} (${values.join(", ")}) and cannot be combined.`
    ), { code: `benchmark_${key}_mismatch` });
  }
}

/** Aggregation consumers must never mix product bytes, execution backends, or
 * solving/conformance lanes. Paired A/B comparison deliberately uses a
 * separate path because its two subjects are expected to differ. */
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
  for (const [key, label] of [
    ["dataset", "datasets"],
    ["provider", "providers"],
    ["model", "models"],
    ["agent_cli_sha256", "agent CLI archives"],
    ["source_revision", "source revisions"],
    ["source_dirty", "source dirty states"],
    ["execution_mode", "execution modes"],
    ["harbor_topology", "Harbor topologies"],
    ["execution_backend", "execution backends"],
    ["container_engine", "container engines"],
    ["container_target", "container target modes"]
  ]) assertUniformReportIdentity(reports, key, label);
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
    `- Source revision: ${report.source_revision ?? "unknown"}${report.source_dirty === true ? " (dirty)" : ""}`,
    `- Source identity authority: ${report.source_identity_source ?? "unknown"}`,
    `- Harness revision: ${report.harness_source_revision ?? "unknown"}${report.harness_source_dirty === true ? " (dirty)" : ""}`,
    `- Agent CLI SHA-256: ${report.agent_cli_sha256 ?? "unknown"}`,
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
    `- Network mode: ${report.network_mode ?? "unknown"}`,
    `- Max turns / command timeout: ${report.max_turns ?? "unknown"} / ${report.command_timeout_sec ?? "unknown"}s`,
    `- Execution mode/backend: ${report.execution_mode ?? "unknown"}/${report.execution_backend ?? "unknown"}`,
    `- Harbor topology / managed provenance: ${report.harbor_topology ?? "unknown"}/${report.managed_provenance === true}`,
    `- Container engine/target: ${report.container_engine ?? "n/a"}/${report.container_target ?? "n/a"}`,
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
    `- Completed with limitations: ${report.completion_limitations?.tasks ?? 0} tasks / ${report.completion_limitations?.total ?? 0} limitations`,
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
    "| passed | failed | infra_failed | timeout | api_error | needs_input | tool_error | verifier_failure | unknown |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${report.counts.passed} | ${report.counts.failed} | ${report.counts.infra_failed} | ${report.counts.timeout} | ${report.counts.api_error} | ${report.counts.needs_input} | ${report.counts.tool_error} | ${report.counts.verifier_failure} | ${report.counts.unknown} |`,
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
  if (missingLogFiles.length > 0) {
    incompleteReason.push(`missing expected log files: ${missingLogFiles.join(", ")}`);
  }
  if (!/^[a-f0-9]{64}$/u.test(String(config.agent_cli_sha256 ?? ""))) {
    incompleteReason.push("config.json does not contain a valid agent_cli_sha256.");
  }
  if (!/^[a-f0-9]{40}$/u.test(String(config.source_revision ?? ""))) {
    incompleteReason.push("config.json does not contain a valid source_revision.");
  }
  const globalLogText = [
    await readTextSafe(path.join(runDir, "harbor.stdout.log")),
    await readTextSafe(path.join(runDir, "harbor.stderr.log")),
    await readTextSafe(path.join(runDir, "result.raw.log"))
  ].join("\n");
  const taskDirs = await listTaskDirs(runDir);
  const mirroredTasks = taskDirs.length > 0
    ? await Promise.all(taskDirs.map((taskDir, index) => taskReportFromDir(runDir, taskDir, index, config, globalLogText)))
    : [syntheticRunTask(config, globalLogText)];
  const harborTrialResults = await readHarborTrialResults(runDir);
  const harborJobAccounting = await readHarborJobAccounting(runDir);
  const resolvedJobConfig = await resolvedJobConfigForReport(runDir, config);
  const expected = expectedTrialCount(config, resolvedJobConfig);
  const accounting = trialAccounting(expected, harborTrialResults);
  if (expected > 0) {
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
    if (accounting.observed === expected && config.docker_cleanup?.clean !== true) {
      incompleteReason.push("Run-scoped container cleanup is missing or did not complete cleanly.");
    }
  }
  let tasks = mirroredTasks;
  let orphanArtifacts = [];
  if (harborTrialResults.length > 0) {
    const merged = mergeHarborTrialResults(mirroredTasks, harborTrialResults);
    tasks = merged.tasks;
    orphanArtifacts = merged.orphanArtifacts;
  }
  tasks = tasks.map((task) => {
    const verifierOutcome = task.verifier_outcome ?? (task.verifier_status ?? "not_run");
    return withSuggestedOwner({
      ...task,
      agent_outcome: task.agent_outcome ?? (task.status === "passed" ? "completed" : "unknown"),
      verifier_outcome: verifierOutcome,
      validity: task.validity ?? "valid",
      verifier_infrastructure_evidence: task.verifier_infrastructure_evidence ?? [],
      verifier_reached: verifierOutcome === "passed" || verifierOutcome === "failed",
      agent_profile: task.agent_profile ?? config.agent_profile ?? null,
      ...deadlineFieldsForTask(task, config)
    });
  });
  const taskProfiles = [...new Set(tasks.map((task) => task.agent_profile).filter(Boolean))];
  if (taskProfiles.length > 1) {
    incompleteReason.push(`Benchmark report contains mixed agent profiles: ${taskProfiles.join(", ")}.`);
  }
  const runtimeIdentity = {};
  for (const key of [
    "execution_backend", "container_engine", "container_target"
  ]) {
    const values = [...new Set(tasks.map((task) => task[key]).filter(Boolean))];
    runtimeIdentity[key] = values.length === 1 ? values[0] : null;
    if (values.length > 1) {
      incompleteReason.push(`Benchmark report contains mixed ${key}: ${values.join(", ")}.`);
    }
    const missingTasks = tasks.filter((task) => !task[key]).map((task) => task.task_id ?? "unknown");
    if (key === "execution_backend" && missingTasks.length > 0) {
      incompleteReason.push(`Benchmark tasks lack execution_backend: ${missingTasks.join(", ")}.`);
    }
  }
  const targetImageIds = [...new Set(tasks.map((task) => task.target_image_id).filter(Boolean))].sort();
  const taskImageDigests = [...new Set(tasks.map((task) => task.task_image_digest).filter(Boolean))].sort();
  if (config.execution_mode === "container") {
    for (const task of tasks) {
      const missing = ["execution_backend", "container_engine", "container_target"]
        .filter((key) => !task[key]);
      if (!task.task_image_digest && !task.target_image_id) missing.push("task_image_digest_or_target_image_id");
      if (typeof task.execution_backend === "string" && !task.execution_backend.startsWith("oci:")) {
        incompleteReason.push(`Container task ${task.task_id ?? "unknown"} did not use an OCI backend.`);
      }
      if (missing.length > 0) {
        incompleteReason.push(
          `Container task ${task.task_id ?? "unknown"} lacks runtime identity: ${missing.join(", ")}.`
        );
      }
    }
  }
  if (config.managed_provenance === true) {
    for (const task of tasks) {
      const missing = ["container_engine", "container_target"].filter((key) => !task[key]);
      if (!task.task_image_digest && !task.target_image_id) {
        missing.push("task_image_digest_or_target_image_id");
      }
      if (task.container_target && task.container_target !== "managed") {
        incompleteReason.push(
          `Managed-provenance task ${task.task_id ?? "unknown"} did not attest a managed target.`
        );
      }
      if (missing.length > 0) {
        incompleteReason.push(
          `Managed-provenance task ${task.task_id ?? "unknown"} lacks target identity: ${missing.join(", ")}.`
        );
      }
    }
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
    + counts.needs_input + counts.tool_error + counts.verifier_failure + counts.unknown;
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
  const limitedTasks = tasks.filter((task) => task.agent_outcome === "completed_with_limitations");
  const completionLimitations = {
    tasks: limitedTasks.length,
    total: limitedTasks.reduce((total, task) => total + Number(task.completion_limitation_count ?? 0), 0)
  };
  const report = {
    run_id: config.run_id ?? path.basename(runDir),
    started_at: config.started_at ?? null,
    finished_at: config.finished_at ?? null,
    provider: config.provider ?? "unknown",
    model: config.model ?? null,
    model_parameters: config.model_parameters ?? null,
    dataset: config.dataset ?? terminalBenchDataset,
    terminal_bench_revision: config.terminal_bench_revision ?? null,
    source_revision: config.source_revision ?? null,
    source_dirty: typeof config.source_dirty === "boolean" ? config.source_dirty : null,
    source_identity_source: config.source_identity_source ?? null,
    harness_source_revision: config.harness_source_revision ?? null,
    harness_source_dirty: typeof config.harness_source_dirty === "boolean" ? config.harness_source_dirty : null,
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
    agent_cli_sha256: config.agent_cli_sha256 ?? null,
    package_reused: config.package_reused ?? false,
    n_concurrent_trials: resolvedJobConfig?.n_concurrent_trials ?? config.n_concurrent_trials ?? null,
    network_mode: config.network_mode ?? null,
    max_turns: config.max_turns ?? null,
    command_timeout_sec: config.command_timeout_sec ?? null,
    benchmark_class: config.benchmark_class ?? null,
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
    completion_limitations: completionLimitations,
    cost_usd: costUsd,
    incomplete_reason: incompleteReason.length > 0 ? incompleteReason : null,
    exit_code: exitCode,
    harbor_exit_code: Number(config.harbor_exit_code ?? exitCode),
    score_status: scoreStatus,
    infra_status: infraStatus,
    execution_mode: config.execution_mode ?? "sandboxed",
    managed_provenance: config.managed_provenance === true,
    harbor_topology: config.harbor_topology
      ?? (config.execution_mode === "container" || config.managed_provenance === true
        ? "managed_three_role" : "main_only"),
    execution_backend: runtimeIdentity.execution_backend,
    container_engine: runtimeIdentity.container_engine,
    container_target: runtimeIdentity.container_target,
    target_image_ids: targetImageIds,
    task_image_digests: taskImageDigests,
    container_engine_requested: config.container_engine_requested ?? null,
    docker_cleanup: config.docker_cleanup ?? null,
    preregistration_sha256: config.preregistration_sha256 ?? null,
    validation_manifest: config.validation_manifest ?? null,
    validation_manifest_sha256: config.validation_manifest_sha256 ?? null,
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
