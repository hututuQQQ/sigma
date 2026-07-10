#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(rootDir, "packages", "agent-cli", "dist", "index.js");
const cliRunEntry = path.join(rootDir, "packages", "agent-cli", "dist", "commands", "run.js");
const cliDoctorEntry = path.join(rootDir, "packages", "agent-cli", "dist", "commands", "doctor.js");
const cliSessionEntry = path.join(rootDir, "packages", "agent-cli", "dist", "commands", "session.js");
const artifactsDir = path.join(rootDir, ".artifacts", "smoke-provider");
const workspace = path.join(artifactsDir, "workspace");
const reportPath = path.join(artifactsDir, "provider-smoke.json");

class MemoryWritable extends Writable {
  constructor() {
    super();
    this.chunks = [];
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    callback();
  }

  text() {
    return this.chunks.join("");
  }
}

function parseArgs(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") flags.set("help", true);
    else if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        flags.set(name, next);
        index += 1;
      } else {
        flags.set(name, true);
      }
    }
  }
  return flags;
}

function providerValue(value) {
  if (value === undefined || value === true) return process.env.AGENT_PROVIDER || "deepseek";
  if (value === "deepseek" || value === "glm") return value;
  throw new Error("--provider must be deepseek or glm.");
}

function missingProviderKey(provider) {
  if (provider === "deepseek") return !process.env.DEEPSEEK_API_KEY;
  return !(process.env.ZAI_API_KEY || process.env.GLM_API_KEY || process.env.BIGMODEL_API_KEY);
}

function bool(value) {
  return value === true || value === "1" || value === "true";
}

function assertBuiltCli() {
  const missing = [cliEntry, cliRunEntry, cliDoctorEntry, cliSessionEntry].filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new Error(`Built CLI is missing. Run pnpm build first.\nMissing:\n${missing.join("\n")}`);
  }
}

function printHelp() {
  process.stdout.write(`pnpm smoke:provider -- [flags]

Runs an optional live-provider Sigma Code smoke. This is not part of the default
product gate because it requires a real API key and network access.

Flags:
  --provider <deepseek|glm>   Provider to test (default: AGENT_PROVIDER or deepseek)
  --model <name>              Provider model override
  --allow-skip                Write a skipped report instead of failing when the provider key is absent

Environment:
  DEEPSEEK_API_KEY            Required for --provider deepseek
  ZAI_API_KEY / GLM_API_KEY / BIGMODEL_API_KEY required for --provider glm
  AGENT_ALLOW_PROVIDER_SMOKE_SKIP=1 same as --allow-skip
`);
}

async function captureProcessWrites(fn) {
  const stdout = new MemoryWritable();
  const stderr = new MemoryWritable();
  const code = await fn(stdout, stderr);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

async function writeReport(report) {
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  if (flags.has("help")) {
    printHelp();
    return 0;
  }

  assertBuiltCli();
  const provider = providerValue(flags.get("provider"));
  const model = typeof flags.get("model") === "string" ? flags.get("model") : process.env.AGENT_MODEL || undefined;
  const allowSkip = bool(flags.get("allow-skip")) || bool(process.env.AGENT_ALLOW_PROVIDER_SMOKE_SKIP);
  const startedAt = new Date().toISOString();

  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "# Provider smoke workspace\n", "utf8");

  if (missingProviderKey(provider)) {
    const report = {
      ok: false,
      status: "skipped",
      reason: `missing provider key for ${provider}`,
      provider,
      model: model ?? null,
      startedAt,
      finishedAt: new Date().toISOString()
    };
    await writeReport(report);
    if (allowSkip) {
      process.stdout.write(`SKIP provider smoke ${report.reason}\n`);
      return 0;
    }
    throw new Error(`${report.reason}. Pass --allow-skip to write a skipped report without failing.`);
  }

  const { runDoctorCommand } = await import(`file://${cliDoctorEntry.replace(/\\/g, "/")}`);
  const { runCommand } = await import(`file://${cliRunEntry.replace(/\\/g, "/")}`);
  const { runSessionCommand } = await import(`file://${cliSessionEntry.replace(/\\/g, "/")}`);

  const doctor = await captureProcessWrites(async (stdout, stderr) => await runDoctorCommand([
    "--workspace",
    workspace,
    "--provider",
    provider,
    ...(model ? ["--model", model] : []),
    "--check-api",
    "--json"
  ], { stdout, stderr }));
  let doctorReport = null;
  try {
    doctorReport = JSON.parse(doctor.stdout);
  } catch {
    // Keep raw stdout/stderr in the report below.
  }
  const doctorApi = doctorReport?.checks?.find((item) => item.name === "api");
  if (doctor.code !== 0 || doctorApi?.status !== "ok") {
    const report = {
      ok: false,
      status: "failed",
      reason: "provider doctor --check-api failed",
      provider,
      model: model ?? null,
      startedAt,
      finishedAt: new Date().toISOString(),
      doctor: doctorReport ?? { stdout: doctor.stdout, stderr: doctor.stderr, code: doctor.code }
    };
    await writeReport(report);
    throw new Error(`provider doctor --check-api failed for ${provider}. See ${reportPath}`);
  }

  const instruction = [
    "Create a file named provider-smoke.md in the workspace.",
    "The file must contain exactly these two lines:",
    "sigma provider smoke",
    "ready"
  ].join("\n");
  const run = await captureProcessWrites(async (stdout, stderr) => await runCommand([
    instruction,
    "--workspace",
    workspace,
    "--provider",
    provider,
    ...(model ? ["--model", model] : []),
    "--permission-mode",
    "auto",
    "--run-deadline-sec",
    "420",
    "--output-format",
    "json"
  ], { stdout, stderr }));

  let runResult = null;
  try {
    runResult = JSON.parse(run.stdout);
  } catch {
    // Keep raw output in failure report.
  }
  const filePath = path.join(workspace, "provider-smoke.md");
  const fileText = existsSync(filePath) ? await readFile(filePath, "utf8") : "";
  const fileOk = fileText.trim() === "sigma provider smoke\nready";
  const runOk = run.code === 0 && runResult?.status === "completed" && fileOk;

  const inspect = await captureProcessWrites(async (stdout, stderr) => await runSessionCommand([
    "show",
    "--latest",
    "--workspace",
    workspace,
    "--json"
  ], { stdout, stderr }));
  const inspection = inspect.code === 0 ? JSON.parse(inspect.stdout) : null;

  const report = {
    ok: runOk,
    status: runOk ? "passed" : "failed",
    provider,
    model: model ?? runResult?.model ?? null,
    startedAt,
    finishedAt: new Date().toISOString(),
    workspace,
    doctorStatus: doctorReport?.status ?? null,
    apiCheck: doctorApi ?? null,
    run: runResult ?? { code: run.code, stdout: run.stdout, stderr: run.stderr },
    sessionId: inspection?.summary?.sessionId ?? runResult?.sessionId ?? null,
    changedFiles: [],
    artifacts: null,
    checks: {
      doctorApi: doctorApi?.status === "ok",
      runCompleted: runResult?.status === "completed",
      fileCreated: existsSync(filePath),
      fileContent: fileOk,
      inspect: inspect.code === 0 && Boolean(inspection?.summary?.sessionId)
    }
  };
  await writeReport(report);
  if (!runOk) {
    throw new Error(`provider smoke failed for ${provider}. See ${reportPath}`);
  }
  process.stdout.write(`PASS provider smoke provider=${provider} session=${report.sessionId ?? "unknown"}\n`);
  return 0;
}

await main().then((code) => {
  process.exitCode = code;
}).catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
