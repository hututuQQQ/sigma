#!/usr/bin/env node
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  assertComparableBenchmarkReports,
  benchRootDir,
  defaultAgentCliTarball,
  laneMetrics,
  parseArgs,
  rootDir,
  safePathPart,
  writeJson
} from "./bench-common.mjs";
import {
  assertFrozenBatchControls,
  loadFormalPreregistration,
  sha256,
  validateFormalPreregistration
} from "./bench-terminal-bench-formal-preregistration.mjs";
import { runTerminalBenchCli } from "./bench-terminal-bench.mjs";

const execFileAsync = promisify(execFile);
const ALLOWED_FLAGS = new Set([
  "preregistration-file", "expected-preregistration-sha256", "output", "batch", "resume"
]);

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function formalOptions(argv) {
  const flags = parseArgs(argv);
  const unknown = Object.keys(flags).filter((key) => key !== "_" && !ALLOWED_FLAGS.has(key));
  if (unknown.length > 0 || flags._.length > 0) {
    throw new Error(`Unsupported formal runner arguments: ${[...unknown, ...flags._].join(", ")}.`);
  }
  if (flags.resume !== undefined && flags.resume !== true) {
    throw new Error("--resume is a boolean flag.");
  }
  return {
    preregistrationFile: path.resolve(requiredString(
      flags["preregistration-file"], "--preregistration-file"
    )),
    expectedPreregistrationSha256: requiredString(
      flags["expected-preregistration-sha256"], "--expected-preregistration-sha256"
    ).toLowerCase(),
    outputDir: flags.output ? path.resolve(requiredString(flags.output, "--output")) : null,
    batchId: requiredString(flags.batch, "--batch"),
    resume: flags.resume === true
  };
}

async function gitOutput(args, cwd) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    });
    return String(result.stdout).trim();
  } catch (error) {
    throw new Error(`Unable to verify frozen source with git ${args.join(" ")}.`, { cause: error });
  }
}

export async function assertFormalSource(source, cwd = rootDir) {
  const revision = await gitOutput(["rev-parse", "HEAD"], cwd);
  if (revision !== source.revision) {
    throw new Error(`Frozen source revision ${source.revision} does not match current HEAD ${revision}.`);
  }
  const status = await gitOutput(["status", "--porcelain=v1", "--untracked-files=all"], cwd);
  if (status.length > 0) throw new Error("Formal evaluation requires the frozen source worktree to be clean.");
}

export async function assertFormalArchive(expectedSha256, archivePath = null) {
  const target = path.resolve(archivePath ?? process.env.AGENT_CLI_TARBALL ?? defaultAgentCliTarball);
  let bytes;
  try {
    bytes = await readFile(target);
  } catch (error) {
    throw new Error(`Frozen agent archive is unavailable at ${target}.`, { cause: error });
  }
  const observed = sha256(bytes);
  if (observed !== expectedSha256) {
    throw new Error(`Frozen agent archive SHA-256 ${observed} does not match ${expectedSha256}.`);
  }
  return target;
}

