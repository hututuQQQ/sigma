import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cliEntry, writeJson } from "./common.mjs";

const driverPath = fileURLToPath(new URL("./tui-driver.py", import.meta.url));

function capture(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
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

function pythonCommand() {
  return process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
}

export async function runTuiSubject(options) {
  const {
    workspace, stateHome, initialMessage, interactions, permissionPolicy, budget,
    artifactDir, controllerDir = artifactDir, env, redactor, subject = {}
  } = options;
  await Promise.all([mkdir(artifactDir, { recursive: true }), mkdir(controllerDir, { recursive: true })]);
  const transcriptPath = path.join(controllerDir, "terminal.transcript.log");
  const configPath = path.join(controllerDir, "terminal.config.json");
  const runtimeDriverPath = path.join(controllerDir, "terminal-driver.py");
  await copyFile(driverPath, runtimeDriverPath);
  const nodePath = subject.nodePath ?? process.execPath;
  const entryPath = subject.cliEntry ?? cliEntry;
  const config = {
    schemaVersion: 1,
    command: [
      nodePath,
      "--experimental-ffi",
      "--disable-warning=ExperimentalWarning",
      entryPath,
      "tui",
      "--workspace", workspace,
      "--provider", "deepseek",
      "--model", "deepseek-v4-pro",
      "--permission-mode", permissionPolicy === "auto" ? "auto" : "ask"
    ],
    workspace,
    stateHome,
    transcriptPath,
    initialMessage,
    permissionPolicy,
    interactions,
    budget
  };
  await writeJson(configPath, config, redactor);
  const startedAt = Date.now();
  const result = await capture(pythonCommand(), [runtimeDriverPath, configPath], {
    cwd: workspace,
    env: { ...env, SIGMA_STATE_HOME: stateHome, PYTHONUTF8: "1" }
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
  const settledStatus = {
    "run.completed": "completed",
    "run.suspended": "needs_input",
    "run.cancelled": "cancelled",
    "run.failed": "error"
  }[summary?.settledTerminalType];
  return {
    ...result,
    ...(summary ?? {}),
    durationMs: summary?.durationMs ?? Date.now() - startedAt,
    cancellation: summary?.cancellation,
    result: settledStatus ? { status: settledStatus, finishReason: summary.settledTerminalType } : undefined,
    events: []
  };
}
