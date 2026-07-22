#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./bench-common.mjs";
import {
  harborTaskExecutionIdentitySha256,
  taskSelectionIdentitySha256,
  validateExternalTaskRecord
} from "./harbor-task-identity.mjs";
import { canonicalJson } from "./bench-terminal-bench-formal-preregistration.mjs";

const SKIPPED_DIRECTORIES = new Set([
  ".git", ".transactions", "artifacts", "harbor-jobs", "logs", "node_modules", "tasks"
]);
const RESOLVED_ATTESTATION = /^resolved-task-attestation(?:\.v\d+)?(?:-\d+)?\.json$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceKind(name) {
  if (RESOLVED_ATTESTATION.test(name)) return "resolved_attestation";
  if (name.endsWith(".tasks.json")) return "task_selection";
  if (name === "frozen-preregistration.json" || name.endsWith(".preregistration.json")) {
    return "formal_preregistration";
  }
  return null;
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function sourceFiles(root, directory = root) {
  const canonicalDirectory = await realpath(directory);
  if (!within(root, canonicalDirectory)) {
    throw new Error(`Task identity traversal escaped its canonical root at ${directory}.`);
  }
  const entries = await readdir(canonicalDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(canonicalDirectory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...await sourceFiles(root, absolute));
    } else if (entry.isFile() && sourceKind(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

function identityRecord(task, index, baseDir) {
  const normalized = validateExternalTaskRecord(task, index, baseDir);
  return {
    execution_identity_sha256: harborTaskExecutionIdentitySha256(normalized),
    selection_identity_sha256: taskSelectionIdentitySha256(normalized)
  };
}

function attestationRecords(value, label) {
  if (value?.schema_version !== 2 || !Array.isArray(value.tasks)) {
    throw new Error(`${label} is not ResolvedTaskAttestationV2.`);
  }
  return value.tasks.map((task, index) => {
    const execution = task?.harbor_task_identity;
    const selection = task?.selection_identity;
    if (!execution || !selection) {
      throw new Error(`${label}.tasks[${index}] lacks frozen execution or selection identity.`);
    }
    const executionDigest = sha256(canonicalJson(execution));
    const selectionDigest = sha256(canonicalJson(selection));
    if (executionDigest !== task.harbor_task_identity_sha256
      || selectionDigest !== task.selection_identity_sha256
      || canonicalJson(selection.execution) !== canonicalJson(execution)) {
      throw new Error(`${label}.tasks[${index}] identity digest or projection is inconsistent.`);
    }
    return {
      execution_identity_sha256: executionDigest,
      selection_identity_sha256: selectionDigest
    };
  });
}

function sourceTasks(kind, value, label) {
  if (kind === "resolved_attestation") return attestationRecords(value, label);
  const tasks = kind === "formal_preregistration" ? value?.task_selection?.tasks : value;
  if (!Array.isArray(tasks)) throw new Error(`${label} does not contain a frozen task array.`);
  const baseDir = path.dirname(label);
  return tasks.map((task, index) => identityRecord(task, index, baseDir));
}

export async function createTaskIdentityArchive(rootPath, options = {}) {
  const root = await realpath(path.resolve(rootPath));
  if (!(await stat(root)).isDirectory()) throw new Error("Task identity archive root must be a directory.");
  const files = await sourceFiles(root);
  const executionDigests = new Set();
  const selectionDigests = new Set();
  const sources = [];
  for (const file of files) {
    const bytes = await readFile(file);
    const relative = path.relative(root, file).split(path.sep).join("/");
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error(`Task identity source ${relative} is not valid JSON.`, { cause: error });
    }
    const kind = sourceKind(path.basename(file));
    const records = sourceTasks(kind, value, file);
    for (const record of records) {
      executionDigests.add(record.execution_identity_sha256);
      selectionDigests.add(record.selection_identity_sha256);
    }
    sources.push({
      path: relative,
      kind,
      sha256: sha256(bytes),
      identity_count: records.length
    });
  }
  if (selectionDigests.size === 0) {
    throw new Error("Task identity archive root contains no allowlisted frozen task identities.");
  }
  const executionIdentitySha256s = [...executionDigests].sort();
  const selectionIdentitySha256s = [...selectionDigests].sort();
  return {
    schemaVersion: 1,
    kind: "SigmaTaskIdentityArchiveV1",
    created_at: options.createdAt ?? new Date().toISOString(),
    source_root_sha256: sha256(canonicalJson(sources)),
    source_count: sources.length,
    execution_identity_count: executionIdentitySha256s.length,
    selection_identity_count: selectionIdentitySha256s.length,
    execution_identity_sha256s: executionIdentitySha256s,
    selection_identity_sha256s: selectionIdentitySha256s,
    sources
  };
}

export async function writeTaskIdentityArchive(rootPath, outputPath, options = {}) {
  const archive = await createTaskIdentityArchive(rootPath, options);
  const resolvedOutput = path.resolve(outputPath);
  const handle = await open(
    resolvedOutput,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600
  );
  const bytes = `${JSON.stringify(archive, null, 2)}\n`;
  try {
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { archive, path: resolvedOutput, sha256: sha256(bytes) };
}

function requiredFlag(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required.`);
  return value.trim();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const flags = parseArgs(process.argv.slice(2));
  writeTaskIdentityArchive(
    requiredFlag(flags.root, "--root"),
    requiredFlag(flags.output, "--output")
  ).then((result) => {
    process.stdout.write(`${JSON.stringify({ path: result.path, sha256: result.sha256 })}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
