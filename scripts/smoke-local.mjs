#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tasksDir = path.join(rootDir, "test-fixtures", "smoke-tasks");
const artifactsRoot = path.join(rootDir, ".artifacts", "smoke-local");
const taskNames = ["create-file", "edit-file", "fix-test", "inspect-and-summarize"];

function loadDotEnv(filePath) {
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
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv(path.join(rootDir, ".env"));

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function selectedProvider() {
  return argValue("--provider") ?? process.env.AGENT_PROVIDER ?? "deepseek";
}

function bashExecutable() {
  if (process.env.AGENT_BASH_PATH) return process.env.AGENT_BASH_PATH;
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      "C:\\msys64\\usr\\bin\\bash.exe"
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found) return found;
  }
  return "bash";
}

async function runProcess(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  if (options.input) {
    child.stdin.end(options.input);
  } else {
    child.stdin.end();
  }

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  const log = [
    `$ ${[command, ...args].join(" ")}`,
    `cwd: ${options.cwd}`,
    `exitCode: ${exitCode}`,
    "stdout:",
    stdout,
    "stderr:",
    stderr
  ].join("\n");
  await writeFile(options.logPath, log, "utf8");

  return { exitCode, stdout, stderr };
}

async function runShellScript(scriptPath, cwd, logPath) {
  const script = await readFile(scriptPath, "utf8");
  return await runProcess(bashExecutable(), ["-s"], { cwd, input: script, logPath });
}

async function runRealAgent(taskName, taskDir, workspace, artifactDir) {
  const cliEntry = path.join(rootDir, "packages", "agent-cli", "dist", "index.js");
  if (!existsSync(cliEntry)) {
    throw new Error("Built CLI is missing. Run pnpm build before scripts/smoke-local.mjs.");
  }

  const provider = selectedProvider();
  const args = [
    cliEntry,
    "run",
    "--workspace",
    workspace,
    "--prompt-file",
    path.join(taskDir, "instruction.md"),
    "--provider",
    provider,
    "--run-deadline-sec",
    "300",
    "--permission-mode",
    "auto",
    "--output-format",
    "json"
  ];
  if (process.env.AGENT_MODEL) {
    args.splice(8, 0, "--model", process.env.AGENT_MODEL);
  }

  return await runProcess(process.execPath, args, {
    cwd: rootDir,
    logPath: path.join(artifactDir, "agent.log")
  });
}

async function runTask(taskName) {
  const taskDir = path.join(tasksDir, taskName);
  const artifactDir = path.join(artifactsRoot, taskName);
  const workspace = path.join(artifactDir, "workspace");
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });

  const seedPath = path.join(taskDir, "seed.sh");
  if (existsSync(seedPath)) {
    const seed = await runShellScript(seedPath, workspace, path.join(artifactDir, "seed.log"));
    if (seed.exitCode !== 0) {
      return { taskName, ok: false, reason: "seed failed" };
    }
  }

  const agent = await runRealAgent(taskName, taskDir, workspace, artifactDir);
  if (agent.exitCode !== 0) {
    return { taskName, ok: false, reason: "agent failed" };
  }

  const verify = await runShellScript(path.join(taskDir, "verify.sh"), workspace, path.join(artifactDir, "verify.log"));
  if (verify.exitCode !== 0) {
    return { taskName, ok: false, reason: "verify failed" };
  }

  return { taskName, ok: true, reason: "passed" };
}

async function main() {
  const provider = selectedProvider();
  await mkdir(artifactsRoot, { recursive: true });
  const results = [];

  for (const taskName of taskNames) {
    const result = await runTask(taskName);
    results.push(result);
    process.stdout.write(`${result.ok ? "PASS" : "FAIL"} ${taskName}`);
    if (!result.ok) process.stdout.write(` (${result.reason})`);
    process.stdout.write("\n");
  }

  const ok = results.every((result) => result.ok);
  await writeFile(path.join(artifactsRoot, "summary.json"), `${JSON.stringify({ provider, results }, null, 2)}\n`, "utf8");
  process.exitCode = ok ? 0 : 1;
}

await main();