function batchPaths(outputDir, batchId) {
  const safeId = safePathPart(batchId);
  return {
    started: path.join(outputDir, `batch-${safeId}.started.json`),
    completed: path.join(outputDir, `batch-${safeId}.completed.json`),
    tasks: path.join(outputDir, `batch-${safeId}.tasks.json`)
  };
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Formal run state ${filePath} is unreadable.`, { cause: error });
  }
}

async function writeExclusiveJson(filePath, value) {
  const handle = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertBatchMarker(marker, kind, batch, manifest, preregistrationSha256) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)
    || marker.schemaVersion !== 1 || marker.kind !== kind
    || marker.formal_run_id !== manifest.formal_run_id
    || marker.consumption_identity_sha256 !== manifest.consumption_identity_sha256
    || marker.preregistration_sha256 !== preregistrationSha256
    || marker.batch !== batch.id
    || marker.task_selection_sha256 !== batch.task_selection_sha256) {
    throw new Error(`Formal batch ${batch.id} has a stale or malformed ${kind} receipt.`);
  }
}

function batchOperationallyComplete(record, batch) {
  const report = record?.report;
  const accounting = report?.trial_accounting;
  const expected = batch.task_indexes.length;
  return Boolean(report && report.incomplete_reason === null
    && record.docker_cleanup?.clean === true
    && Number(accounting?.expected) === expected
    && Number(accounting?.observed) === expected
    && Number(accounting?.missing) === 0
    && Number(accounting?.errored) === 0);
}

async function completedBatchRecords(outputDir, manifest, preregistrationSha256) {
  const records = [];
  let incompleteStarted = null;
  let incompleteCompleted = null;
  for (const batch of manifest.execution.batches) {
    const files = batchPaths(outputDir, batch.id);
    const [started, completed] = await Promise.all([
      readJsonIfPresent(files.started), readJsonIfPresent(files.completed)
    ]);
    if ((started || completed) && (incompleteStarted || incompleteCompleted)) {
      throw new Error("Formal batch receipts are not an append-only successful prefix of the preregistration.");
    }
    if (completed && !started) {
      throw new Error(`Formal batch ${batch.id} has a completion receipt without its started marker.`);
    }
    if (started) {
      assertBatchMarker(
        started, "SigmaFormalBatchStartedV1", batch, manifest, preregistrationSha256
      );
    }
    if (started && !completed) {
      incompleteStarted = batch.id;
      continue;
    }
    if (completed) {
      assertBatchMarker(
        completed, "SigmaFormalBatchCompletedV1", batch, manifest, preregistrationSha256
      );
      if (completed.started_at !== started.started_at) {
        throw new Error(`Formal batch ${batch.id} completion receipt does not bind its started marker.`);
      }
      records.push(completed);
      if (!batchOperationallyComplete(completed, batch)) incompleteCompleted = batch.id;
    }
  }
  return { records, incompleteStarted, incompleteCompleted };
}

function selectedTasks(manifest, batch) {
  return batch.task_indexes.map((index) => manifest.task_selection.tasks[index]);
}

function sumReports(reports, pathParts) {
  return reports.reduce((total, report) => {
    let value = report;
    for (const part of pathParts) value = value?.[part];
    const number = Number(value);
    return total + (Number.isFinite(number) ? number : 0);
  }, 0);
}

function aggregateNumericObjects(reports, key) {
  const keys = new Set(reports.flatMap((report) => Object.keys(report?.[key] ?? {})));
  return Object.fromEntries([...keys].sort().map((item) => [
    item, sumReports(reports, [key, item])
  ]));
}

function aggregateFailureCategories(reports) {
  const counts = {};
  for (const report of reports) {
    for (const task of report.tasks ?? []) {
      if (task.status === "passed") continue;
      const category = task.failure_category ?? "unknown";
      counts[category] = (counts[category] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

export function aggregateFormalReports(manifest, batchRecords) {
  const reports = batchRecords.map((record) => record.report).filter(Boolean);
  if (reports.length > 1) assertComparableBenchmarkReports(...reports);
  const tasks = batchRecords.flatMap((record) => (
    Array.isArray(record.report?.tasks)
      ? record.report.tasks.map((task) => ({ formal_batch: record.batch, ...task }))
      : []
  ));
  const expected = manifest.task_selection.tasks.length;
  const accounting = {
    expected,
    observed: sumReports(reports, ["trial_accounting", "observed"]),
    scored: sumReports(reports, ["trial_accounting", "scored"]),
    errored: sumReports(reports, ["trial_accounting", "errored"]),
    missing: sumReports(reports, ["trial_accounting", "missing"]),
    meanReward: null
  };
  const rewardTotal = reports.reduce((total, report) => (
    total + Number(report.trial_accounting?.meanReward ?? 0)
      * Number(report.trial_accounting?.scored ?? 0)
  ), 0);
  if (accounting.scored > 0) accounting.meanReward = rewardTotal / accounting.scored;
  const allBatchesRecorded = batchRecords.length === manifest.execution.batches.length;
  const executionComplete = allBatchesRecorded
    && reports.length === manifest.execution.batches.length
    && accounting.observed === expected
    && accounting.errored === 0
    && accounting.missing === 0
    && reports.every((report) => report.incomplete_reason === null)
    && batchRecords.every((record) => {
      const batch = manifest.execution.batches.find((item) => item.id === record.batch);
      return batch && batchOperationallyComplete(record, batch);
    });
  const status = allBatchesRecorded ? executionComplete ? "complete" : "incomplete" : "running";
  const usage = aggregateNumericObjects(reports, "usage");
  return {
    schemaVersion: 2,
    kind: "SigmaFormalRunReportV2",
    formal_run_id: manifest.formal_run_id,
    consumption_identity_sha256: manifest.consumption_identity_sha256,
    status,
    agent_profile: reports.find((report) => report.agent_profile)?.agent_profile ?? null,
    evaluation_lane: reports.find((report) => report.evaluation_lane)?.evaluation_lane ?? null,
    model: manifest.model,
    execution: manifest.execution,
    task_selection_sha256: manifest.task_selection.task_selection_sha256,
    batches: {
      expected: manifest.execution.batches.length,
      completed: batchRecords.length
    },
    trial_accounting: accounting,
    counts: aggregateNumericObjects(reports, "counts"),
    failure_categories: aggregateFailureCategories(reports),
    lane_metrics: laneMetrics(tasks, reports[0]?.evaluation_lane ?? null),
    usage,
    cost_usd: sumReports(reports, ["cost_usd"]),
    tasks
  };
}

function formalMarkdown(report) {
  const passCount = Number(report.counts?.passed ?? 0);
  const lines = [
    "# Sigma Formal Evaluation Report",
    "",
    `- Status: ${report.status}`,
    `- Formal run: ${report.formal_run_id}`,
    `- Preregistration SHA-256: ${report.preregistration_sha256 ?? "unavailable"}`,
    `- Model: ${report.model.provider}/${report.model.name}`,
    `- Completed batches: ${report.batches.completed}/${report.batches.expected}`,
    `- Observed trials: ${report.trial_accounting.observed}/${report.trial_accounting.expected}`,
    `- Verifier passes: ${passCount}`,
    `- Verifier reach/pass rate: ${report.lane_metrics.verifier_reached}/${report.lane_metrics.verifier_pass_rate ?? "n/a"}`,
    `- Counts: ${JSON.stringify(report.counts)}`,
    `- Failure categories: ${JSON.stringify(report.failure_categories)}`,
    `- Cost USD: ${report.cost_usd}`,
    ""
  ];
  return lines.join("\n");
}

async function writeFormalReport(outputDir, manifest, records, preregistrationSha256) {
  const report = aggregateFormalReports(manifest, records);
  report.preregistration_sha256 = preregistrationSha256;
  await writeJson(path.join(outputDir, "report.json"), report);
  await writeFile(path.join(outputDir, "report.md"), formalMarkdown(report), "utf8");
  await writeJson(path.join(outputDir, "state.json"), {
    schemaVersion: 2,
    kind: "SigmaFormalRunStateV2",
    formal_run_id: manifest.formal_run_id,
    consumption_identity_sha256: manifest.consumption_identity_sha256,
    preregistration_sha256: preregistrationSha256,
    status: report.status,
    completed_batches: records.map((record) => record.batch)
  });
  return report;
}

async function runBatch(manifest, batch, options, deps) {
  const files = batchPaths(options.outputDir, batch.id);
  await writeExclusiveJson(files.tasks, selectedTasks(manifest, batch));
  const runner = deps.runTerminalBenchCli ?? runTerminalBenchCli;
  return await runner([
    "--mode", "batch",
    "--tasks-file", files.tasks,
    "--dataset", manifest.task_selection.dataset,
    "--provider", manifest.model.provider,
    "--model", manifest.model.name,
    "--benchmark-class", manifest.solver_controls.benchmark_class,
    "--agent-profile", manifest.solver_controls.agent_profile,
    "--max-turns", String(manifest.solver_controls.max_turns),
    "--command-timeout-sec", String(manifest.solver_controls.command_timeout_sec),
    "--agent-timeout-grace-sec", String(manifest.solver_controls.cleanup_grace_sec),
    "--network", manifest.execution.network_mode,
    "--execution-mode", manifest.execution.execution_mode,
    "--managed-environment-mode", manifest.execution.managed_environment_mode,
    "--harbor-topology", manifest.execution.harbor_topology,
    "--concurrency", String(manifest.execution.concurrency),
    "--attempts", String(manifest.execution.attempts_per_task),
    "--retries", String(manifest.execution.retries),
    "--timeout-leniency-multiplier", "1",
    "--timeout-leniency-min-extra-sec", "0",
    "--run-label", `formal-${safePathPart(manifest.formal_run_id)}-${safePathPart(batch.id)}`,
    "--reuse-package",
    "--expected-archive-sha256", manifest.archive_sha256
  ], {
    ...(deps.terminalBenchDeps ?? {}),
    assertFrozenRunControls: (context) => assertFrozenBatchControls(manifest, batch, context)
  });
}

export async function runFormalBenchmark(argv = process.argv.slice(2), deps = {}) {
  const preliminary = formalOptions(argv);
  const bundle = await loadFormalPreregistration(
    preliminary.preregistrationFile, preliminary.expectedPreregistrationSha256
  );
  const manifest = bundle.manifest;
  const outputDir = preliminary.outputDir
    ?? path.join(benchRootDir, "formal", safePathPart(manifest.formal_run_id));
  const options = { ...preliminary, outputDir };
  const verifySource = deps.assertFormalSource ?? assertFormalSource;
  const verifyArchive = deps.assertFormalArchive ?? assertFormalArchive;
  await verifySource(manifest.source, rootDir);
  await verifyArchive(manifest.archive_sha256);
  await mkdir(outputDir, { recursive: true });

  const frozenPath = path.join(outputDir, "frozen-preregistration.json");
  const frozen = await readJsonIfPresent(frozenPath);
  if (frozen) {
    const validatedFrozen = validateFormalPreregistration(frozen, { baseDir: outputDir });
    if (validatedFrozen.consumption_identity_sha256 !== manifest.consumption_identity_sha256) {
      throw new Error("Formal output directory belongs to a different preregistration.");
    }
  } else {
    await writeExclusiveJson(frozenPath, manifest);
  }

  const history = await completedBatchRecords(outputDir, manifest, bundle.sha256);
  if (history.incompleteStarted) {
    throw new Error(
      `Formal batch ${history.incompleteStarted} was already started; retrying a consumed batch is prohibited.`
    );
  }
  if (history.incompleteCompleted) {
    throw new Error(
      `Formal batch ${history.incompleteCompleted} completed with infrastructure gaps; later batches are prohibited.`
    );
  }
  if (history.records.length > 0 && !options.resume) {
    throw new Error("Formal output already contains completed batches; pass --resume for the next frozen batch.");
  }
  const nextBatch = manifest.execution.batches[history.records.length];
  if (!nextBatch) throw new Error("All preregistered formal batches are already complete.");
  if (options.batchId !== nextBatch.id) {
    throw new Error(`The next preregistered batch is ${nextBatch.id}; received ${options.batchId}.`);
  }
  const files = batchPaths(outputDir, nextBatch.id);
  const started = {
    schemaVersion: 1,
    kind: "SigmaFormalBatchStartedV1",
    formal_run_id: manifest.formal_run_id,
    consumption_identity_sha256: manifest.consumption_identity_sha256,
    preregistration_sha256: bundle.sha256,
    batch: nextBatch.id,
    task_selection_sha256: nextBatch.task_selection_sha256,
    started_at: new Date().toISOString()
  };
  await writeExclusiveJson(files.started, started);
  const result = await (deps.runBatch ?? runBatch)(manifest, nextBatch, options, deps);
  const completed = {
    schemaVersion: 1,
    kind: "SigmaFormalBatchCompletedV1",
    formal_run_id: manifest.formal_run_id,
    consumption_identity_sha256: manifest.consumption_identity_sha256,
    preregistration_sha256: bundle.sha256,
    batch: nextBatch.id,
    task_selection_sha256: nextBatch.task_selection_sha256,
    started_at: started.started_at,
    finished_at: new Date().toISOString(),
    runner_exit_code: result.exitCode,
    run_dir: result.runDir,
    docker_cleanup: result.dockerCleanup ?? null,
    report: result.report ?? null
  };
  await writeExclusiveJson(files.completed, completed);
  const records = [...history.records, completed];
  const report = await writeFormalReport(outputDir, manifest, records, bundle.sha256);
  const batchComplete = batchOperationallyComplete(completed, nextBatch);
  return {
    options,
    manifest,
    report,
    completed,
    exitCode: batchComplete && report.status !== "incomplete" ? 0 : 1
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runFormalBenchmark().then((result) => {
    process.stdout.write(`Formal report: ${path.join(result.options.outputDir, "report.json")}\n`);
    process.exitCode = result.exitCode;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
