#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertUniqueHarborTaskExecutionIdentities,
  taskSelectionIdentitySha256,
  validateExternalTaskRecord
} from "./harbor-task-identity.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_COMMIT = /^[a-f0-9]{40}$/u;
export const FORMAL_AB_DATASET = "terminal-bench/terminal-bench-2-1";
export const FORMAL_AB_TASK_COUNT = 89;

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function exact(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} has an invalid field set.`);
  }
}

function string(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function digest(value, label, expression = SHA256) {
  const normalized = string(value, label).toLowerCase();
  if (!expression.test(normalized)) throw new Error(`${label} is not a valid digest.`);
  return normalized;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

export function canonicalAbJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalAbJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalAbJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function formalAbSha256(value) {
  return createHash("sha256").update(
    Buffer.isBuffer(value) ? value : String(value)
  ).digest("hex");
}

function normalizedArm(value, label, candidate) {
  const arm = object(value, label);
  exact(arm, ["source_revision", "archive_sha256", "compiler_digest"], label);
  const compilerDigest = arm.compiler_digest === null
    ? null : digest(arm.compiler_digest, `${label}.compiler_digest`);
  if (candidate && compilerDigest === null) {
    throw new Error("Candidate arm must bind its compiled Harness digest.");
  }
  if (!candidate && compilerDigest !== null) {
    throw new Error("The preserved main baseline predates the Harness compiler digest.");
  }
  return {
    source_revision: digest(arm.source_revision, `${label}.source_revision`, GIT_COMMIT),
    archive_sha256: digest(arm.archive_sha256, `${label}.archive_sha256`),
    compiler_digest: compilerDigest
  };
}

function normalizedControls(value) {
  const controls = object(value, "controls");
  exact(controls, [
    "provider", "model", "reasoning_effort", "agent_profile", "benchmark_class",
    "k", "attempts", "retries", "concurrency", "max_turns", "network_mode",
    "execution_mode", "write_scope", "managed_environment_mode", "harbor_topology",
    "command_timeout_sec", "cleanup_grace_sec"
  ], "controls");
  const normalized = {
    provider: string(controls.provider, "controls.provider"),
    model: string(controls.model, "controls.model"),
    reasoning_effort: string(controls.reasoning_effort, "controls.reasoning_effort"),
    agent_profile: string(controls.agent_profile, "controls.agent_profile"),
    benchmark_class: string(controls.benchmark_class, "controls.benchmark_class"),
    k: integer(controls.k, "controls.k"),
    attempts: integer(controls.attempts, "controls.attempts"),
    retries: controls.retries,
    concurrency: integer(controls.concurrency, "controls.concurrency"),
    max_turns: integer(controls.max_turns, "controls.max_turns"),
    network_mode: string(controls.network_mode, "controls.network_mode"),
    execution_mode: string(controls.execution_mode, "controls.execution_mode"),
    write_scope: string(controls.write_scope, "controls.write_scope"),
    managed_environment_mode: string(
      controls.managed_environment_mode, "controls.managed_environment_mode"
    ),
    harbor_topology: string(controls.harbor_topology, "controls.harbor_topology"),
    command_timeout_sec: integer(controls.command_timeout_sec, "controls.command_timeout_sec"),
    cleanup_grace_sec: integer(controls.cleanup_grace_sec, "controls.cleanup_grace_sec")
  };
  const fixed = {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoning_effort: "max",
    agent_profile: "standard",
    benchmark_class: "standard",
    k: 1,
    attempts: 1,
    retries: 0,
    concurrency: 5,
    max_turns: 200
  };
  for (const [key, expected] of Object.entries(fixed)) {
    if (normalized[key] !== expected) {
      throw new Error(`Formal A/B requires controls.${key}=${String(expected)}.`);
    }
  }
  if (!["none", "loopback", "full"].includes(normalized.network_mode)
    || !["sandboxed", "container"].includes(normalized.execution_mode)
    || !["workspace", "enclosing-container"].includes(normalized.write_scope)
    || !["disabled", "required"].includes(normalized.managed_environment_mode)
    || !["main_only", "managed_three_role"].includes(normalized.harbor_topology)) {
    throw new Error("Formal A/B execution controls contain an unsupported value.");
  }
  return normalized;
}

function frozenTasks(value, terminalBenchRevision, baseDir) {
  if (!Array.isArray(value) || value.length !== FORMAL_AB_TASK_COUNT) {
    throw new Error(
      `Formal A/B requires all ${FORMAL_AB_TASK_COUNT} frozen Terminal-Bench 2.1 tasks.`
    );
  }
  const tasks = value.map((task, index) => validateExternalTaskRecord(task, index, baseDir));
  assertUniqueHarborTaskExecutionIdentities(tasks);
  if (tasks.some((task) => !task.git_url || task.git_commit_id !== terminalBenchRevision)) {
    throw new Error("Every formal A/B task must be Git-backed at terminal_bench_revision.");
  }
  return tasks.sort((left, right) =>
    taskSelectionIdentitySha256(left).localeCompare(taskSelectionIdentitySha256(right)));
}

export function formalTaskCatalogSha256(tasks) {
  return formalAbSha256(canonicalAbJson(
    [...tasks].map(taskSelectionIdentitySha256).sort()
  ));
}

function normalizedCatalog(value, tasks) {
  const catalog = object(value, "task_selection.catalog");
  exact(catalog, ["git_url", "task_count", "task_identity_sha256"], "task_selection.catalog");
  const normalized = {
    git_url: string(catalog.git_url, "task_selection.catalog.git_url"),
    task_count: integer(catalog.task_count, "task_selection.catalog.task_count"),
    task_identity_sha256: digest(
      catalog.task_identity_sha256,
      "task_selection.catalog.task_identity_sha256"
    )
  };
  if (normalized.task_count !== tasks.length
    || normalized.task_identity_sha256 !== formalTaskCatalogSha256(tasks)
    || tasks.some((task) => task.git_url !== normalized.git_url)) {
    throw new Error(
      "Formal A/B task selection must exactly match its frozen authoritative catalog attestation."
    );
  }
  return normalized;
}

function normalizedReleaseEvidence(value) {
  const evidence = object(value, "release_evidence");
  exact(evidence, [
    "candidate_freeze_manifest_sha256", "safety_report_sha256"
  ], "release_evidence");
  return {
    candidate_freeze_manifest_sha256: digest(
      evidence.candidate_freeze_manifest_sha256,
      "release_evidence.candidate_freeze_manifest_sha256"
    ),
    safety_report_sha256: digest(
      evidence.safety_report_sha256,
      "release_evidence.safety_report_sha256"
    )
  };
}

function derivedExecution(tasks) {
  const taskIndexes = tasks.map((_task, index) => index);
  return {
    canary_task_indexes: taskIndexes.slice(0, 16),
    remaining_task_indexes: taskIndexes.slice(16),
    arm_order: taskIndexes.map((task_index) => ({
      task_index,
      arms: task_index % 2 === 0
        ? ["baseline", "candidate"] : ["candidate", "baseline"]
    }))
  };
}

function derivedGates() {
  return {
    canary: {
      minimum_pass_delta: 0,
      candidate_infra_failures_lte_baseline: true,
      candidate_timeouts_lte_baseline: true,
      maximum_cost_ratio: 1.10
    },
    release: {
      minimum_pass_delta: 3,
      paired_wins_must_exceed_losses: true,
      candidate_infra_failures: 0,
      candidate_timeouts_lte_baseline: true,
      maximum_cost_ratio: 1.10,
      require_safety_and_fairness: true
    }
  };
}

function payloadFromDraft(draft, baseDir) {
  const input = object(draft, "formal A/B draft");
  exact(input, [
    "formal_ab_id", "arms", "task_selection", "controls", "release_evidence"
  ], "formal A/B draft");
  const arms = object(input.arms, "arms");
  exact(arms, ["baseline", "candidate"], "arms");
  const selection = object(input.task_selection, "task_selection");
  exact(selection, [
    "dataset", "terminal_bench_revision", "catalog", "tasks"
  ], "task_selection");
  if (selection.dataset !== FORMAL_AB_DATASET) {
    throw new Error(`Formal A/B dataset must be ${FORMAL_AB_DATASET}.`);
  }
  const terminalBenchRevision = digest(
    selection.terminal_bench_revision,
    "task_selection.terminal_bench_revision",
    GIT_COMMIT
  );
  const tasks = frozenTasks(selection.tasks, terminalBenchRevision, baseDir);
  const catalog = normalizedCatalog(selection.catalog, tasks);
  return {
    schemaVersion: 1,
    kind: "SigmaFormalABPreregistration",
    formal_ab_id: string(input.formal_ab_id, "formal_ab_id"),
    arms: {
      baseline: normalizedArm(arms.baseline, "arms.baseline", false),
      candidate: normalizedArm(arms.candidate, "arms.candidate", true)
    },
    task_selection: {
      dataset: FORMAL_AB_DATASET,
      terminal_bench_revision: terminalBenchRevision,
      catalog,
      tasks,
      task_order_sha256: formalAbSha256(canonicalAbJson(
        tasks.map(taskSelectionIdentitySha256)
      ))
    },
    controls: normalizedControls(input.controls),
    release_evidence: normalizedReleaseEvidence(input.release_evidence),
    execution: derivedExecution(tasks),
    gates: derivedGates(),
    sealing: {
      task_level_results_in_vault: true,
      verifier_feedback_to_solver: false,
      retries_from_evaluation_feedback: false,
      candidate_changes_after_canary: false
    }
  };
}

export function sigmaFormalABPreregistration(draft, options = {}) {
  const payload = payloadFromDraft(draft, path.resolve(options.baseDir ?? process.cwd()));
  return {
    ...payload,
    consumption_identity_sha256: formalAbSha256(canonicalAbJson(payload))
  };
}

export function validateFormalABPreregistration(value, options = {}) {
  const manifest = object(value, "formal A/B preregistration");
  exact(manifest, [
    "schemaVersion", "kind", "formal_ab_id", "arms", "task_selection", "controls",
    "release_evidence", "execution", "gates", "sealing", "consumption_identity_sha256"
  ], "formal A/B preregistration");
  if (manifest.schemaVersion !== 1 || manifest.kind !== "SigmaFormalABPreregistration") {
    throw new Error("Formal A/B requires SigmaFormalABPreregistration schema 1.");
  }
  const selection = object(manifest.task_selection, "task_selection");
  const rebuilt = sigmaFormalABPreregistration({
    formal_ab_id: manifest.formal_ab_id,
    arms: manifest.arms,
    task_selection: {
      dataset: selection.dataset,
      terminal_bench_revision: selection.terminal_bench_revision,
      catalog: selection.catalog,
      tasks: selection.tasks
    },
    controls: manifest.controls,
    release_evidence: manifest.release_evidence
  }, options);
  if (canonicalAbJson(rebuilt) !== canonicalAbJson(manifest)) {
    throw new Error("Formal A/B preregistration contains stale derived fields or digest.");
  }
  return rebuilt;
}

export async function loadFormalABPreregistration(filePath, expectedSha256) {
  const resolved = path.resolve(filePath);
  const bytes = await readFile(resolved);
  if (formalAbSha256(bytes) !== digest(expectedSha256, "expected preregistration SHA-256")) {
    throw new Error("Formal A/B preregistration file does not match its expected SHA-256.");
  }
  const manifest = validateFormalABPreregistration(JSON.parse(bytes.toString("utf8")), {
    baseDir: path.dirname(resolved)
  });
  return { manifest, sha256: formalAbSha256(bytes), filePath: resolved };
}

async function main(argv) {
  const [draftPath, outputPath] = argv;
  if (!draftPath || !outputPath) {
    throw new Error("Usage: node scripts/bench-terminal-bench-formal-ab-preregistration.mjs <draft.json> <output.json>");
  }
  const draft = JSON.parse(await readFile(path.resolve(draftPath), "utf8"));
  const manifest = sigmaFormalABPreregistration(draft, {
    baseDir: path.dirname(path.resolve(draftPath))
  });
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.resolve(outputPath), content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(`${formalAbSha256(content)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
