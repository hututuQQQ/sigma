import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "./common.mjs";
import { STORE_LAYOUT_VERSION } from "./event-store.mjs";
import { subjectNodeLaunch } from "./subject-launch.mjs";
import { sigmaManifest } from "../lib/sigma-manifest.mjs";

const driverPath = fileURLToPath(new URL("./tui-driver.py", import.meta.url));
const SUBJECT_ENVIRONMENT_BRIDGE = "SIGMA_TUI_SUBJECT_ENVIRONMENT_B64";

function capture(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolve({ exitCode: exitCode ?? 1, signal, stdout, stderr }));
  });
}

function stringEnvironment(value) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, item]) => typeof item === "string"));
}

function environmentValue(environment, requested) {
  const normalized = requested.toUpperCase();
  const key = Object.keys(environment).find((candidate) => candidate.toUpperCase() === normalized);
  return key === undefined ? undefined : environment[key];
}

function setEnvironmentValue(environment, requested, value) {
  const normalized = requested.toUpperCase();
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === normalized) delete environment[key];
  }
  environment[requested] = value;
}

async function regularExecutable(candidate) {
  try {
    const direct = await lstat(candidate);
    if (!direct.isFile() && !direct.isSymbolicLink()) return undefined;
    const canonical = await realpath(candidate);
    const installed = await lstat(canonical);
    return installed.isFile() && !installed.isSymbolicLink() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the controller interpreter exclusively from the evaluator host
 * environment. Subject PATH and package metadata never participate. */
export async function resolveTuiControllerPython(hostEnvironment = process.env, platform = process.platform) {
  const host = stringEnvironment(hostEnvironment);
  const configured = environmentValue(host, "PYTHON_BIN");
  const names = configured ? [configured] : [platform === "win32" ? "python.exe" : "python3"];
  const hostPath = environmentValue(host, "PATH") ?? "";
  for (const name of names) {
    const candidates = path.isAbsolute(name)
      ? [name]
      : hostPath.split(path.delimiter).filter(Boolean).map((directory) => path.resolve(directory, name));
    for (const candidate of candidates) {
      const executable = await regularExecutable(candidate);
      if (executable) return executable;
    }
  }
  throw new Error("A regular host Python executable could not be resolved for the TUI controller.");
}

/** Run the trusted controller with the host environment while transporting the
 * separately sanitized subject environment in one opaque bridge value. */
export function tuiControllerEnvironment(subjectEnvironment, stateHome, hostEnvironment = process.env) {
  const subject = stringEnvironment(subjectEnvironment);
  if (environmentValue(subject, SUBJECT_ENVIRONMENT_BRIDGE) !== undefined) {
    throw new Error("Subject environment contains a reserved TUI controller key.");
  }
  setEnvironmentValue(subject, "SIGMA_STATE_HOME", stateHome);
  const controller = stringEnvironment(hostEnvironment);
  setEnvironmentValue(controller, "PYTHONUTF8", "1");
  setEnvironmentValue(
    controller,
    SUBJECT_ENVIRONMENT_BRIDGE,
    Buffer.from(JSON.stringify(subject), "utf8").toString("base64")
  );
  const secret = environmentValue(subject, "DEEPSEEK_API_KEY");
  if (secret !== undefined) setEnvironmentValue(controller, "DEEPSEEK_API_KEY", secret);
  return controller;
}

export function tuiSubjectCommand(subject, args) {
  const launch = subjectNodeLaunch(subject);
  return [
    launch.executablePath,
    "--experimental-ffi",
    "--disable-warning=ExperimentalWarning",
    launch.entryPath,
    ...args
  ];
}

function tuiRunResult(result, summary, startedAt) {
  const settledStatus = {
    "run.completed": "completed",
    "run.suspended": "needs_input",
    "run.cancelled": "cancelled",
    "run.failed": "error"
  }[summary?.settledTerminalType];
  const controllerInfrastructureError = summary?.infrastructureError;
  return {
    ...result,
    ...(summary ?? {}),
    infrastructureError: Boolean(controllerInfrastructureError),
    ...(controllerInfrastructureError ? { controllerInfrastructureError } : {}),
    durationMs: summary?.durationMs ?? Date.now() - startedAt,
    cancellation: summary?.cancellation,
    result: settledStatus ? { status: settledStatus, finishReason: summary.settledTerminalType } : undefined,
    events: []
  };
}

export async function runTuiSubject(options) {
  const {
    workspace, stateHome, initialMessage, interactions, permissionPolicy, budget,
    artifactDir, controllerDir = artifactDir, env, redactor, subject, eventStreamTimeoutMs = 10_000
  } = options;
  await Promise.all([mkdir(artifactDir, { recursive: true }), mkdir(controllerDir, { recursive: true })]);
  const transcriptPath = path.join(controllerDir, "terminal.transcript.log");
  const configPath = path.join(controllerDir, "terminal.config.json");
  const runtimeDriverPath = path.join(controllerDir, "terminal-driver.py");
  await copyFile(driverPath, runtimeDriverPath);
  const config = {
    schemaVersion: 1,
    command: tuiSubjectCommand(subject, [
      "tui",
      "--workspace", workspace,
      "--provider", "deepseek",
      "--model", sigmaManifest.evaluation.model,
      "--permission-mode", permissionPolicy === "auto" ? "auto" : "ask"
    ]),
    workspace,
    stateHome,
    transcriptPath,
    initialMessage,
    permissionPolicy,
    interactions,
    storeLayoutVersion: STORE_LAYOUT_VERSION,
    eventStreamTimeoutMs,
    budget
  };
  await writeJson(configPath, config, redactor);
  const startedAt = Date.now();
  const controllerEnvironment = tuiControllerEnvironment(env, stateHome);
  const controllerPython = await resolveTuiControllerPython(process.env, process.platform);
  const result = await capture(controllerPython, [runtimeDriverPath, configPath], {
    cwd: workspace,
    env: controllerEnvironment
  });
  await writeFile(path.join(artifactDir, "tui-driver.stdout.log"), redactor(result.stdout), "utf8");
  await writeFile(path.join(artifactDir, "tui-driver.stderr.log"), redactor(result.stderr), "utf8");
  const transcript = await readFile(transcriptPath, "utf8").catch(() => "");
  await writeFile(path.join(artifactDir, "tui.transcript.log"), redactor(transcript), "utf8");
  let summary;
  for (const line of result.stdout.trim().split(/\r?\n/u).reverse()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object") { summary = value; break; }
    } catch {
      // Keep looking for the final JSON result.
    }
  }
  return tuiRunResult(result, summary, startedAt);
}
