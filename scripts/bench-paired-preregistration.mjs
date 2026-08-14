#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertUniqueHarborTaskExecutionIdentities,
  taskSelectionIdentity,
  taskSelectionIdentitySha256,
  validateExternalTaskRecord
} from "./harbor-task-identity.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_COMMIT = /^[a-f0-9]{40}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REASONING = new Set(["auto", "none", "low", "medium", "high", "xhigh", "max"]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function exact(value, keys, label) {
  const expected = new Set(keys);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`${label} has an invalid field set (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"}).`);
  }
}

function string(value, label, expression = null) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  const text = value.trim();
  if (expression && !expression.test(text)) throw new Error(`${label} has an invalid format.`);
  return text;
}

function digest(value, label, expression = SHA256) {
  return string(value, label, expression).toLowerCase();
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function pairedSha256(value) {
  return createHash("sha256").update(Buffer.isBuffer(value) ? value : String(value)).digest("hex");
}

export function canonicalPairedJson(value) {
  return canonical(value);
}

function normalizedRuntime(value, harness, label) {
  const runtime = object(value, label);
  exact(runtime, ["archive_path", "archive_sha256", "version", "layout"], label);
  const archivePath = string(runtime.archive_path, `${label}.archive_path`);
  if (path.isAbsolute(archivePath)) {
    throw new Error(`${label}.archive_path must be relative to the preregistration.`);
  }
  const version = runtime.version === null ? null : string(runtime.version, `${label}.version`);
  const layouts = harness === "codex" ? ["npm-linux-x64", "portable-root"] : ["sigma-agent-cli"];
  const layout = string(runtime.layout, `${label}.layout`);
  if (!layouts.includes(layout)) throw new Error(`${label}.layout is not supported for ${harness}.`);
  if (harness === "codex" && version === null) throw new Error(`${label}.version is required for Codex.`);
  return {
    archive_path: archivePath.replaceAll("\\", "/"),
    archive_sha256: digest(runtime.archive_sha256, `${label}.archive_sha256`),
    version,
    layout
  };
}

function normalizedArms(value) {
  if (!Array.isArray(value) || value.length !== 2) throw new Error("arms must contain exactly two entries.");
  const arms = value.map((item, index) => {
    const arm = object(item, `arms[${index}]`);
    exact(arm, ["id", "harness", "runtime"], `arms[${index}]`);
    const harness = string(arm.harness, `arms[${index}].harness`);
    if (!["sigma", "codex"].includes(harness)) throw new Error(`arms[${index}].harness is unsupported.`);
    return {
      id: string(arm.id, `arms[${index}].id`, IDENTIFIER),
      harness,
      runtime: normalizedRuntime(arm.runtime, harness, `arms[${index}].runtime`)
    };
  });
  if (new Set(arms.map((arm) => arm.id)).size !== 2) throw new Error("arm ids must be unique.");
  return arms;
}

function normalizedModel(value) {
  const model = object(value, "model");
  exact(model, ["provider", "name", "reasoning_effort"], "model");
  const reasoning = string(model.reasoning_effort, "model.reasoning_effort");
  if (!REASONING.has(reasoning)) throw new Error("model.reasoning_effort is invalid.");
  return {
    provider: string(model.provider, "model.provider"),
    name: string(model.name, "model.name"),
    reasoning_effort: reasoning
  };
}

function catalogIdentity(tasks) {
  return tasks.map((task) => taskSelectionIdentity(task))
    .sort((left, right) => canonical(left).localeCompare(canonical(right)));
}

export function pairedTaskCatalogSha256(tasks) {
  return pairedSha256(canonical(catalogIdentity(tasks)));
}

function normalizedCatalog(value, baseDir) {
  const catalog = object(value, "task_catalog");
  exact(catalog, ["dataset", "revision", "tasks"], "task_catalog");
  if (!Array.isArray(catalog.tasks) || catalog.tasks.length < 2) {
    throw new Error("task_catalog.tasks must contain at least two tasks.");
  }
  const revision = digest(catalog.revision, "task_catalog.revision", GIT_COMMIT);
  const tasks = catalog.tasks.map((task, index) => validateExternalTaskRecord(task, index, baseDir));
  assertUniqueHarborTaskExecutionIdentities(tasks);
  if (tasks.some((task) => task.git_commit_id !== revision)) {
    throw new Error("Every catalog task must be pinned to task_catalog.revision.");
  }
  return {
    dataset: string(catalog.dataset, "task_catalog.dataset"),
    revision,
    tasks,
    task_count: tasks.length,
    task_catalog_sha256: pairedTaskCatalogSha256(tasks)
  };
}

function normalizedSelection(value, catalog) {
  const selection = object(value, "selection");
  exact(selection, ["method", "seed", "sample_size"], "selection");
  if (selection.method !== "sha256_rank_v1") throw new Error("selection.method must be sha256_rank_v1.");
  const seed = string(selection.seed, "selection.seed");
  const sampleSize = positiveInteger(selection.sample_size, "selection.sample_size", catalog.tasks.length);
  const ranked = catalog.tasks.map((task) => {
    const identity = taskSelectionIdentitySha256(task);
    return { task, identity, rank: pairedSha256(`${seed}\0${identity}`) };
  }).sort((left, right) => left.rank.localeCompare(right.rank) || left.identity.localeCompare(right.identity));
  const tasks = ranked.slice(0, sampleSize).map((item) => item.task);
  return {
    method: "sha256_rank_v1",
    seed,
    sample_size: sampleSize,
    selected_tasks: tasks,
    selected_task_identity_sha256: pairedSha256(canonical(tasks.map(taskSelectionIdentity)))
  };
}

function enumValue(value, allowed, label) {
  const text = string(value, label);
  if (!allowed.includes(text)) throw new Error(`${label} must be one of: ${allowed.join(", ")}.`);
  return text;
}

function normalizedControls(value) {
  const controls = object(value, "controls");
  exact(controls, [
    "benchmark_class", "agent_profile", "max_turns", "command_timeout_sec",
    "cleanup_grace_sec", "network_mode", "execution_mode", "write_scope",
    "managed_environment_mode", "harbor_topology"
  ], "controls");
  const normalized = {
    benchmark_class: enumValue(controls.benchmark_class, ["standard"], "controls.benchmark_class"),
    agent_profile: enumValue(controls.agent_profile, ["standard", "strict"], "controls.agent_profile"),
    max_turns: positiveInteger(controls.max_turns, "controls.max_turns", 10_000),
    command_timeout_sec: positiveInteger(controls.command_timeout_sec, "controls.command_timeout_sec", 600),
    cleanup_grace_sec: positiveInteger(controls.cleanup_grace_sec, "controls.cleanup_grace_sec", 3_600),
    network_mode: enumValue(controls.network_mode, ["none", "loopback", "full"], "controls.network_mode"),
    execution_mode: enumValue(controls.execution_mode, ["sandboxed", "container"], "controls.execution_mode"),
    write_scope: enumValue(controls.write_scope, ["auto", "workspace", "enclosing-container"], "controls.write_scope"),
    managed_environment_mode: enumValue(controls.managed_environment_mode, ["disabled", "required"], "controls.managed_environment_mode"),
    harbor_topology: enumValue(controls.harbor_topology, ["main_only", "managed_three_role"], "controls.harbor_topology")
  };
  if (normalized.managed_environment_mode === "required"
    && (normalized.execution_mode !== "container" || normalized.network_mode !== "full"
      || normalized.harbor_topology !== "managed_three_role")) {
    throw new Error("Required managed execution needs container/full/managed_three_role controls.");
  }
  if (normalized.harbor_topology === "managed_three_role"
    && normalized.managed_environment_mode !== "required") {
    throw new Error("managed_three_role requires managed_environment_mode=required.");
  }
  return normalized;
}

function normalizedRamp(value, sampleSize) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("execution.ramp_task_counts must be non-empty.");
  const counts = value.map((item, index) => positiveInteger(
    item, `execution.ramp_task_counts[${index}]`, sampleSize
  ));
  if (counts.some((item, index) => index > 0 && item <= counts[index - 1])
    || counts.at(-1) !== sampleSize) {
    throw new Error("execution.ramp_task_counts must be strictly increasing and end at sample_size.");
  }
  return counts;
}

