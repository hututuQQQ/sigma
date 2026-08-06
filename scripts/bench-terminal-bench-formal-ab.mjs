#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  benchRootDir,
  packageHarborRuntime,
  parseArgs,
  rootDir,
  safePathPart
} from "./bench-common.mjs";
import { runTerminalBenchCli } from "./bench-terminal-bench.mjs";
import {
  formalAbSha256,
  loadFormalABPreregistration
} from "./bench-terminal-bench-formal-ab-preregistration.mjs";
import { evaluateFormalABGate } from "./bench-terminal-bench-formal-ab-gate.mjs";
import { scanBenchmarkFairness } from "./eval/fairness-scan.mjs";

const execFileAsync = promisify(execFile);
const ALLOWED_FLAGS = new Set([
  "preregistration-file", "expected-preregistration-sha256", "stage", "output",
  "baseline-archive", "candidate-archive", "candidate-inspection-file",
  "candidate-freeze-manifest", "safety-report-file"
]);
const REQUIRED_SAFETY_CHECKS = Object.freeze([
  "test", "typecheck", "lint", "package_verification", "harbor_smoke", "fairness_scan"
]);

function required(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function options(argv) {
  const flags = parseArgs(argv);
  const unknown = Object.keys(flags).filter((key) => key !== "_" && !ALLOWED_FLAGS.has(key));
  if (unknown.length > 0 || flags._.length > 0) {
    throw new Error(`Unsupported formal A/B arguments: ${[...unknown, ...flags._].join(", ")}.`);
  }
  const stage = required(flags.stage, "--stage");
  if (stage !== "canary" && stage !== "remaining") {
    throw new Error("--stage must be canary or remaining.");
  }
  const safetyReportFile = typeof flags["safety-report-file"] === "string"
    ? path.resolve(required(flags["safety-report-file"], "--safety-report-file"))
    : null;
  if (stage === "remaining" && !safetyReportFile) {
    throw new Error("--safety-report-file is required for the remaining stage.");
  }
  return {
    preregistrationFile: path.resolve(required(
      flags["preregistration-file"], "--preregistration-file"
    )),
    expectedPreregistrationSha256: required(
      flags["expected-preregistration-sha256"], "--expected-preregistration-sha256"
    ),
    stage,
    outputDir: flags.output ? path.resolve(required(flags.output, "--output")) : null,
    archives: {
      baseline: path.resolve(required(flags["baseline-archive"], "--baseline-archive")),
      candidate: path.resolve(required(flags["candidate-archive"], "--candidate-archive"))
    },
    candidateInspectionFile: path.resolve(required(
      flags["candidate-inspection-file"], "--candidate-inspection-file"
    )),
    candidateFreezeManifest: path.resolve(required(
      flags["candidate-freeze-manifest"], "--candidate-freeze-manifest"
    )),
    safetyReportFile
  };
}

async function gitOutput(args) {
  const result = await execFileAsync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  return String(result.stdout).trim();
}

async function assertCandidateSource(manifest) {
  const revision = await gitOutput(["rev-parse", "HEAD"]);
  const status = await gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (revision !== manifest.arms.candidate.source_revision || status.length > 0) {
    throw new Error("Formal A/B requires the clean frozen candidate source revision.");
  }
}

async function fileSha256(filePath) {
  return formalAbSha256(await readFile(filePath));
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} has an invalid field set.`);
  }
  return value;
}

export function validateSafetyValidationReport(value, manifest) {
  const report = exactObject(value, [
    "schemaVersion", "kind", "source_revision", "candidate_archive_sha256",
    "compiler_digest", "checks"
  ], "safety validation report");
  if (report.schemaVersion !== 1 || report.kind !== "SigmaSafetyValidationReport"
    || report.source_revision !== manifest.arms.candidate.source_revision
    || report.candidate_archive_sha256 !== manifest.arms.candidate.archive_sha256
    || report.compiler_digest !== manifest.arms.candidate.compiler_digest
    || !Array.isArray(report.checks)) {
    throw new Error("Safety validation report is not bound to the frozen candidate.");
  }
  const checks = report.checks.map((value, index) => {
    const check = exactObject(value, [
      "id", "command", "status", "evidence_sha256"
    ], `safety validation report checks[${index}]`);
    if (typeof check.id !== "string" || !REQUIRED_SAFETY_CHECKS.includes(check.id)
      || typeof check.command !== "string" || check.command.trim().length === 0
      || check.status !== "passed"
      || typeof check.evidence_sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(check.evidence_sha256)) {
      throw new Error(`Safety validation report checks[${index}] is invalid or did not pass.`);
    }
    return check;
  });
  const ids = checks.map((check) => check.id).sort();
  if (new Set(ids).size !== ids.length
    || JSON.stringify(ids) !== JSON.stringify([...REQUIRED_SAFETY_CHECKS].sort())) {
    throw new Error("Safety validation report must contain every required check exactly once.");
  }
  return report;
}

async function loadSafetyValidationReport(filePath, manifest) {
  const bytes = await readFile(filePath);
  if (formalAbSha256(bytes) !== manifest.release_evidence.safety_report_sha256) {
    throw new Error("Safety validation report does not match the preregistered SHA-256.");
  }
  return validateSafetyValidationReport(JSON.parse(bytes.toString("utf8")), manifest);
}

export function validateCandidateFreezeManifest(value, manifest, bindings) {
  const frozen = exactObject(value, [
    "schemaVersion", "kind", "createdAt", "source", "subject", "artifact",
    "harness", "safety"
  ], "candidate freeze manifest");
  const source = exactObject(frozen.source, [
    "revision", "tree", "clean", "pnpmLockSha256"
  ], "candidate freeze manifest source");
  const subject = exactObject(frozen.subject, [
    "provider", "model", "reasoningEffort", "profile", "runMode"
  ], "candidate freeze manifest subject");
  const artifact = exactObject(frozen.artifact, [
    "name", "bytes", "sha256"
  ], "candidate freeze manifest artifact");
  const harness = exactObject(frozen.harness, [
    "compilerVersion", "digest", "inspectionSha256", "tokens"
  ], "candidate freeze manifest harness");
  const safety = exactObject(frozen.safety, ["reportSha256"], "candidate freeze manifest safety");
  if (frozen.schemaVersion !== 1 || frozen.kind !== "SigmaFlagshipCandidateFreeze"
    || source.clean !== true
    || source.revision !== manifest.arms.candidate.source_revision
    || typeof source.tree !== "string" || !/^[a-f0-9]{40}$/u.test(source.tree)
    || typeof source.pnpmLockSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(source.pnpmLockSha256)
    || subject.provider !== manifest.controls.provider
    || subject.model !== manifest.controls.model
    || subject.reasoningEffort !== manifest.controls.reasoning_effort
    || subject.profile !== manifest.controls.agent_profile
    || subject.runMode !== "change"
    || typeof artifact.name !== "string" || artifact.name.length === 0
    || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1
    || artifact.sha256 !== manifest.arms.candidate.archive_sha256
    || typeof harness.compilerVersion !== "string" || harness.compilerVersion.length === 0
    || harness.digest !== manifest.arms.candidate.compiler_digest
    || harness.inspectionSha256 !== bindings.inspectionSha256
    || safety.reportSha256 !== manifest.release_evidence.safety_report_sha256) {
    throw new Error("Candidate freeze manifest is not bound to the formal A/B candidate.");
  }
  const tokens = exactObject(harness.tokens, [
    "tokenizer", "countMethod", "mandatoryPromptTokens", "initialToolSchemaTokens",
    "combinedTokens", "mandatoryPromptBytes", "initialToolSchemaBytes"
  ], "candidate freeze manifest harness tokens");
  if (tokens.countMethod !== "gateway.countTokens"
    || !["exact", "approximate"].includes(tokens.tokenizer)
    || [
      tokens.mandatoryPromptTokens, tokens.initialToolSchemaTokens, tokens.combinedTokens,
      tokens.mandatoryPromptBytes, tokens.initialToolSchemaBytes
    ].some((item) => !Number.isSafeInteger(item) || item < 0)) {
    throw new Error("Candidate freeze manifest contains invalid Harness token measurements.");
  }
  return frozen;
}

async function assertCandidateFreezeManifest(manifest, runOptions) {
  const bytes = await readFile(runOptions.candidateFreezeManifest);
  if (formalAbSha256(bytes) !== manifest.release_evidence.candidate_freeze_manifest_sha256) {
    throw new Error("Candidate freeze manifest does not match the preregistered SHA-256.");
  }
  const inspectionSha256 = await fileSha256(runOptions.candidateInspectionFile);
  return validateCandidateFreezeManifest(JSON.parse(bytes.toString("utf8")), manifest, {
    inspectionSha256
  });
}

async function assertFrozenInputs(manifest, runOptions) {
  await assertCandidateSource(manifest);
  for (const arm of ["baseline", "candidate"]) {
    const observed = await fileSha256(runOptions.archives[arm]);
    if (observed !== manifest.arms[arm].archive_sha256) {
      throw new Error(`${arm} archive does not match the preregistered SHA-256.`);
    }
  }
  const inspection = JSON.parse(await readFile(runOptions.candidateInspectionFile, "utf8"));
  if (inspection.digest !== manifest.arms.candidate.compiler_digest
    || inspection.subject?.provider !== manifest.controls.provider
    || inspection.subject?.model !== manifest.controls.model
    || inspection.subject?.reasoningEffort !== manifest.controls.reasoning_effort
    || inspection.subject?.modelRole !== "orchestrator"
    || inspection.subject?.runMode !== "change"
    || inspection.subject?.profileId !== manifest.controls.agent_profile
    || !inspection.policyPackIds?.includes("sigma.flagship.v1")) {
    throw new Error("Candidate Harness inspection does not match the preregistered arm.");
  }
  await assertCandidateFreezeManifest(manifest, runOptions);
}

async function writeExclusive(filePath, value) {
  const handle = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function jsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function publicGatePath(outputDir, stage) {
  return path.join(outputDir, stage === "canary" ? "canary-gate.json" : "release-gate.json");
}

function resultSummary(taskIndex, arm, result) {
  const report = result.report ?? {};
  const counts = report.counts ?? {};
  const correctnessPassed = report.effective_correctness?.passed;
  const correctnessTotal = report.effective_correctness?.total;
  const hasCorrectnessRecord = typeof correctnessPassed === "number"
    && Number.isFinite(correctnessPassed)
    && correctnessTotal === 1;
  const infraFailure = !result.report
    || !hasCorrectnessRecord
    || Number(counts.infra_failed ?? 0) > 0
    || Number(report.validity?.infra_failed ?? 0) > 0
    || report.infra_status === "incomplete";
  const cost = typeof report.cost_usd === "number" && Number.isFinite(report.cost_usd)
    ? report.cost_usd : null;
  if (!infraFailure && (cost === null || cost <= 0)) {
    throw new Error("A completed formal A/B arm is missing positive provider cost data.");
  }
  return {
    task_index: taskIndex,
    arm,
    passed: Number(report.effective_correctness?.passed ?? counts.passed ?? 0) === 1,
    infra_failure: infraFailure,
    timeout: Number(counts.timeout ?? 0) > 0,
    cost_usd: cost ?? 0
  };
}

async function traceFiles(directory) {
  const files = [];
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const resolved = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(resolved);
      else if (entry.isFile() && entry.name === "trace.jsonl") files.push(resolved);
    }
  }
  await visit(directory);
  return files.sort();
}

export async function rootHarnessDigests(runDir) {
  const events = [];
  for (const filePath of await traceFiles(runDir)) {
    const lines = (await readFile(filePath, "utf8")).split(/\r?\n/u).filter(Boolean);
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        throw new Error(`Formal A/B trace is not valid JSONL: ${filePath}.`, { cause: error });
      }
      if (record?.sigma_event && typeof record.sigma_event === "object") {
        events.push(record.sigma_event);
      }
    }
  }
  const roots = new Set(events
    .filter((event) => event.type === "session.created"
      && typeof event.sessionId === "string"
      && event.payload?.parentSessionId === undefined)
    .map((event) => event.sessionId));
  return [...new Set(events
    .filter((event) => event.type === "harness.compiled"
      && event.authority === "runtime"
      && roots.has(event.sessionId)
      && typeof event.payload?.digest === "string")
    .map((event) => event.payload.digest))].sort();
}

export async function assertCandidateHarnessObserved(result, expectedDigest, infraFailure) {
  const observed = await rootHarnessDigests(result.runDir);
  if (observed.some((digest) => digest !== expectedDigest)) {
    throw new Error("Candidate run used a root Harness digest outside the preregistration.");
  }
  if (!infraFailure && (observed.length !== 1 || observed[0] !== expectedDigest)) {
    throw new Error("Candidate run did not expose its preregistered root Harness digest.");
  }
}

function armArguments(manifest, taskFile, arm) {
  const controls = manifest.controls;
  return [
    "--mode", "batch",
    "--tasks-file", taskFile,
    "--dataset", manifest.task_selection.dataset,
    "--provider", controls.provider,
    "--model", controls.model,
    "--reasoning-effort", controls.reasoning_effort,
    "--benchmark-class", controls.benchmark_class,
    "--agent-profile", controls.agent_profile,
    "--max-turns", String(controls.max_turns),
    "--command-timeout-sec", String(controls.command_timeout_sec),
    "--agent-timeout-grace-sec", String(controls.cleanup_grace_sec),
    "--network", controls.network_mode,
    "--execution-mode", controls.execution_mode,
    "--write-scope", controls.write_scope,
    "--managed-environment-mode", controls.managed_environment_mode,
    "--harbor-topology", controls.harbor_topology,
    "--concurrency", "1",
    "--attempts", String(controls.attempts),
    "--retries", String(controls.retries),
    "--timeout-leniency-multiplier", "1",
    "--timeout-leniency-min-extra-sec", "0",
    "--run-label", `formal-ab-${safePathPart(manifest.formal_ab_id)}-${randomUUID()}`,
    "--reuse-package",
    "--expected-archive-sha256", manifest.arms[arm].archive_sha256
  ];
}

async function concurrencyMap(items, maximum, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function consume() {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(maximum, items.length) }, consume));
  return output;
}

async function prepareHarborRuntime(vaultDir, deps) {
  const packager = deps.packageHarborRuntime ?? packageHarborRuntime;
  const result = await packager({
    cwd: rootDir,
    env: process.env,
    stdoutPath: path.join(vaultDir, "harbor-runtime.stdout.log"),
    stderrPath: path.join(vaultDir, "harbor-runtime.stderr.log"),
    rawPath: path.join(vaultDir, "harbor-runtime.raw.log")
  });
  if (result.exitCode !== 0) throw new Error("Portable Harbor runtime packaging failed.");
  return result;
}

async function executePair(context, taskIndex) {
  const { manifest, runOptions, vaultDir, preparedRuntime, deps } = context;
  const taskFile = path.join(vaultDir, `task-${String(taskIndex).padStart(4, "0")}.json`);
  await writeExclusive(taskFile, [manifest.task_selection.tasks[taskIndex]]);
  const order = manifest.execution.arm_order.find((item) => item.task_index === taskIndex).arms;
  const summaries = [];
  for (const arm of order) {
    const startedPath = path.join(vaultDir, `${taskIndex}-${arm}.started.json`);
    const resultPath = path.join(vaultDir, `${taskIndex}-${arm}.result.json`);
    await writeExclusive(startedPath, {
      schemaVersion: 1,
      task_index: taskIndex,
      arm,
      archive_sha256: manifest.arms[arm].archive_sha256,
      started_at: new Date().toISOString()
    });
    const runner = deps.runArm ?? (async (args, armName) => await runTerminalBenchCli(args, {
      ...(deps.terminalBenchDeps ?? {}),
      benchRootDir: path.join(vaultDir, "runs"),
      env: {
        ...process.env,
        AGENT_CLI_TARBALL: runOptions.archives[armName]
      },
      packageHarborRuntime: async () => preparedRuntime
    }));
    const result = await runner(
      armArguments(manifest, taskFile, arm), arm, taskIndex
    );
    await writeExclusive(resultPath, result);
    const summary = resultSummary(taskIndex, arm, result);
    if (arm === "candidate") {
      await (deps.assertCandidateHarnessObserved ?? assertCandidateHarnessObserved)(
        result,
        manifest.arms.candidate.compiler_digest,
        summary.infra_failure
      );
    }
    summaries.push(summary);
  }
  return summaries;
}

export async function runFormalAB(argv = process.argv.slice(2), deps = {}) {
  const runOptions = options(argv);
  const bundle = await loadFormalABPreregistration(
    runOptions.preregistrationFile,
    runOptions.expectedPreregistrationSha256
  );
  const { manifest } = bundle;
  await (deps.assertFrozenInputs ?? assertFrozenInputs)(manifest, runOptions);
  const safetyReport = runOptions.stage === "remaining"
    ? await loadSafetyValidationReport(runOptions.safetyReportFile, manifest)
    : null;
  const outputDir = runOptions.outputDir
    ?? path.join(benchRootDir, "formal-ab", safePathPart(manifest.formal_ab_id));
  const vaultDir = path.join(outputDir, "evaluation-vault");
  await mkdir(vaultDir, { recursive: true, mode: 0o700 });
  const frozenPath = path.join(vaultDir, "frozen-preregistration.json");
  const frozen = await jsonIfPresent(frozenPath);
  if (frozen && frozen.consumption_identity_sha256 !== manifest.consumption_identity_sha256) {
    throw new Error("Formal A/B output belongs to a different preregistration.");
  }
  if (!frozen) await writeExclusive(frozenPath, manifest);
  if (safetyReport && !await jsonIfPresent(path.join(vaultDir, "frozen-safety-report.json"))) {
    await writeExclusive(path.join(vaultDir, "frozen-safety-report.json"), safetyReport);
  }
  const canaryGate = await jsonIfPresent(publicGatePath(outputDir, "canary"));
  if (runOptions.stage === "remaining" && canaryGate?.status !== "passed") {
    throw new Error("Remaining tasks require a passed canary gate for this frozen candidate.");
  }
  if (runOptions.stage === "canary" && canaryGate) {
    throw new Error("Canary was already consumed; solver attempts cannot be retried.");
  }
  if (runOptions.stage === "remaining" && await jsonIfPresent(publicGatePath(outputDir, "release"))) {
    throw new Error("Remaining tasks were already consumed; solver attempts cannot be retried.");
  }
  const taskIndexes = runOptions.stage === "canary"
    ? manifest.execution.canary_task_indexes
    : manifest.execution.remaining_task_indexes;
  const preparedRuntime = await prepareHarborRuntime(vaultDir, deps);
  const stageSummaries = (await concurrencyMap(
    taskIndexes,
    manifest.controls.concurrency,
    async (taskIndex) => await executePair({
      manifest, runOptions, vaultDir, preparedRuntime, deps
    }, taskIndex)
  )).flat();
  const prior = runOptions.stage === "remaining"
    ? JSON.parse(await readFile(path.join(vaultDir, "canary-records.json"), "utf8"))
    : [];
  const allRecords = [...prior, ...stageSummaries];
  await writeExclusive(
    path.join(vaultDir, runOptions.stage === "canary" ? "canary-records.json" : "release-records.json"),
    allRecords
  );
  const fairnessPassed = runOptions.stage === "remaining"
    ? (deps.scanFairness ?? scanBenchmarkFairness)(rootDir).then((items) => items.length === 0)
    : Promise.resolve(false);
  const gate = evaluateFormalABGate(
    manifest,
    runOptions.stage === "canary" ? "canary" : "release",
    allRecords,
    {
      safetyPassed: runOptions.stage === "remaining" && safetyReport !== null,
      fairnessPassed: await fairnessPassed
    }
  );
  await writeExclusive(publicGatePath(outputDir, gate.stage), gate);
  return { outputDir, gate, exitCode: gate.status === "passed" ? 0 : 1 };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runFormalAB().then((result) => {
  process.stdout.write(`Formal A/B ${result.gate.stage} gate: ${result.gate.status}\n`);
  process.exitCode = result.exitCode;
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
