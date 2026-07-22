import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function canonicalGitUrl(value) {
  const text = nonEmptyString(value);
  if (!text) return undefined;
  try {
    const parsed = new URL(text);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
    return parsed.toString();
  } catch {
    return text.replace(/\/+$/u, "");
  }
}

function canonicalPath(value, baseDir = process.cwd()) {
  const resolved = path.resolve(baseDir, value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function validateExternalTaskRecord(value, index, baseDir = process.cwd()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`tasks-file[${index}] must be an object.`);
  }
  const allowed = new Set([
    "name", "path", "git_url", "git_commit_id", "provenance_source", "source"
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`tasks-file[${index}] has unsupported fields: ${unknown.join(", ")}.`);
  }

  const name = nonEmptyString(value.name);
  const taskPath = nonEmptyString(value.path);
  if (Boolean(name) === Boolean(taskPath)) {
    throw new Error(`tasks-file[${index}] must contain exactly one of name or path.`);
  }
  const gitUrl = canonicalGitUrl(value.git_url);
  const gitCommit = nonEmptyString(value.git_commit_id);
  if (Boolean(gitUrl) !== Boolean(gitCommit)) {
    throw new Error(`tasks-file[${index}] git_url and git_commit_id must be supplied together.`);
  }
  if (name && gitUrl) throw new Error(`tasks-file[${index}] named tasks cannot include Git source fields.`);
  if (gitCommit && !/^[a-f0-9]{40}$/u.test(gitCommit)) {
    throw new Error(`tasks-file[${index}].git_commit_id must be a lowercase 40-character Git commit.`);
  }

  const provenance = nonEmptyString(value.provenance_source);
  const legacyProvenance = nonEmptyString(value.source);
  if (provenance && legacyProvenance && provenance !== legacyProvenance) {
    throw new Error(`tasks-file[${index}] source and provenance_source conflict.`);
  }
  return {
    ...(name ? { name } : { path: canonicalPath(taskPath, baseDir) }),
    ...(gitUrl ? { git_url: gitUrl, git_commit_id: gitCommit } : {}),
    ...(provenance || legacyProvenance
      ? { provenance_source: provenance ?? legacyProvenance }
      : {})
  };
}

export function projectHarborTaskConfig(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new Error("Harbor task projection requires an object.");
  }
  const name = nonEmptyString(task.name);
  const taskPath = nonEmptyString(task.path);
  if (Boolean(name) === Boolean(taskPath)) {
    throw new Error("Harbor task projection requires exactly one of name or path.");
  }
  const gitUrl = canonicalGitUrl(task.git_url);
  const gitCommit = nonEmptyString(task.git_commit_id);
  if (Boolean(gitUrl) !== Boolean(gitCommit)) {
    throw new Error("Harbor task projection requires git_url and git_commit_id together.");
  }
  if (name && gitUrl) throw new Error("Named Harbor tasks cannot include Git source fields.");
  return {
    ...(name ? { name } : { path: canonicalPath(taskPath) }),
    ...(gitUrl ? { git_url: gitUrl, git_commit_id: gitCommit } : {})
  };
}

export function harborTaskExecutionIdentity(task) {
  const projected = projectHarborTaskConfig(task);
  return projected.name
    ? { kind: "name", name: projected.name }
    : {
      kind: "path",
      path: projected.path,
      ...(projected.git_url
        ? { git_url: projected.git_url, git_commit_id: projected.git_commit_id }
        : {})
    };
}

export function harborTaskExecutionIdentitySha256(task) {
  return sha256(harborTaskExecutionIdentity(task));
}

export function taskSelectionIdentity(task) {
  return {
    execution: harborTaskExecutionIdentity(task),
    provenance_source: nonEmptyString(task.provenance_source) ?? nonEmptyString(task.source) ?? null
  };
}

export function taskSelectionIdentitySha256(task) {
  return sha256(taskSelectionIdentity(task));
}

export function assertUniqueHarborTaskExecutionIdentities(tasks) {
  const seen = new Set();
  for (const task of tasks) {
    const identity = harborTaskExecutionIdentitySha256(task);
    if (seen.has(identity)) throw new Error("Task selection contains duplicate Harbor execution identities.");
    seen.add(identity);
  }
}

export function buildResolvedTaskAttestationV2({
  jobConfigSha256,
  taskSelectionSha256,
  selectedTasks,
  resolvedTasks = []
}) {
  assertUniqueHarborTaskExecutionIdentities(selectedTasks);
  if (resolvedTasks.length > 0 && resolvedTasks.length !== selectedTasks.length) {
    throw new Error("Resolved task attestation count does not match the frozen selection.");
  }
  return {
    schema_version: 2,
    job_config_sha256: jobConfigSha256,
    task_selection_sha256: taskSelectionSha256,
    tasks: selectedTasks.map((task, index) => {
      const execution = harborTaskExecutionIdentity(task);
      const resolved = resolvedTasks[index];
      return {
        harbor_task_identity: execution,
        harbor_task_identity_sha256: harborTaskExecutionIdentitySha256(task),
        selection_identity: taskSelectionIdentity(task),
        selection_identity_sha256: taskSelectionIdentitySha256(task),
        ...(resolved ? { resolved_harbor_task_identity: harborTaskExecutionIdentity(resolved) } : {})
      };
    })
  };
}
