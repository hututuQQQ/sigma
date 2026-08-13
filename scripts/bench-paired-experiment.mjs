#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, open, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHarborTimeoutProbeConfig,
  harborEnvForRun,
  harborPythonCommand,
  harborTaskExecutionIdentitySha256,
  packageHarborRuntime,
  parseHarborTimeoutProbe,
  rootDir,
  runProcess,
  safePathPart,
  taskSelectionIdentitySha256
} from "./bench-common.mjs";
import { runTerminalBenchCli } from "./bench-terminal-bench.mjs";
import { loadPairedExperiment, pairedSha256 } from "./bench-paired-preregistration.mjs";

const BLOCKING_FAILURES = new Set([
  "host_proxy_error", "host_encoding_error", "harbor_cli_error", "node_missing",
  "agent_setup_failed", "infrastructure_incomplete", "verifier_setup_failed"
]);
const PROVIDER_BLOCKER = /(?:auth(?:entication|orization)?|credential|unauthori[sz]ed|invalid[_ -]?api[_ -]?key|rate[_ -]?limit|service unavailable|provider unavailable|connection (?:refused|reset)|could not resolve host)/iu;

function required(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required.`);
  return value.trim();
}

function options(argv) {
  const flags = {};
  const supported = new Set([
    "preregistration-file", "expected-preregistration-sha256", "output", "stage"
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--") || !supported.has(token.slice(2))) {
      throw new Error(`Unsupported paired runner option: ${token}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
    flags[token.slice(2)] = value;
    index += 1;
  }
  return {
    preregistrationFile: path.resolve(required(flags["preregistration-file"], "--preregistration-file")),
    expectedSha256: required(flags["expected-preregistration-sha256"], "--expected-preregistration-sha256"),
    outputDir: flags.output ? path.resolve(flags.output) : null,
    stage: flags.stage ?? "next"
  };
}