function pairedOrder(arms, taskIndex, repetition) {
  return (taskIndex + repetition) % 2 === 0
    ? [arms[0].id, arms[1].id]
    : [arms[1].id, arms[0].id];
}

function derivedStages(arms, sampleSize, repetitions, ramp) {
  const stages = [];
  let previous = 0;
  for (const count of ramp) {
    stages.push({
      id: `r1-t${String(previous + 1).padStart(2, "0")}-${String(count).padStart(2, "0")}`,
      pairs: Array.from({ length: count - previous }, (_unused, offset) => {
        const taskIndex = previous + offset;
        return { task_index: taskIndex, repetition: 1, arms: pairedOrder(arms, taskIndex, 1) };
      })
    });
    previous = count;
  }
  for (let repetition = 2; repetition <= repetitions; repetition += 1) {
    stages.push({
      id: `r${repetition}-all`,
      pairs: Array.from({ length: sampleSize }, (_unused, taskIndex) => ({
        task_index: taskIndex,
        repetition,
        arms: pairedOrder(arms, taskIndex, repetition)
      }))
    });
  }
  return stages;
}

function normalizedExecution(value, arms, selection) {
  const execution = object(value, "execution");
  exact(execution, ["repetitions", "concurrency", "retries", "ramp_task_counts"], "execution");
  const repetitions = positiveInteger(execution.repetitions, "execution.repetitions", 100);
  const concurrency = positiveInteger(execution.concurrency, "execution.concurrency", 64);
  if (execution.retries !== 0) throw new Error("Paired experiments require retries=0.");
  const ramp = normalizedRamp(execution.ramp_task_counts, selection.sample_size);
  return {
    repetitions,
    concurrency,
    retries: 0,
    ramp_task_counts: ramp,
    stages: derivedStages(arms, selection.sample_size, repetitions, ramp),
    expected_attempts: selection.sample_size * repetitions * arms.length
  };
}

