#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertComparableBenchmarkReports,
  benchRootDir,
  laneMetrics,
  parseArgs,
  safePathPart,
  writeJson
} from "./bench-common.mjs";
import { runTerminalBenchCli } from "./bench-terminal-bench.mjs";

const COUNT_KEYS = ["passed", "failed", "infra_failed", "timeout", "api_error", "unknown"];
const FAILURE_CATEGORIES = [
  "verifier_failed", "agent_setup_failed", "agent_timeout", "api_error", "agent_crashed", "unknown"
];

function positiveInteger(value, fallback, name) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} is required.`);
  return value.trim();
}

function digest(value, name, length) {
  const text = requiredString(value, name).toLowerCase();
  if (!new RegExp(`^[a-f0-9]{${length}}$`, "u").test(text)) {
    throw new Error(`${name} must be a ${length}-character lowercase hexadecimal digest.`);
  }
  return text;
}

function portableTaskPath(value, label) {
  const text = requiredString(value, label).replaceAll("\\", "/");
  if (path.posix.isAbsolute(text) || text.split("/").includes("..")) {
    throw new Error(`${label} must be a portable relative path.`);
  }
  return text;
}

function taskRecord(task, plan, batchIndex, taskIndex) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new Error(`batches[${batchIndex}].tasks[${taskIndex}] must be an object.`);
  }
  const taskPath = portableTaskPath(
    task.task_path ?? task.path,
    `batches[${batchIndex}].tasks[${taskIndex}].task_path`
  );
  return {
    path: taskPath,
    git_url: plan.taskRepo,
    git_commit_id: plan.taskCommit,
    source: plan.source
  };
}

export function validateFormalPlan(input, options) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Formal plan must be an object.");
  const taskCommit = digest(input.task_commit, "plan.task_commit", 40);
  if (taskCommit !== options.taskCommit) throw new Error("Formal plan task commit does not match --task-commit.");
  const normalized = {
    taskRepo: requiredString(input.task_repo, "plan.task_repo"),
    taskCommit,
    source: safePathPart(input.benchmark ?? "external-task-plan"),
    batches: []
  };
  if (!Array.isArray(input.batches) || input.batches.length !== options.expectedBatches) {
    throw new Error(`Formal plan must contain exactly ${options.expectedBatches} batches.`);
  }
  normalized.batches = input.batches.map((batch, batchIndex) => {
    if (!batch || !Array.isArray(batch.tasks)) throw new Error(`batches[${batchIndex}].tasks must be an array.`);
    const expectedSize = batchIndex === input.batches.length - 1
      ? options.expectedTasks - options.batchSize * (options.expectedBatches - 1)
      : options.batchSize;
    if (batch.tasks.length !== expectedSize) {
      throw new Error(`Batch ${batchIndex + 1} must contain exactly ${expectedSize} tasks.`);
    }
    return {
      id: String(batch.batch ?? batchIndex + 1).padStart(3, "0"),
      tasks: batch.tasks.map((task, taskIndex) => taskRecord(task, normalized, batchIndex, taskIndex))
    };
  });
  const tasks = normalized.batches.flatMap((batch) => batch.tasks);
  if (tasks.length !== options.expectedTasks) throw new Error("Formal plan task count mismatch.");
  const identities = tasks.map((task) => `${task.git_url}\0${task.git_commit_id}\0${task.path}`);
  if (new Set(identities).size !== identities.length) throw new Error("Formal plan contains duplicate tasks.");
  return normalized;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function aggregateCounts(reports) {
  return Object.fromEntries(COUNT_KEYS.map((key) => [
    key, reports.reduce((total, report) => total + number(report.counts?.[key]), 0)
  ]));
}

function categoryCounts(tasks) {
  const counts = Object.fromEntries(FAILURE_CATEGORIES.map((key) => [key, 0]));
  for (const task of tasks.filter((item) => item.status !== "passed")) {
    const category = Object.hasOwn(counts, task.failure_category) ? task.failure_category : "unknown";
    counts[category] += 1;
  }
  return counts;
}

export function aggregateFormalReports(plan, batchRecords, minimumPasses) {
  const reports = batchRecords.map((record) => record.report).filter(Boolean);
  assertComparableBenchmarkReports(...reports);
  const agentProfile = reports.find((report) => report.agent_profile)?.agent_profile ?? null;
  const evaluationLane = reports.find((report) => report.evaluation_lane)?.evaluation_lane ?? null;
  const tasks = batchRecords.flatMap((record) => (
    record.report?.tasks ?? []
  ).map((task) => ({ batch: record.batch, ...task })));
  const accounting = {
    expected: plan.batches.reduce((total, batch) => total + batch.tasks.length, 0),
    observed: reports.reduce((total, report) => total + number(report.trial_accounting?.observed), 0),
    scored: reports.reduce((total, report) => total + number(report.trial_accounting?.scored), 0),
    errored: reports.reduce((total, report) => total + number(report.trial_accounting?.errored), 0),
    missing: reports.reduce((total, report) => total + number(report.trial_accounting?.missing), 0),
    meanReward: null
  };
  const rewardTotal = reports.reduce((total, report) => (
    total + number(report.trial_accounting?.meanReward) * number(report.trial_accounting?.scored)
  ), 0);
  if (accounting.scored > 0) accounting.meanReward = rewardTotal / accounting.scored;
  const counts = aggregateCounts(reports);
  const usage = reports.reduce((total, report) => ({
    input_tokens: total.input_tokens + number(report.usage?.input_tokens),
    cache_tokens: total.cache_tokens + number(report.usage?.cache_tokens),
    output_tokens: total.output_tokens + number(report.usage?.output_tokens)
  }), { input_tokens: 0, cache_tokens: 0, output_tokens: 0 });
  const complete = batchRecords.length === plan.batches.length
    && reports.length === plan.batches.length
    && accounting.observed === accounting.expected
    && accounting.missing === 0
    && reports.every((report) => report.incomplete_reason === null);
  return {
    schemaVersion: 1,
    status: complete ? "complete" : "incomplete",
    acceptance: complete && counts.passed >= minimumPasses ? "passed" : "failed",
    agent_profile: agentProfile,
    evaluation_lane: evaluationLane,
    lane_metrics: laneMetrics(tasks, evaluationLane),
    minimum_passes: minimumPasses,
    batches: { expected: plan.batches.length, completed: reports.length },
    trial_accounting: accounting,
    counts,
    failure_categories: categoryCounts(tasks),
    usage,
    cost_usd: reports.reduce((total, report) => total + number(report.cost_usd), 0),
    tasks
  };
}

function formalMarkdown(report) {
  return [
    "# Sigma Formal Benchmark Report", "",
    `- Status: ${report.status}`,
    `- Acceptance: ${report.acceptance}`,
    `- Agent profile: ${report.agent_profile ?? "unknown"}`,
    `- Evaluation lane: ${report.evaluation_lane ?? "unknown"}`,
    `- Lane metrics: ${JSON.stringify(report.lane_metrics)}`,
    `- Passed: ${report.counts.passed}/${report.trial_accounting.expected}`,
    `- Missing: ${report.trial_accounting.missing}`,
    `- Verifier failed: ${report.failure_categories.verifier_failed}`,
    `- Setup error: ${report.failure_categories.agent_setup_failed}`,
    `- Timeout: ${report.failure_categories.agent_timeout}`,
    `- API error: ${report.failure_categories.api_error}`,
    `- Agent crash: ${report.failure_categories.agent_crashed}`,
    `- Input/cache/output tokens: ${report.usage.input_tokens}/${report.usage.cache_tokens}/${report.usage.output_tokens}`,
    `- Cost USD: ${report.cost_usd}`, ""
  ].join("\n");
}

function formalOptions(argv) {
  const flags = parseArgs(argv);
  const now = new Date().toISOString().replace(/[-:]/gu, "").replace(/\..+$/u, "Z");
  return {
    planPath: path.resolve(requiredString(flags.plan, "--plan")),
    taskCommit: digest(flags["task-commit"], "--task-commit", 40),
    archiveSha256: digest(flags["archive-sha256"], "--archive-sha256", 64),
    expectedTasks: positiveInteger(flags["expected-tasks"], 89, "--expected-tasks"),
    expectedBatches: positiveInteger(flags["expected-batches"], 18, "--expected-batches"),
    batchSize: positiveInteger(flags["batch-size"], 5, "--batch-size"),
    minimumPasses: positiveInteger(flags["minimum-passes"], 55, "--minimum-passes"),
    concurrency: positiveInteger(flags.concurrency, 5, "--concurrency"),
    provider: String(flags.provider ?? "deepseek"),
    model: String(flags.model ?? "deepseek-v4-pro"),
    outputDir: path.resolve(flags.output ?? path.join(benchRootDir, "formal", now)),
    resume: flags.resume === true,
    batchId: requiredString(flags.batch, "--batch").padStart(3, "0")
  };
}

async function initialState(options, planSha256) {
  const statePath = path.join(options.outputDir, "state.json");
  if (!existsSync(statePath)) {
    return {
      schemaVersion: 1, status: "running", plan_sha256: planSha256,
      task_commit: options.taskCommit, archive_sha256: options.archiveSha256,
      provider: options.provider, model: options.model, concurrency: options.concurrency, batches: []
    };
  }
  if (!options.resume) throw new Error("Formal output already exists; pass --resume to continue missing batches only.");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (state.plan_sha256 !== planSha256 || state.task_commit !== options.taskCommit
    || state.archive_sha256 !== options.archiveSha256) {
    throw new Error("Formal resume state does not match the frozen plan or artifacts.");
  }
  if (state.batches.some((batch) => batch.status !== "completed")) {
    throw new Error("Formal state contains an interrupted batch; retrying it is prohibited.");
  }
  return state;
}

async function runBatch(plan, batch, options) {
  const tasksPath = path.join(options.outputDir, `batch-${batch.id}.tasks.json`);
  await writeJson(tasksPath, batch.tasks);
  return await runTerminalBenchCli([
    "--mode", "batch", "--tasks-file", tasksPath,
    "--provider", options.provider, "--model", options.model,
    "--concurrency", String(options.concurrency), "--run-label", `formal-${batch.id}`,
    "--timeout-leniency-multiplier", "1", "--timeout-leniency-min-extra-sec", "0",
    "--reuse-package", "--expected-archive-sha256", options.archiveSha256
  ]);
}

export async function runFormalBenchmark(argv = process.argv.slice(2), deps = {}) {
  const options = formalOptions(argv);
  const planBytes = await readFile(options.planPath);
  const planSha256 = createHash("sha256").update(planBytes).digest("hex");
  const plan = validateFormalPlan(JSON.parse(planBytes), options);
  await mkdir(options.outputDir, { recursive: true });
  const state = await initialState(options, planSha256);
  await writeJson(path.join(options.outputDir, "frozen-plan.json"), plan);
  await writeJson(path.join(options.outputDir, "state.json"), state);
  const runBatchImpl = deps.runBatch ?? runBatch;
  const batch = plan.batches[state.batches.length];
  if (!batch) throw new Error("All formal batches are already complete.");
  if (batch.id !== options.batchId) {
    throw new Error(`The next formal batch is ${batch.id}; received --batch ${options.batchId}.`);
  }
  const started = { batch: batch.id, status: "started", started_at: new Date().toISOString() };
  state.batches.push(started);
  await writeJson(path.join(options.outputDir, "state.json"), state);
  await writeJson(path.join(options.outputDir, "active-batch.json"), started);
  const result = await runBatchImpl(plan, batch, options);
  const completed = {
    batch: batch.id, status: "completed", started_at: started.started_at,
    finished_at: new Date().toISOString(), runner_exit_code: result.exitCode,
    run_dir: result.runDir, report: result.report,
    docker_cleanup: result.dockerCleanup ?? null
  };
  state.batches[state.batches.length - 1] = completed;
  state.status = state.batches.length === plan.batches.length ? "complete" : "running";
  await writeJson(path.join(options.outputDir, "state.json"), state);
  await writeJson(path.join(options.outputDir, "active-batch.json"), completed);
  const report = aggregateFormalReports(plan, state.batches, options.minimumPasses);
  await writeJson(path.join(options.outputDir, "report.json"), report);
  await writeFile(path.join(options.outputDir, "report.md"), formalMarkdown(report), "utf8");
  const exitCode = state.status === "complete"
    ? report.acceptance === "passed" ? 0 : 1
    : result.exitCode;
  return { options, plan, state, report, exitCode };
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
