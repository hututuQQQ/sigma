import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertUniqueHarborTaskExecutionIdentities,
  harborTaskExecutionIdentitySha256,
  taskSelectionIdentity,
  taskSelectionIdentitySha256,
  validateExternalTaskRecord
} from "./harbor-task-identity.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_COMMIT = /^[a-f0-9]{40}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `${label} has an invalid field set (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"}).`
    );
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function identifier(value, label) {
  const text = requiredString(value, label);
  if (!IDENTIFIER.test(text)) throw new Error(`${label} is not a portable identifier.`);
  return text;
}

function digest(value, label, expression = SHA256) {
  const text = requiredString(value, label).toLowerCase();
  if (!expression.test(text)) throw new Error(`${label} is not a valid digest.`);
  return text;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function enumValue(value, allowed, label) {
  const text = requiredString(value, label);
  if (!allowed.includes(text)) throw new Error(`${label} must be one of: ${allowed.join(", ")}.`);
  return text;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256")
    .update(Buffer.isBuffer(value) ? value : String(value))
    .digest("hex");
}

export function formalSourceIdentitySha256(source) {
  return sha256(canonicalJson(source));
}

export function formalTaskSelectionSha256(tasks) {
  return sha256(canonicalJson(tasks.map(taskSelectionIdentity)));
}

export function formalPreregistrationConsumptionIdentity(manifest) {
  const { consumption_identity_sha256: _consumptionIdentity, ...payload } = manifest;
  return sha256(canonicalJson(payload));
}

function normalizedSource(value) {
  const source = record(value, "source");
  exactKeys(source, ["revision", "dirty", "diff_sha256"], "source");
  const revision = digest(source.revision, "source.revision", GIT_COMMIT);
  if (source.dirty !== false || source.diff_sha256 !== null) {
    throw new Error("Formal evaluation requires a clean committed source; dirty source snapshots are not replayable.");
  }
  return { revision, dirty: false, diff_sha256: null };
}

function normalizedModel(value) {
  const model = record(value, "model");
  exactKeys(model, ["provider", "name"], "model");
  return {
    provider: requiredString(model.provider, "model.provider"),
    name: requiredString(model.name, "model.name")
  };
}

function normalizedSolverControls(value) {
  const controls = record(value, "solver_controls");
  exactKeys(controls, [
    "benchmark_class", "agent_profile", "max_turns", "command_timeout_sec", "cleanup_grace_sec"
  ], "solver_controls");
  return {
    benchmark_class: enumValue(
      controls.benchmark_class, ["standard"], "solver_controls.benchmark_class"
    ),
    agent_profile: requiredString(controls.agent_profile, "solver_controls.agent_profile"),
    max_turns: positiveInteger(controls.max_turns, "solver_controls.max_turns"),
    command_timeout_sec: positiveInteger(
      controls.command_timeout_sec, "solver_controls.command_timeout_sec"
    ),
    cleanup_grace_sec: positiveInteger(
      controls.cleanup_grace_sec, "solver_controls.cleanup_grace_sec"
    )
  };
}

function normalizedTaskSelection(value, baseDir) {
  const selection = record(value, "task_selection");
  exactKeys(selection, [
    "dataset", "terminal_bench_revision", "tasks", "task_selection_sha256"
  ], "task_selection");
  if (!Array.isArray(selection.tasks) || selection.tasks.length === 0) {
    throw new Error("task_selection.tasks must be a non-empty array.");
  }
  const terminalBenchRevision = digest(
    selection.terminal_bench_revision, "task_selection.terminal_bench_revision", GIT_COMMIT
  );
  const tasks = selection.tasks.map((task, index) => validateExternalTaskRecord(task, index, baseDir));
  assertUniqueHarborTaskExecutionIdentities(tasks);
  if (tasks.some((task) => !task.git_url || task.git_commit_id !== terminalBenchRevision)) {
    throw new Error(
      "Formal task selections must use Git-backed task records pinned to terminal_bench_revision."
    );
  }
  const expectedDigest = formalTaskSelectionSha256(tasks);
  if (digest(selection.task_selection_sha256, "task_selection.task_selection_sha256") !== expectedDigest) {
    throw new Error("task_selection.task_selection_sha256 does not bind the normalized frozen tasks.");
  }
  return {
    dataset: requiredString(selection.dataset, "task_selection.dataset"),
    terminal_bench_revision: terminalBenchRevision,
    tasks,
    task_selection_sha256: expectedDigest
  };
}

function normalizedIndexes(value, taskCount, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array.`);
  const indexes = value.map((item, index) => {
    if (!Number.isSafeInteger(item) || item < 0 || item >= taskCount) {
      throw new Error(`${label}[${index}] is outside the frozen task selection.`);
    }
    return item;
  });
  if (new Set(indexes).size !== indexes.length || indexes.some((item, index) => index > 0 && item <= indexes[index - 1])) {
    throw new Error(`${label} must contain unique ascending task indexes.`);
  }
  return indexes;
}