function payloadFromDraft(draft, baseDir) {
  const input = object(draft, "paired experiment draft");
  exact(input, [
    "experiment_id", "arms", "model", "task_catalog", "selection", "controls", "execution"
  ], "paired experiment draft");
  const arms = normalizedArms(input.arms);
  const catalog = normalizedCatalog(input.task_catalog, baseDir);
  const selection = normalizedSelection(input.selection, catalog);
  return {
    schemaVersion: 1,
    kind: "PairedHarnessExperiment",
    experiment_id: string(input.experiment_id, "experiment_id", IDENTIFIER),
    arms,
    model: normalizedModel(input.model),
    task_catalog: catalog,
    selection,
    controls: normalizedControls(input.controls),
    execution: normalizedExecution(input.execution, arms, selection),
    stop_loss: {
      score_independent: true,
      verifier_feedback_to_solver: false,
      retry_consumed_attempts: false,
      blocking_conditions: [
        "control_drift", "missing_or_incomplete_report", "infra_failed_attempt",
        "credential_or_provider_unavailable", "dirty_runtime_or_docker_cleanup"
      ]
    }
  };
}

export function pairedExperimentPreregistration(draft, options = {}) {
  const payload = payloadFromDraft(draft, path.resolve(options.baseDir ?? process.cwd()));
  return {
    ...payload,
    consumption_identity_sha256: pairedSha256(canonical(payload))
  };
}

export function validatePairedExperiment(value, options = {}) {
  const manifest = object(value, "paired experiment");
  exact(manifest, [
    "schemaVersion", "kind", "experiment_id", "arms", "model", "task_catalog", "selection",
    "controls", "execution", "stop_loss", "consumption_identity_sha256"
  ], "paired experiment");
  if (manifest.schemaVersion !== 1 || manifest.kind !== "PairedHarnessExperiment") {
    throw new Error("Unsupported paired experiment schema.");
  }
  const draft = {
    experiment_id: manifest.experiment_id,
    arms: manifest.arms,
    model: manifest.model,
    task_catalog: {
      dataset: manifest.task_catalog?.dataset,
      revision: manifest.task_catalog?.revision,
      tasks: manifest.task_catalog?.tasks
    },
    selection: {
      method: manifest.selection?.method,
      seed: manifest.selection?.seed,
      sample_size: manifest.selection?.sample_size
    },
    controls: manifest.controls,
    execution: {
      repetitions: manifest.execution?.repetitions,
      concurrency: manifest.execution?.concurrency,
      retries: manifest.execution?.retries,
      ramp_task_counts: manifest.execution?.ramp_task_counts
    }
  };
  const expected = pairedExperimentPreregistration(draft, options);
  if (canonical(expected) !== canonical(manifest)) {
    throw new Error("Paired experiment derived fields or consumption identity are stale.");
  }
  return expected;
}

export async function loadPairedExperiment(filePath, expectedSha256) {
  const resolved = path.resolve(filePath);
  const bytes = await readFile(resolved);
  if (digest(expectedSha256, "--expected-preregistration-sha256") !== pairedSha256(bytes)) {
    throw new Error("Paired preregistration file does not match its expected SHA-256.");
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error("Paired preregistration is not valid JSON.", { cause: error });
  }
  return {
    manifest: validatePairedExperiment(parsed, { baseDir: path.dirname(resolved) }),
    path: resolved,
    sha256: pairedSha256(bytes)
  };
}

async function writePreregistration(draftPath, outputPath) {
  const draftFile = path.resolve(string(draftPath, "--draft"));
  const outputFile = path.resolve(string(outputPath, "--output"));
  const draft = JSON.parse(await readFile(draftFile, "utf8"));
  const manifest = pairedExperimentPreregistration(draft, { baseDir: path.dirname(draftFile) });
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const handle = await open(outputFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { path: outputFile, sha256: pairedSha256(bytes), manifest };
}

function cliOptions(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!["--draft", "--output"].includes(name)) throw new Error(`Unsupported option: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
    flags[name.slice(2)] = value;
    index += 1;
  }
  return flags;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const flags = cliOptions(process.argv.slice(2));
  writePreregistration(flags.draft, flags.output).then((result) => {
    process.stdout.write(`${JSON.stringify({ path: result.path, sha256: result.sha256 })}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
