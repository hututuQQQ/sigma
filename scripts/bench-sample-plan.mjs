#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function taskRecord(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`catalog.tasks[${index}] must be an object.`);
  }
  const difficulty = nonEmpty(value.difficulty, `catalog.tasks[${index}].difficulty`).toLowerCase();
  const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : null;
  const taskPath = typeof value.path === "string" && value.path.trim() ? value.path.trim().replaceAll("\\", "/") : null;
  if (Boolean(name) === Boolean(taskPath)) {
    throw new Error(`catalog.tasks[${index}] must contain exactly one of name or path.`);
  }
  if (taskPath && (path.posix.isAbsolute(taskPath) || taskPath.split("/").includes(".."))) {
    throw new Error(`catalog.tasks[${index}].path must be portable and relative.`);
  }
  const gitUrl = typeof value.git_url === "string" && value.git_url.trim() ? value.git_url.trim() : null;
  const gitCommit = typeof value.git_commit_id === "string" && value.git_commit_id.trim()
    ? value.git_commit_id.trim().toLowerCase() : null;
  if (Boolean(gitUrl) !== Boolean(gitCommit)) {
    throw new Error(`catalog.tasks[${index}] git_url and git_commit_id must be supplied together.`);
  }
  if (gitCommit && !/^[a-f0-9]{40}$/u.test(gitCommit)) {
    throw new Error(`catalog.tasks[${index}].git_commit_id must be a 40-character Git commit.`);
  }
  const source = typeof value.source === "string" && value.source.trim() ? value.source.trim() : null;
  const task = {
    ...(name ? { name } : { path: taskPath }),
    ...(gitUrl ? { git_url: gitUrl, git_commit_id: gitCommit } : {}),
    ...(source ? { source } : {})
  };
  return {
    difficulty,
    task,
    identity: name ?? `${gitUrl ?? ""}\0${gitCommit ?? ""}\0${taskPath}`
  };
}

export function createBenchmarkSamplePlan(catalog, options) {
  if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.tasks) || catalog.tasks.length === 0) {
    throw new Error("Catalog must be a schemaVersion 1 object with a non-empty tasks array.");
  }
  const seed = nonEmpty(options?.seed, "seed");
  const quotas = options?.quotas;
  if (!quotas || typeof quotas !== "object" || Array.isArray(quotas) || Object.keys(quotas).length === 0) {
    throw new Error("At least one stratum quota is required.");
  }
  const records = catalog.tasks.map(taskRecord);
  if (new Set(records.map((record) => record.identity)).size !== records.length) {
    throw new Error("Catalog contains duplicate task identities.");
  }
  const selected = [];
  for (const [rawDifficulty, rawCount] of Object.entries(quotas)) {
    const difficulty = nonEmpty(rawDifficulty, "quota difficulty").toLowerCase();
    const count = Number(rawCount);
    if (!Number.isSafeInteger(count) || count < 1) throw new Error(`Quota '${difficulty}' must be a positive integer.`);
    const candidates = records.filter((record) => record.difficulty === difficulty)
      .sort((left, right) => sha256(`${seed}\0${left.identity}`).localeCompare(sha256(`${seed}\0${right.identity}`))
        || left.identity.localeCompare(right.identity));
    if (candidates.length < count) {
      throw new Error(`Catalog has ${candidates.length} '${difficulty}' tasks but quota requires ${count}.`);
    }
    selected.push(...candidates.slice(0, count));
  }
  const tasks = selected.map((record) => record.task);
  const taskDigest = sha256(canonical(tasks));
  const tasksFileSha256 = sha256(`${JSON.stringify(tasks, null, 2)}\n`);
  return {
    schemaVersion: 1,
    kind: "sigma.benchmark-sample-plan",
    createdAt: options.createdAt ?? new Date().toISOString(),
    seedSha256: sha256(seed),
    catalogSha256: sha256(canonical(catalog)),
    quotas: Object.fromEntries(Object.entries(quotas).map(([key, value]) => [key.toLowerCase(), Number(value)])),
    taskCount: tasks.length,
    tasksSha256: taskDigest,
    tasksFileSha256,
    tasks
  };
}

function parseArgs(argv) {
  const values = { quotas: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[++index];
    if (!value) throw new Error(`Missing value for ${key}.`);
    if (key === "--quota") {
      const match = /^([^=]+)=([1-9][0-9]*)$/u.exec(value);
      if (!match) throw new Error("--quota must use difficulty=count.");
      values.quotas[match[1].toLowerCase()] = Number(match[2]);
    } else if (["--catalog", "--seed", "--tasks-output", "--plan-output"].includes(key)) {
      values[key.slice(2).replaceAll("-", "_")] = value;
    } else throw new Error(`Unknown argument: ${key}`);
  }
  for (const key of ["catalog", "seed", "tasks_output", "plan_output"]) {
    if (!values[key]) throw new Error(`--${key.replaceAll("_", "-")} is required.`);
  }
  if (Object.keys(values.quotas).length === 0) values.quotas = { easy: 2, medium: 6, hard: 4 };
  return values;
}

async function main(argv) {
  const options = parseArgs(argv);
  const catalog = JSON.parse(await readFile(path.resolve(options.catalog), "utf8"));
  const plan = createBenchmarkSamplePlan(catalog, { seed: options.seed, quotas: options.quotas });
  await writeFile(path.resolve(options.tasks_output), `${JSON.stringify(plan.tasks, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await writeFile(path.resolve(options.plan_output), `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`Frozen ${plan.taskCount}-task sample; tasksSha256=${plan.tasksSha256}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