function selectionForIndexes(tasks, indexes) {
  return indexes.map((index) => tasks[index]);
}

function normalizedTimeoutCohorts(value, batchIndexes, tasks, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array.`);
  const batchIndexSet = new Set(batchIndexes);
  const seen = new Set();
  const ids = new Set();
  const cohorts = value.map((item, index) => {
    const cohort = record(item, `${label}[${index}]`);
    exactKeys(cohort, [
      "id", "task_indexes", "effective_solver_timeout_sec", "task_selection_sha256"
    ], `${label}[${index}]`);
    const id = identifier(cohort.id, `${label}[${index}].id`);
    if (ids.has(id)) throw new Error(`${label} contains duplicate cohort id '${id}'.`);
    ids.add(id);
    const taskIndexes = normalizedIndexes(
      cohort.task_indexes, tasks.length, `${label}[${index}].task_indexes`
    );
    if (taskIndexes.some((taskIndex) => !batchIndexSet.has(taskIndex))) {
      throw new Error(`${label}[${index}] contains a task outside its batch.`);
    }
    for (const taskIndex of taskIndexes) {
      if (seen.has(taskIndex)) throw new Error(`${label} assigns a task to more than one timeout cohort.`);
      seen.add(taskIndex);
    }
    const selectedTasks = selectionForIndexes(tasks, taskIndexes);
    const selectionDigest = formalTaskSelectionSha256(selectedTasks);
    if (digest(cohort.task_selection_sha256, `${label}[${index}].task_selection_sha256`) !== selectionDigest) {
      throw new Error(`${label}[${index}] task selection digest is stale.`);
    }
    return {
      id,
      task_indexes: taskIndexes,
      effective_solver_timeout_sec: positiveInteger(
        cohort.effective_solver_timeout_sec, `${label}[${index}].effective_solver_timeout_sec`
      ),
      task_selection_sha256: selectionDigest
    };
  });
  if (seen.size !== batchIndexes.length || batchIndexes.some((taskIndex) => !seen.has(taskIndex))) {
    throw new Error(`${label} must partition every task in its batch exactly once.`);
  }
  return cohorts;
}

function normalizedBatches(value, tasks) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("execution.batches must be non-empty.");
  const ids = new Set();
  const seen = new Set();
  const batches = value.map((item, index) => {
    const batch = record(item, `execution.batches[${index}]`);
    exactKeys(batch, [
      "id", "task_indexes", "task_selection_sha256", "timeout_cohorts"
    ], `execution.batches[${index}]`);
    const id = identifier(batch.id, `execution.batches[${index}].id`);
    if (ids.has(id)) throw new Error(`execution.batches contains duplicate id '${id}'.`);
    ids.add(id);
    const taskIndexes = normalizedIndexes(
      batch.task_indexes, tasks.length, `execution.batches[${index}].task_indexes`
    );
    for (const taskIndex of taskIndexes) {
      if (seen.has(taskIndex)) throw new Error("execution.batches assigns a task more than once.");
      seen.add(taskIndex);
    }
    const selectionDigest = formalTaskSelectionSha256(selectionForIndexes(tasks, taskIndexes));
    if (digest(batch.task_selection_sha256, `execution.batches[${index}].task_selection_sha256`)
      !== selectionDigest) {
      throw new Error(`execution.batches[${index}] task selection digest is stale.`);
    }
    return {
      id,
      task_indexes: taskIndexes,
      task_selection_sha256: selectionDigest,
      timeout_cohorts: normalizedTimeoutCohorts(
        batch.timeout_cohorts, taskIndexes, tasks, `execution.batches[${index}].timeout_cohorts`
      )
    };
  });
  if (seen.size !== tasks.length || tasks.some((_task, index) => !seen.has(index))) {
    throw new Error("execution.batches must partition the complete frozen task selection exactly once.");
  }
  return batches;
}

function normalizedExecution(value, tasks) {
  const execution = record(value, "execution");
  exactKeys(execution, [
    "network_mode", "execution_mode", "managed_environment_mode", "harbor_topology",
    "concurrency", "attempts_per_task", "retries", "package_mode", "batches"
  ], "execution");
  const normalized = {
    network_mode: enumValue(execution.network_mode, ["none", "loopback", "full"], "execution.network_mode"),
    execution_mode: enumValue(
      execution.execution_mode, ["sandboxed", "container"], "execution.execution_mode"
    ),
    managed_environment_mode: enumValue(
      execution.managed_environment_mode, ["disabled", "required"], "execution.managed_environment_mode"
    ),
    harbor_topology: enumValue(
      execution.harbor_topology, ["main_only", "managed_three_role"], "execution.harbor_topology"
    ),
    concurrency: positiveInteger(execution.concurrency, "execution.concurrency"),
    attempts_per_task: execution.attempts_per_task,
    retries: execution.retries,
    package_mode: enumValue(execution.package_mode, ["reuse"], "execution.package_mode"),
    batches: normalizedBatches(execution.batches, tasks)
  };
  if (normalized.attempts_per_task !== 1 || normalized.retries !== 0) {
    throw new Error("Formal evaluation requires attempts_per_task=1 and retries=0.");
  }
  if (normalized.managed_environment_mode === "required"
    && (normalized.execution_mode !== "container" || normalized.network_mode !== "full"
      || normalized.harbor_topology !== "managed_three_role")) {
    throw new Error(
      "Required managed execution must use container/full/managed_three_role controls."
    );
  }
  if (normalized.harbor_topology === "managed_three_role"
    && normalized.managed_environment_mode !== "required") {
    throw new Error("The managed_three_role topology requires managed_environment_mode=required.");
  }
  return normalized;
}

/** Builds the immutable manifest from explicit caller-provided controls. It
 * fills only digests; it never supplies a dataset, model, quota, timeout, or
 * acceptance default. */
export function sigmaFormalRunPreregistrationV1(draft, options = {}) {
  const input = record(draft, "formal preregistration draft");
  exactKeys(input, [
    "formal_run_id", "source", "archive_sha256", "model", "task_selection",
    "solver_controls", "execution"
  ], "formal preregistration draft");
  const source = normalizedSource(input.source);
  const selectionDraft = record(input.task_selection, "task_selection");
  exactKeys(selectionDraft, ["dataset", "terminal_bench_revision", "tasks"], "task_selection");
  const terminalBenchRevision = digest(
    selectionDraft.terminal_bench_revision, "task_selection.terminal_bench_revision", GIT_COMMIT
  );
  if (!Array.isArray(selectionDraft.tasks) || selectionDraft.tasks.length === 0) {
    throw new Error("task_selection.tasks must be a non-empty array.");
  }
  const baseDir = path.resolve(options.baseDir ?? process.cwd());
  const tasks = selectionDraft.tasks.map((task, index) => validateExternalTaskRecord(task, index, baseDir));
  assertUniqueHarborTaskExecutionIdentities(tasks);
  if (tasks.some((task) => !task.git_url || task.git_commit_id !== terminalBenchRevision)) {
    throw new Error(
      "Formal task selections must use Git-backed task records pinned to terminal_bench_revision."
    );
  }
  const executionDraft = record(input.execution, "execution");
  exactKeys(executionDraft, [
    "network_mode", "execution_mode", "managed_environment_mode", "harbor_topology",
    "concurrency", "attempts_per_task", "retries", "package_mode", "batches"
  ], "execution");
  if (!Array.isArray(executionDraft.batches)) throw new Error("execution.batches must be an array.");
  const batches = executionDraft.batches.map((batchValue, batchIndex) => {
    const batch = record(batchValue, `execution.batches[${batchIndex}]`);
    exactKeys(batch, ["id", "task_indexes", "timeout_cohorts"], `execution.batches[${batchIndex}]`);
    const taskIndexes = normalizedIndexes(
      batch.task_indexes, tasks.length, `execution.batches[${batchIndex}].task_indexes`
    );
    if (!Array.isArray(batch.timeout_cohorts)) {
      throw new Error(`execution.batches[${batchIndex}].timeout_cohorts must be an array.`);
    }
    return {
      id: batch.id,
      task_indexes: taskIndexes,
      task_selection_sha256: formalTaskSelectionSha256(selectionForIndexes(tasks, taskIndexes)),
      timeout_cohorts: batch.timeout_cohorts.map((cohortValue, cohortIndex) => {
        const cohort = record(
          cohortValue, `execution.batches[${batchIndex}].timeout_cohorts[${cohortIndex}]`
        );
        exactKeys(
          cohort, ["id", "task_indexes", "effective_solver_timeout_sec"],
          `execution.batches[${batchIndex}].timeout_cohorts[${cohortIndex}]`
        );
        const cohortIndexes = normalizedIndexes(
          cohort.task_indexes,
          tasks.length,
          `execution.batches[${batchIndex}].timeout_cohorts[${cohortIndex}].task_indexes`
        );
        return {
          id: cohort.id,
          task_indexes: cohortIndexes,
          effective_solver_timeout_sec: cohort.effective_solver_timeout_sec,
          task_selection_sha256: formalTaskSelectionSha256(selectionForIndexes(tasks, cohortIndexes))
        };
      })
    };
  });
  const payload = {
    schemaVersion: 1,
    kind: "SigmaFormalRunPreregistrationV1",
    formal_run_id: identifier(input.formal_run_id, "formal_run_id"),
    source,
    source_identity_sha256: formalSourceIdentitySha256(source),
    archive_sha256: digest(input.archive_sha256, "archive_sha256"),
    model: normalizedModel(input.model),
    task_selection: {
      dataset: requiredString(selectionDraft.dataset, "task_selection.dataset"),
      terminal_bench_revision: terminalBenchRevision,
      tasks,
      task_selection_sha256: formalTaskSelectionSha256(tasks)
    },
    solver_controls: normalizedSolverControls(input.solver_controls),
    execution: normalizedExecution({ ...executionDraft, batches }, tasks)
  };
  const manifest = {
    ...payload,
    consumption_identity_sha256: formalPreregistrationConsumptionIdentity(payload)
  };
  return validateFormalPreregistration(manifest, { baseDir });
}

export function validateFormalPreregistration(input, options = {}) {
  const manifest = record(input, "formal preregistration");
  exactKeys(manifest, [
    "schemaVersion", "kind", "formal_run_id", "source", "source_identity_sha256",
    "archive_sha256", "model", "task_selection", "solver_controls", "execution",
    "consumption_identity_sha256"
  ], "formal preregistration");
  if (manifest.schemaVersion !== 1 || manifest.kind !== "SigmaFormalRunPreregistrationV1") {
    throw new Error("Formal evaluation requires SigmaFormalRunPreregistrationV1.");
  }
  const source = normalizedSource(manifest.source);
  const sourceIdentity = formalSourceIdentitySha256(source);
  if (digest(manifest.source_identity_sha256, "source_identity_sha256") !== sourceIdentity) {
    throw new Error("source_identity_sha256 does not bind the frozen source.");
  }
  const taskSelection = normalizedTaskSelection(
    manifest.task_selection, path.resolve(options.baseDir ?? process.cwd())
  );
  const normalized = {
    schemaVersion: 1,
    kind: "SigmaFormalRunPreregistrationV1",
    formal_run_id: identifier(manifest.formal_run_id, "formal_run_id"),
    source,
    source_identity_sha256: sourceIdentity,
    archive_sha256: digest(manifest.archive_sha256, "archive_sha256"),
    model: normalizedModel(manifest.model),
    task_selection: taskSelection,
    solver_controls: normalizedSolverControls(manifest.solver_controls),
    execution: normalizedExecution(manifest.execution, taskSelection.tasks),
    consumption_identity_sha256: digest(
      manifest.consumption_identity_sha256, "consumption_identity_sha256"
    )
  };
  if (formalPreregistrationConsumptionIdentity(normalized) !== normalized.consumption_identity_sha256) {
    throw new Error("consumption_identity_sha256 does not bind the complete formal run.");
  }
  return normalized;
}

export async function loadFormalPreregistration(filePath, expectedSha256) {
  const resolved = path.resolve(filePath);
  const bytes = await readFile(resolved);
  const observedSha256 = sha256(bytes);
  if (digest(expectedSha256, "--expected-preregistration-sha256") !== observedSha256) {
    throw new Error("Formal preregistration file does not match its expected SHA-256.");
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error("Formal preregistration is not valid JSON.", { cause: error });
  }
  return {
    manifest: validateFormalPreregistration(parsed, { baseDir: path.dirname(resolved) }),
    path: resolved,
    sha256: observedSha256
  };
}

function expectedTimeouts(manifest, batch) {
  const result = new Map();
  for (const cohort of batch.timeout_cohorts) {
    for (const taskIndex of cohort.task_indexes) {
      result.set(
        taskSelectionIdentitySha256(manifest.task_selection.tasks[taskIndex]),
        cohort.effective_solver_timeout_sec
      );
    }
  }
  return result;
}

function taskNetworkMode(value) {
  if (value === "public") return "full";
  if (value === "no-network") return "none";
  if (value === "allowlist") return "allowlist";
  return null;
}

export function assertFrozenBatchControls(manifest, batch, context) {
  const { execution, model, solver_controls: solver } = manifest;
  const options = context?.options;
  if (!options || options.provider !== model.provider || options.model !== model.name
    || options.dataset !== manifest.task_selection.dataset
    || options.benchmarkClass !== solver.benchmark_class
    || options.agentProfile !== solver.agent_profile || options.maxTurns !== solver.max_turns
    || options.commandTimeoutSec !== solver.command_timeout_sec
    || options.agentTimeoutGraceSec !== solver.cleanup_grace_sec
    || options.networkMode !== execution.network_mode
    || options.executionMode !== execution.execution_mode
    || options.managedEnvironmentMode !== execution.managed_environment_mode
    || options.harborTopology !== execution.harbor_topology
    || options.nConcurrentTrials !== execution.concurrency
    || options.attemptsPerTask !== execution.attempts_per_task
    || options.retries !== execution.retries) {
    throw new Error("Resolved runner controls drifted from the formal preregistration.");
  }
  const expectedTasks = selectionForIndexes(manifest.task_selection.tasks, batch.task_indexes);
  const expectedBySelection = expectedTimeouts(manifest, batch);
  if (!Array.isArray(context.slots) || context.slots.length !== expectedTasks.length) {
    throw new Error("Harbor timeout probe did not resolve every frozen formal task.");
  }
  const observed = new Set();
  for (const slot of context.slots) {
    if (!SHA256.test(String(slot.jobConfigSha256 ?? ""))) {
      throw new Error("A formal Harbor slot lacks its frozen JobConfig digest.");
    }
    const selectionDigest = taskSelectionIdentitySha256(slot.task);
    if (observed.has(selectionDigest) || !expectedBySelection.has(selectionDigest)) {
      throw new Error("Harbor resolved a duplicate or unregistered formal task identity.");
    }
    observed.add(selectionDigest);
    const expectedTimeout = expectedBySelection.get(selectionDigest);
    if (slot.timeoutPlan?.agent_wall_time_sec !== expectedTimeout) {
      throw new Error("Harbor task timeout metadata drifted from the frozen solver deadline.");
    }
    const probeNetwork = taskNetworkMode(slot.taskProbe?.tasks?.[0]?.network_mode);
    if (probeNetwork === null || probeNetwork !== execution.network_mode) {
      throw new Error("Harbor task network metadata is missing or conflicts with the frozen network mode.");
    }
    if (!slot.resolvedTask || harborTaskExecutionIdentitySha256(slot.resolvedTask)
      !== harborTaskExecutionIdentitySha256(slot.task)) {
      throw new Error("Harbor resolved task identity differs from the frozen execution identity.");
    }
  }
}

function cliFlags(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== "--draft" && token !== "--output") {
      throw new Error(`Unsupported preregistration argument '${token}'.`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
    result[token.slice(2)] = value;
    index += 1;
  }
  return result;
}

export async function writeFormalPreregistration(draftPath, outputPath) {
  const resolvedDraft = path.resolve(requiredString(draftPath, "--draft"));
  const resolvedOutput = path.resolve(requiredString(outputPath, "--output"));
  let draft;
  try {
    draft = JSON.parse(await readFile(resolvedDraft, "utf8"));
  } catch (error) {
    throw new Error("Formal preregistration draft is not valid JSON.", { cause: error });
  }
  const manifest = sigmaFormalRunPreregistrationV1(draft, {
    baseDir: path.dirname(resolvedDraft)
  });
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const handle = await open(
    resolvedOutput,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600
  );
  try {
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { manifest, path: resolvedOutput, sha256: sha256(bytes) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let flags;
  try {
    flags = cliFlags(process.argv.slice(2));
    const result = await writeFormalPreregistration(flags.draft, flags.output);
    process.stdout.write(`${JSON.stringify({ path: result.path, sha256: result.sha256 })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