async function writeExclusive(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const handle = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
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

async function ensureStableJson(filePath, value) {
  const expected = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const existing = await readFile(filePath, "utf8");
    if (existing !== expected) throw new Error(`Frozen control file drifted: ${filePath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeExclusive(filePath, Buffer.from(expected));
  }
}

async function fileSha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function armArchives(manifest, manifestPath) {
  const baseDir = path.dirname(manifestPath);
  return new Map(manifest.arms.map((arm) => [arm.id, {
    ...arm,
    archive: path.resolve(baseDir, arm.runtime.archive_path)
  }]));
}

async function assertFrozenArchives(arms) {
  for (const arm of arms.values()) {
    let observed;
    try {
      observed = await fileSha256(arm.archive);
    } catch (error) {
      throw new Error(`Runtime archive for arm ${arm.id} is unavailable: ${arm.archive}`, { cause: error });
    }
    if (observed !== arm.runtime.archive_sha256) {
      throw new Error(`Runtime archive for arm ${arm.id} does not match its frozen SHA-256.`);
    }
  }
}

function credentialAvailable(harness, env = process.env) {
  if (harness === "codex") {
    const configured = env.CODEX_AUTH_JSON_PATH;
    const candidate = configured && path.isAbsolute(configured)
      ? configured : path.join(os.homedir(), ".codex", "auth.json");
    return Boolean(env.OPENAI_API_KEY) || path.isAbsolute(candidate);
  }
  const configured = env.SIGMA_HOST_CREDENTIAL_FILE || env.SIGMA_CREDENTIAL_FILE;
  const candidate = configured && path.isAbsolute(configured)
    ? configured : path.join(os.homedir(), ".sigma", "auth.json");
  return Boolean(env.OPENAI_API_KEY) || path.isAbsolute(candidate);
}

async function assertCredentials(arms, env = process.env) {
  for (const arm of arms.values()) {
    if (!credentialAvailable(arm.harness, env)) {
      throw new Error(`No host credential source is configured for ${arm.harness}.`);
    }
    const candidate = arm.harness === "codex"
      ? env.CODEX_AUTH_JSON_PATH || path.join(os.homedir(), ".codex", "auth.json")
      : env.SIGMA_HOST_CREDENTIAL_FILE || env.SIGMA_CREDENTIAL_FILE
        || path.join(os.homedir(), ".sigma", "auth.json");
    if (!env.OPENAI_API_KEY) {
      try {
        await readFile(candidate);
      } catch (error) {
        throw new Error(`Credential file for ${arm.harness} is unavailable: ${candidate}`, { cause: error });
      }
    }
  }
}

function stagePaths(outputDir, stageId) {
  const root = path.join(outputDir, "receipts", safePathPart(stageId));
  return {
    root,
    started: path.join(root, "stage.started.json"),
    completed: path.join(root, "stage.completed.json")
  };
}

async function completedPrefix(manifest, outputDir) {
  const completed = [];
  let foundGap = false;
  for (const stage of manifest.execution.stages) {
    const paths = stagePaths(outputDir, stage.id);
    const [started, receipt] = await Promise.all([
      jsonIfPresent(paths.started), jsonIfPresent(paths.completed)
    ]);
    if (receipt && !started) throw new Error(`Stage ${stage.id} has a completion receipt without a start receipt.`);
    if (foundGap && (started || receipt)) throw new Error("Stage receipts are not an append-only prefix.");
    if (started && !receipt) {
      throw new Error(`Stage ${stage.id} was consumed but did not complete; solver attempts cannot be retried.`);
    }
    if (receipt) completed.push(stage.id);
    else foundGap = true;
  }
  return completed;
}

function selectStage(manifest, completed, requested) {
  const next = manifest.execution.stages[completed.length];
  if (!next) throw new Error("Every preregistered stage is already complete.");
  if (requested !== "next" && requested !== next.id) {
    throw new Error(`The next unconsumed stage is ${next.id}; received ${requested}.`);
  }
  return next;
}

function exactTask(report, expectedIdentity) {
  const tasks = Array.isArray(report?.tasks) ? report.tasks : [];
  if (tasks.length === 1 && tasks[0]?.selection_identity_sha256 === expectedIdentity) {
    return { task: tasks[0], identityEvidence: "task" };
  }
  const slots = Array.isArray(report?.run_slots) ? report.run_slots : [];
  const reportIncomplete = report?.incomplete_reason !== null
    || Number(report?.trial_accounting?.expected) !== 1
    || Number(report?.trial_accounting?.observed) !== 1
    || Number(report?.trial_accounting?.missing) !== 0;
  if (reportIncomplete && slots.length === 1
    && slots[0]?.selection_identity_sha256 === expectedIdentity) {
    return {
      task: tasks.length === 1 ? tasks[0] : {},
      identityEvidence: "run_slot_attestation"
    };
  }
  throw new Error("The benchmark report does not contain the frozen task identity exactly once.");
}

export function classifyBlockingCondition(report, task) {
  if (!report || report.incomplete_reason !== null
    || Number(report.trial_accounting?.expected) !== 1
    || Number(report.trial_accounting?.observed) !== 1
    || Number(report.trial_accounting?.missing) !== 0) {
    return "missing_or_incomplete_report";
  }
  if (task?.validity === "infra_failed" || BLOCKING_FAILURES.has(task?.failure_category)) {
    return "infra_failed_attempt";
  }
  const errorText = `${task?.last_error ?? ""}\n${task?.agent_exception?.message ?? ""}`;
  if (task?.failure_category === "api_error" || PROVIDER_BLOCKER.test(errorText)) {
    return "credential_or_provider_unavailable";
  }
  if (report.frozen_runtime_integrity === "failed" || report.docker_cleanup?.clean === false
    || (Array.isArray(report.notes) && report.notes.some((note) => /Docker resources remained|postflight failed/iu.test(note)))) {
    return "dirty_runtime_or_docker_cleanup";
  }
  return null;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function summarizePairedAttempt(context) {
  const { manifest, stage, pair, arm, result } = context;
  const report = result?.report;
  if (!report || report.harness !== arm.harness
    || report.provider !== manifest.model.provider
    || report.model !== manifest.model.name
    || report.reasoning_effort !== manifest.model.reasoning_effort
    || report.dataset !== manifest.task_catalog.dataset
    || report.runtime_archive_sha256 !== arm.runtime.archive_sha256) {
    throw new Error("Benchmark report controls drifted from the paired preregistration.");
  }
  const expectedIdentity = taskSelectionIdentitySha256(
    manifest.selection.selected_tasks[pair.task_index]
  );
  const { task, identityEvidence } = exactTask(report, expectedIdentity);
  const blockingCondition = classifyBlockingCondition(report, task);
  const inputTokens = numberOrZero(task.input_tokens);
  const cacheReadTokens = numberOrZero(task.cache_read_tokens ?? task.cache_tokens);
  const outputTokens = numberOrZero(task.output_tokens);
  return {
    schemaVersion: 1,
    experiment_id: manifest.experiment_id,
    stage: stage.id,
    task_index: pair.task_index,
    task_identity_sha256: expectedIdentity,
    repetition: pair.repetition,
    arm: arm.id,
    harness: arm.harness,
    order: pair.arms.indexOf(arm.id) + 1,
    valid: blockingCondition === null && task.validity === "valid",
    passed: blockingCondition === null && task.validity === "valid" && task.verifier_outcome === "passed",
    agent_outcome: task.agent_outcome ?? null,
    verifier_outcome: task.verifier_outcome ?? null,
    failure_category: task.failure_category ?? null,
    blocking_condition: blockingCondition,
    task_identity_evidence: identityEvidence,
    metrics: {
      duration_ms: numberOrZero(task.duration_ms),
      input_tokens: inputTokens,
      cache_read_tokens: cacheReadTokens,
      output_tokens: outputTokens,
      reasoning_tokens: numberOrZero(task.reasoning_tokens),
      uncached_tokens: Math.max(0, inputTokens - cacheReadTokens) + outputTokens,
      commands_executed: numberOrZero(task.commands_executed),
      cost_usd: Number.isFinite(Number(task.cost_usd)) && Number(task.cost_usd) > 0
        ? Number(task.cost_usd) : null
    },
    trace: {
      source_path: task.trace_path ?? null,
      format: task.trace_format ?? null,
      evidence_path: null
    },
    run_dir: result.runDir
  };
}

async function copyTraceEvidence(summary, outputDir) {
  if (!summary.trace.source_path) return summary;
  const source = path.resolve(summary.run_dir, summary.trace.source_path);
  try {
    await readFile(source);
  } catch {
    return summary;
  }
  const extension = path.extname(source) || ".trace";
  const relative = path.join(
    "evidence",
    `r${String(summary.repetition).padStart(2, "0")}-t${String(summary.task_index).padStart(3, "0")}`,
    `${safePathPart(summary.arm)}${extension}`
  );
  const target = path.join(outputDir, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target, constants.COPYFILE_EXCL);
  return {
    ...summary,
    trace: { ...summary.trace, evidence_path: relative.replaceAll("\\", "/") }
  };
}

function armArguments(manifest, pair, arm, archive, taskFile) {
  const controls = manifest.controls;
  return [
    "--mode", "batch",
    "--tasks-file", taskFile,
    "--dataset", manifest.task_catalog.dataset,
    "--harness", arm.harness,
    "--provider", manifest.model.provider,
    "--model", manifest.model.name,
    "--reasoning-effort", manifest.model.reasoning_effort,
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
    "--attempts", "1",
    "--retries", "0",
    "--timeout-leniency-multiplier", "1",
    "--timeout-leniency-min-extra-sec", "0",
    "--runtime-archive", archive,
    "--runtime-layout", arm.runtime.layout,
    ...(arm.runtime.version ? ["--runtime-version", arm.runtime.version] : []),
    "--reuse-package",
    "--expected-archive-sha256", arm.runtime.archive_sha256,
    "--run-label", `paired-${safePathPart(manifest.experiment_id)}-r${pair.repetition}-t${pair.task_index}-${safePathPart(arm.id)}`
  ];
}

async function ensureStableTaskFile(filePath, task) {
  const expected = `${JSON.stringify([task], null, 2)}\n`;
  try {
    const existing = await readFile(filePath, "utf8");
    if (existing !== expected) throw new Error(`Frozen task file drifted: ${filePath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeExclusive(filePath, Buffer.from(expected));
  }
}

async function executePair(context, pair) {
  const { manifest, stage, outputDir, arms, preparedRuntime, deps, state } = context;
  const label = `r${String(pair.repetition).padStart(2, "0")}-t${String(pair.task_index).padStart(3, "0")}`;
  const taskFile = path.join(outputDir, "control", `${label}.task.json`);
  await ensureStableTaskFile(taskFile, manifest.selection.selected_tasks[pair.task_index]);
  const summaries = [];
  for (const armId of pair.arms) {
    if (state.blocking) break;
    const arm = arms.get(armId);
    const receiptDir = path.join(outputDir, "receipts", safePathPart(stage.id), label);
    const startedPath = path.join(receiptDir, `${safePathPart(armId)}.started.json`);
    const completedPath = path.join(receiptDir, `${safePathPart(armId)}.completed.json`);
    if (await jsonIfPresent(startedPath) || await jsonIfPresent(completedPath)) {
      throw new Error(`Attempt ${label}/${armId} was already consumed.`);
    }
    let dispatched = false;
    const beforeHarborDispatch = async () => {
      await writeExclusive(startedPath, {
        schemaVersion: 1,
        experiment_id: manifest.experiment_id,
        stage: stage.id,
        task_index: pair.task_index,
        repetition: pair.repetition,
        arm: armId,
        runtime_archive_sha256: arm.runtime.archive_sha256,
        started_at: new Date().toISOString()
      });
      dispatched = true;
    };
    const runner = deps.runArm ?? (async (args) => runTerminalBenchCli(args, {
      env: {
        ...process.env,
        AGENT_CLI_TARBALL: [...arms.values()].find((item) => item.harness === "sigma")?.archive,
        CODEX_CLI_TARBALL: [...arms.values()].find((item) => item.harness === "codex")?.archive,
        SIGMA_BENCH_HARNESS: arm.harness
      },
      benchRootDir: path.join(outputDir, "runs"),
      packageHarborRuntime: async () => preparedRuntime,
      beforeHarborDispatch
    }));
    let result;
    try {
      result = await runner(
        armArguments(manifest, pair, arm, arm.archive, taskFile),
        { arm, pair, stage, beforeHarborDispatch }
      );
    } catch (error) {
      if (dispatched) {
        state.blocking = "missing_or_incomplete_report";
        throw new Error(`Consumed attempt ${label}/${armId} failed after dispatch.`, { cause: error });
      }
      throw error;
    }
    if (!dispatched && deps.runArm) await beforeHarborDispatch();
    let summary = summarizePairedAttempt({ manifest, stage, pair, arm, result });
    summary = await copyTraceEvidence(summary, outputDir);
    summary = {
      ...summary,
      run_dir: path.relative(outputDir, result.runDir).replaceAll("\\", "/"),
      completed_at: new Date().toISOString()
    };
    await writeExclusive(completedPath, summary);
    summaries.push(summary);
    if (summary.blocking_condition) state.blocking = summary.blocking_condition;
  }
  return summaries;
}

async function concurrencyMap(items, maximum, worker, state) {
  const results = new Array(items.length);
  let cursor = 0;
  async function consume() {
    for (;;) {
      if (state.blocking) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(maximum, items.length) }, consume));
  return results.filter(Boolean).flat();
}

async function prepareRuntime(outputDir, arms, deps) {
  const sigmaArchive = [...arms.values()].find((arm) => arm.harness === "sigma")?.archive;
  const packager = deps.packageHarborRuntime ?? packageHarborRuntime;
  const result = await packager({
    cwd: rootDir,
    env: { ...process.env, ...(sigmaArchive ? { AGENT_CLI_TARBALL: sigmaArchive } : {}) },
    stdoutPath: path.join(outputDir, "preflight", "harbor-runtime.stdout.log"),
    stderrPath: path.join(outputDir, "preflight", "harbor-runtime.stderr.log"),
    rawPath: path.join(outputDir, "preflight", "harbor-runtime.raw.log")
  });
  if (result.exitCode !== 0) throw new Error("Portable Harbor runtime packaging failed.");
  return result;
}

async function prefetchPairedTasks({ manifest, stage, outputDir, arms }) {
  const arm = [...arms.values()].find((candidate) => candidate.harness === "sigma")
    ?? [...arms.values()][0];
  if (!arm) throw new Error("Paired task prefetch requires at least one harness arm.");
  const preflightDir = path.join(outputDir, "preflight");
  const prefetchRunDir = path.join(preflightDir, "task-cache");
  const env = harborEnvForRun(prefetchRunDir, process.env, {
    harness: arm.harness,
    runtimeArchive: arm.archive,
    runtimeVersion: arm.runtime.version
  });
  const config = buildHarborTimeoutProbeConfig({
    mode: "batch",
    tasks: manifest.selection.selected_tasks,
    harness: arm.harness,
    provider: manifest.model.provider,
    model: manifest.model.name,
    reasoningEffort: manifest.model.reasoning_effort,
    agentProfile: manifest.controls.agent_profile,
    maxTurns: manifest.controls.max_turns,
    commandTimeoutSec: manifest.controls.command_timeout_sec,
    networkMode: manifest.controls.network_mode,
    executionMode: manifest.controls.execution_mode,
    writeScope: manifest.controls.write_scope,
    managedEnvironmentMode: manifest.controls.managed_environment_mode,
    harborTopology: manifest.controls.harbor_topology,
    attemptsPerTask: 1,
    retries: 0,
    nConcurrentTrials: 1,
    expectedArchiveSha256: arm.runtime.archive_sha256,
    runtimeArchive: arm.archive,
    runtimeLayout: arm.runtime.layout,
    runtimeVersion: arm.runtime.version,
    env
  }, path.join(prefetchRunDir, "jobs"));
  const configPath = path.join(preflightDir, "task-cache.config.json");
  await ensureStableJson(configPath, config);
  const label = `task-cache-${safePathPart(stage.id)}`;
  const result = await runProcess(
    harborPythonCommand(env),
    [path.join(rootDir, "scripts", "probe-harbor-timeouts.py"), configPath],
    {
      cwd: rootDir,
      env,
      stdoutPath: path.join(preflightDir, `${label}.stdout.log`),
      stderrPath: path.join(preflightDir, `${label}.stderr.log`),
      rawPath: path.join(preflightDir, `${label}.raw.log`)
    }
  );
  if (result.exitCode !== 0) {
    throw new Error(`Harbor task-cache prefetch failed before stage ${stage.id}.`);
  }
  const probe = parseHarborTimeoutProbe(result.stdout);
  const expected = manifest.selection.selected_tasks
    .map((task) => harborTaskExecutionIdentitySha256(task)).sort();
  const observed = (Array.isArray(probe?.resolved_tasks) ? probe.resolved_tasks : [])
    .map((task) => harborTaskExecutionIdentitySha256(task)).sort();
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error("Harbor task-cache prefetch did not resolve the frozen selected task set exactly.");
  }
  await ensureStableJson(path.join(preflightDir, `${label}.completed.json`), {
    schemaVersion: 1,
    experiment_id: manifest.experiment_id,
    stage: stage.id,
    task_count: observed.length,
    task_execution_identities: observed
  });
}

