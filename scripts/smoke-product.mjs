#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { SmokeFakeModel } from "./smoke-fake-model.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(rootDir, "packages", "agent-cli", "dist", "index.js");
const cliRunEntry = path.join(rootDir, "packages", "agent-cli", "dist", "commands", "run.js");
const cliInitEntry = path.join(rootDir, "packages", "agent-cli", "dist", "commands", "init.js");
const cliDoctorEntry = path.join(rootDir, "packages", "agent-cli", "dist", "commands", "doctor.js");
const artifactsDir = path.join(rootDir, ".artifacts", "smoke-product");
const workspace = path.join(artifactsDir, "workspace");

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

function assertBuiltCli() {
  const missing = [cliEntry, cliRunEntry, cliInitEntry, cliDoctorEntry].filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new Error(`Built CLI is missing. Run pnpm build first.\nMissing:\n${missing.join("\n")}`);
  }
}

async function captureProcessWrites(fn) {
  const stdout = new MemoryWritable();
  const stderr = new MemoryWritable();
  const previousStdout = process.stdout.write;
  const previousStderr = process.stderr.write;
  try {
    process.stdout.write = stdout.write.bind(stdout);
    process.stderr.write = stderr.write.bind(stderr);
    const code = await fn();
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  } finally {
    process.stdout.write = previousStdout;
    process.stderr.write = previousStderr;
  }
}

function assertOk(step, result) {
  if (result.code !== 0) {
    throw new Error([
      `${step} failed with exit code ${result.code}`,
      "stdout:",
      result.stdout,
      "stderr:",
      result.stderr
    ].join("\n"));
  }
}

async function main() {
  assertBuiltCli();
  const { runInitCommand } = await import(`file://${cliInitEntry.replace(/\\/g, "/")}`);
  const { runDoctorCommand } = await import(`file://${cliDoctorEntry.replace(/\\/g, "/")}`);
  const { runRunCommand } = await import(`file://${cliRunEntry.replace(/\\/g, "/")}`);
  const { runAgentCommand } = await import(`file://${cliEntry.replace(/\\/g, "/")}`);

  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });

  const version = await captureProcessWrites(async () => await runAgentCommand(["version", "--json"]));
  assertOk("version", version);
  const versionReport = JSON.parse(version.stdout);
  if (versionReport?.product !== "Sigma Code" || versionReport?.package?.name !== "agent-cli") {
    throw new Error(`version JSON missing product/package metadata\n${version.stdout}`);
  }

  const initStdout = new MemoryWritable();
  const initStderr = new MemoryWritable();
  const initCode = await runInitCommand([
    "--workspace",
    workspace,
    "--profile",
    "local",
    "--provider",
    "deepseek",
    "--validation-mode",
    "auto"
  ], { stdout: initStdout, stderr: initStderr });
  assertOk("init", { code: initCode, stdout: initStdout.text(), stderr: initStderr.text() });

  const doctor = await captureProcessWrites(async () => await runDoctorCommand(["--workspace", workspace, "--json"]));
  assertOk("doctor", doctor);
  const doctorReport = JSON.parse(doctor.stdout);
  if (!["ok", "warning"].includes(doctorReport?.status) || doctorReport?.provider !== "deepseek" || doctorReport?.workspace?.path !== workspace) {
    throw new Error(`doctor JSON did not include expected readiness/provider/workspace\n${doctor.stdout}`);
  }
  if (!Array.isArray(doctorReport.checks) || !doctorReport.checks.some((check) => check.name === "workspace" && check.status === "ok")) {
    throw new Error(`doctor JSON missing workspace readiness check\n${doctor.stdout}`);
  }

  const runStdout = new MemoryWritable();
  const runStderr = new MemoryWritable();
  const runCode = await runRunCommand([
    "Create a hello.txt file with a friendly message.",
    "--workspace",
    workspace,
    "--provider",
    "deepseek",
    "--permission-mode",
    "yolo",
    "--trace-jsonl",
    path.join(artifactsDir, "trace.jsonl"),
    "--summary-json",
    path.join(artifactsDir, "summary.json"),
    "--session-jsonl",
    path.join(artifactsDir, "session.jsonl"),
    "--no-stream-ui"
  ], {
    stdout: runStdout,
    stderr: runStderr,
    modelClientFactory: () => new SmokeFakeModel("create-file")
  });
  assertOk("run", { code: runCode, stdout: runStdout.text(), stderr: runStderr.text() });

  const hello = await readFile(path.join(workspace, "hello.txt"), "utf8");
  if (!hello.includes("hello world")) {
    throw new Error(`run did not produce hello.txt with expected content: ${hello}`);
  }

  const inspect = await captureProcessWrites(async () => await runAgentCommand(["inspect", "--workspace", workspace, "--json"]));
  assertOk("inspect", inspect);
  const inspection = JSON.parse(inspect.stdout);
  if (!inspection?.meta?.sessionId) throw new Error(`inspect JSON missing session metadata\n${inspect.stdout}`);
  if (!inspection?.artifacts?.summary || !inspection?.artifacts?.events) {
    throw new Error(`inspect JSON missing artifact paths\n${inspect.stdout}`);
  }
  if (!inspection?.artifacts?.manifest || inspection?.artifactManifest?.schemaVersion !== 1) {
    throw new Error(`inspect JSON missing artifact manifest\n${inspect.stdout}`);
  }
  if (!Array.isArray(inspection.changedFiles) || !inspection.changedFiles.includes("hello.txt")) {
    throw new Error(`inspect JSON missing changed file hello.txt\n${inspect.stdout}`);
  }

  const jobs = await captureProcessWrites(async () => await runAgentCommand(["jobs", "--workspace", workspace, "--json"]));
  assertOk("jobs", jobs);
  const jobsPayload = JSON.parse(jobs.stdout);
  if (jobsPayload?.summary?.total < 1 || jobsPayload?.summary?.completed < 1) {
    throw new Error(`jobs JSON missing completed job summary\n${jobs.stdout}`);
  }
  if (!Array.isArray(jobsPayload.jobs) || jobsPayload.jobs[0]?.sessionId !== inspection.meta.sessionId) {
    throw new Error(`jobs JSON missing latest session\n${jobs.stdout}`);
  }

  const artifacts = await captureProcessWrites(async () => await runAgentCommand(["artifacts", "--workspace", workspace, "--json"]));
  assertOk("artifacts", artifacts);
  const artifactsPayload = JSON.parse(artifacts.stdout);
  if (artifactsPayload?.meta?.sessionId !== inspection.meta.sessionId) {
    throw new Error(`artifacts JSON did not default to latest session\n${artifacts.stdout}`);
  }
  if (!artifactsPayload?.artifacts?.manifest || artifactsPayload?.artifactManifest?.sessionId !== inspection.meta.sessionId) {
    throw new Error(`artifacts JSON missing session artifact manifest\n${artifacts.stdout}`);
  }
  if (!Array.isArray(artifactsPayload.changedFiles) || !artifactsPayload.changedFiles.includes("hello.txt")) {
    throw new Error(`artifacts JSON missing changed file hello.txt\n${artifacts.stdout}`);
  }

  const report = {
    ok: true,
    workspace,
    sessionId: inspection.meta.sessionId,
    version: versionReport.package.version,
    doctorStatus: doctorReport.status,
    artifacts: inspection.artifacts,
    changedFiles: inspection.changedFiles,
    jobSummary: jobsPayload.summary
  };
  await writeFile(path.join(artifactsDir, "product-smoke.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`PASS product smoke session=${report.sessionId}\n`);
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