export async function runPairedExperiment(argv = process.argv.slice(2), deps = {}) {
  const runOptions = options(argv);
  const bundle = await loadPairedExperiment(runOptions.preregistrationFile, runOptions.expectedSha256);
  const { manifest } = bundle;
  const outputDir = runOptions.outputDir
    ?? path.join(rootDir, ".artifacts", "paired-experiments", safePathPart(manifest.experiment_id));
  await mkdir(outputDir, { recursive: true });
  const frozenPath = path.join(outputDir, "control", "preregistration.json");
  const frozen = await jsonIfPresent(frozenPath);
  if (frozen && frozen.consumption_identity_sha256 !== manifest.consumption_identity_sha256) {
    throw new Error("Output directory belongs to a different paired experiment.");
  }
  if (!frozen) await writeExclusive(frozenPath, manifest);
  const arms = armArchives(manifest, bundle.path);
  await (deps.assertFrozenArchives ?? assertFrozenArchives)(arms);
  await (deps.assertCredentials ?? assertCredentials)(arms, deps.env ?? process.env);
  const completed = await completedPrefix(manifest, outputDir);
  const stage = selectStage(manifest, completed, runOptions.stage);
  const paths = stagePaths(outputDir, stage.id);
  const preparedRuntime = await prepareRuntime(outputDir, arms, deps);
  await (deps.prefetchTasks ?? prefetchPairedTasks)({
    manifest, stage, outputDir, arms, preparedRuntime
  });
  await writeExclusive(paths.started, {
    schemaVersion: 1,
    experiment_id: manifest.experiment_id,
    consumption_identity_sha256: manifest.consumption_identity_sha256,
    stage: stage.id,
    started_at: new Date().toISOString(),
    expected_pairs: stage.pairs.length
  });
  const state = { blocking: null };
  let records = [];
  try {
    records = await concurrencyMap(
      stage.pairs,
      manifest.execution.concurrency,
      (pair) => executePair({ manifest, stage, outputDir, arms, preparedRuntime, deps, state }, pair),
      state
    );
  } catch (error) {
    state.blocking ??= "missing_or_incomplete_report";
    await writeExclusive(path.join(paths.root, "stage.stopped.json"), {
      schemaVersion: 1,
      experiment_id: manifest.experiment_id,
      stage: stage.id,
      blocking_condition: state.blocking,
      stopped_at: new Date().toISOString(),
      completed_attempts: records.length,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
  if (state.blocking) {
    await writeExclusive(path.join(paths.root, "stage.stopped.json"), {
      schemaVersion: 1,
      experiment_id: manifest.experiment_id,
      stage: stage.id,
      blocking_condition: state.blocking,
      stopped_at: new Date().toISOString(),
      completed_attempts: records.length
    });
    return { outputDir, stage: stage.id, status: "stopped", blocking: state.blocking, records };
  }
  if (records.length !== stage.pairs.length * manifest.arms.length) {
    throw new Error(`Stage ${stage.id} did not produce every paired attempt.`);
  }
  const receipt = {
    schemaVersion: 1,
    experiment_id: manifest.experiment_id,
    consumption_identity_sha256: manifest.consumption_identity_sha256,
    stage: stage.id,
    status: "complete",
    completed_at: new Date().toISOString(),
    attempts: records.length,
    records_sha256: pairedSha256(JSON.stringify(records))
  };
  await writeExclusive(paths.completed, receipt);
  return { outputDir, stage: stage.id, status: "complete", records, receipt };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runPairedExperiment().then((result) => {
  process.stdout.write(`${JSON.stringify({
    output: result.outputDir,
    stage: result.stage,
    status: result.status,
    blocking_condition: result.blocking ?? null,
    attempts: result.records.length
  })}\n`);
  if (result.status === "stopped") process.exitCode = 2;
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
