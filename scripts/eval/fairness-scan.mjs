#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".rs", ".py", ".toml", ".json", ".yaml", ".yml", ".md",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".psm1", ".psd1", ".cmd", ".bat", ".lock", ".ini", ".cfg", ".conf"
]);
const SOURCE_BASENAMES = new Set(["Dockerfile", "Makefile", "Justfile"]);
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "target", ".git", ".agent", ".artifacts", "coverage"]);
const IDENTITY = String.raw`(?:benchmark|scenario[_-]?(?:id|name)|task[_-]?(?:id|name)|dataset[_-]?(?:id|name)|verifier[_-]?(?:id|name)|fixture[_-]?(?:id|name)|known[_-]?output|reward)`;
const PRODUCT_BRANCH_PATTERNS = [
  new RegExp(String.raw`\b(?:if|while)\s*\([^)]*\b${IDENTITY}\b`, "iu"),
  new RegExp(String.raw`\bswitch\s*\([^)]*\b${IDENTITY}\b`, "iu"),
  new RegExp(String.raw`\b${IDENTITY}\b[^\n]{0,120}\.(?:includes|startsWith|endsWith|match|test)\s*\(`, "iu")
];
const FEEDBACK_RETRY = new RegExp(
  String.raw`(?:verifier|reward|benchmark[_-]?result|hidden[_-]?test)[^\n]{0,160}(?:retry|resume|rerun)[^\n]{0,80}(?:agent|subject|solver)|(?:retry|resume|rerun)[^\n]{0,160}(?:verifier|reward|hidden[_-]?test)`,
  "iu"
);
const FORWARDING = new RegExp(
  String.raw`(?:agent|subject|solver)[_-]?(?:prompt|input|message)[^\n]{0,160}(?:scenario[_-]?id|task[_-]?id|verifier|reward|score|expected[_-]?(?:output|result))`,
  "iu"
);
const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\\\\[^\s]+[\\/]|\/(?:home|Users|tmp|var|opt|workspace|mnt|private)\/)/u;
const TRUSTED_CONTROL_SCRIPT = /^scripts\/(?:eval\/|bench-[^/]+\.mjs$)/u;

async function filesUnder(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && isAuditableSource(entry.name)) files.push(target);
    }
  }
  await visit(directory).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return files;
}

function isAuditableSource(file) {
  return SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()) || SOURCE_BASENAMES.has(path.basename(file));
}

function relative(file, workspace = root) {
  return path.relative(workspace, file).replaceAll(path.sep, "/");
}

// Each branch is an independent fairness prohibition and remains fail-closed.
// eslint-disable-next-line complexity
async function scanProductSources(workspace = root, knownTaints = [], changedFiles = null, baselineWorkspace = null) {
  const changedExistingFiles = changedFiles === null ? null : (await Promise.all(changedFiles.map(async (name) => {
    const file = path.resolve(workspace, name);
    return await readFile(file).then(() => ({ name, file }), (error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
  }))).filter(Boolean);
  const unsupported = changedExistingFiles?.filter(({ name }) => !isAuditableSource(name)) ?? [];
  const files = changedFiles === null
    ? (await Promise.all(["packages", "native", "portable", "config", ".codex"]
      .map((item) => filesUnder(path.join(workspace, item))))).flat()
    : changedExistingFiles.filter(({ name }) => isAuditableSource(name)).map(({ file }) => file);
  const violations = unsupported.map(({ name }) =>
    `${name.replaceAll("\\", "/")}: changed candidate input has an unsupported fairness-scan file type`);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const baselineSource = baselineWorkspace
      ? await readFile(path.join(baselineWorkspace, relative(file, workspace)), "utf8").catch(() => "")
      : null;
    for (const pattern of PRODUCT_BRANCH_PATTERNS) {
      if (pattern.test(source)) violations.push(`${relative(file, workspace)}: branches on evaluation identity`);
    }
    for (const taint of knownTaints) {
      if (source.includes(taint) && (baselineSource === null || !baselineSource.includes(taint))) {
        violations.push(`${relative(file, workspace)}: contains frozen evaluator identity or output`);
      }
    }
    if (FEEDBACK_RETRY.test(source)) violations.push(`${relative(file, workspace)}: retries a solver from post-run feedback`);
    if (FORWARDING.test(source)) violations.push(`${relative(file, workspace)}: forwards evaluator-only data to a solver`);
  }
  return violations;
}

async function evaluatorTaints(controlRoot = root) {
  const manifestPath = path.join(controlRoot, "test-fixtures", "agent-evals", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const values = new Set();
  const add = (value) => {
    if (typeof value === "string" && value.trim().length >= 6) values.add(value.trim());
  };
  const addRecursive = (value) => Array.isArray(value) ? value.forEach(addRecursive) : add(value);
  for (const scenario of manifest.scenarios ?? []) {
    add(scenario.id);
    add(scenario.title);
    addRecursive(scenario.userMessages);
    addRecursive((scenario.interactions ?? []).map((item) => item?.text));
    addRecursive(scenario.allowedChanges);
    add(scenario.fixture?.workspace);
    for (const operation of scenario.fixture?.setupAfterCommit ?? []) {
      for (const key of ["path", "target", "content"]) addRecursive(operation[key]);
    }
    // Cover every verifier payload field while excluding only generic check
    // type/boolean/count metadata. Candidate scans compare the same file in
    // the trusted baseline, so ordinary protocol vocabulary such as an event
    // type is flagged only when a candidate newly introduces it.
    for (const check of scenario.verifier?.checks ?? []) {
      for (const key of [
        "path", "equals", "contains", "notContains", "pattern", "matches",
        "argv", "eventType", "toolName", "allowedPaths"
      ]) addRecursive(check[key]);
    }
  }
  return [...values].sort();
}

async function scenarioIdentifiers(controlRoot = root) {
  const manifest = JSON.parse(await readFile(
    path.join(controlRoot, "test-fixtures", "agent-evals", "manifest.json"), "utf8"
  ));
  return (manifest.scenarios ?? []).map((scenario) => scenario.id)
    .filter((value) => typeof value === "string" && value.length > 0);
}

async function scanOptimizerSkill(workspace = root) {
  const skillRoot = path.join(workspace, ".agents", "skills", "sigma-eval-improver");
  const files = await filesUnder(skillRoot);
  const knownIds = await scenarioIdentifiers(workspace);
  const violations = [];
  let combined = "";
  for (const file of files) {
    const source = await readFile(file, "utf8");
    combined += `\n${source}`;
    if (ABSOLUTE_PATH.test(source)) violations.push(`${relative(file, workspace)}: contains an absolute path`);
    if (knownIds.some((item) => source.includes(item))) violations.push(`${relative(file, workspace)}: contains a known evaluation identity`);
    if (/test-fixtures[/\\]agent-evals/iu.test(source)) violations.push(`${relative(file, workspace)}: points at evaluator fixtures`);
  }
  const required = ["OptimizerObservationV1", "OptimizationExperimentV1", "verifier", "one general invariant"];
  for (const phrase of required) {
    if (!combined.includes(phrase)) violations.push(`optimizer skill: missing boundary instruction '${phrase}'`);
  }
  return violations;
}

async function scanScripts(workspace = root, knownTaints = []) {
  const files = await filesUnder(path.join(workspace, "scripts"));
  const violations = [];
  for (const file of files) {
    if (workspace === root && path.resolve(file) === fileURLToPath(import.meta.url)) continue;
    const source = await readFile(file, "utf8");
    const relativeName = relative(file, workspace);
    // Evaluator code and neutral external benchmark runners are control-plane
    // infrastructure. They may select a task or inspect post-run records, but
    // are still scanned below for solver feedback retries and data forwarding.
    const isTrustedControl = TRUSTED_CONTROL_SCRIPT.test(relativeName);
    if (!isTrustedControl) {
      for (const pattern of PRODUCT_BRANCH_PATTERNS) {
        if (pattern.test(source)) violations.push(`${relativeName}: branches on evaluation identity`);
      }
      for (const taint of knownTaints) {
        if (source.includes(taint)) violations.push(`${relativeName}: contains frozen evaluator identity or output`);
      }
    }
    if (FEEDBACK_RETRY.test(source)) violations.push(`${relativeName}: post-run feedback can trigger a solver retry`);
    if (FORWARDING.test(source)) violations.push(`${relativeName}: evaluator-only data can enter a solver input`);
  }
  return violations;
}

export async function scanCandidateBenchmarkFairness(candidateRoot, controlRoot = root, changedFiles = null) {
  const workspace = path.resolve(candidateRoot);
  const baseline = path.resolve(controlRoot);
  return await scanProductSources(workspace, await evaluatorTaints(baseline), changedFiles, baseline);
}

export async function scanBenchmarkFairness(workspace = root) {
  const resolved = path.resolve(workspace);
  const identities = new Set(await scenarioIdentifiers(resolved));
  const taints = (await evaluatorTaints(resolved)).filter((value) => identities.has(value)
    || (/\s/u.test(value) && value.length >= 24)
    || (/[\^$*+?{}()[\]|]/u.test(value) && value.length >= 12));
  return [
    ...await scanProductSources(resolved, taints),
    ...await scanScripts(resolved, taints),
    ...await scanOptimizerSkill(resolved)
  ];
}

export async function main() {
  const violations = await scanBenchmarkFairness();
  if (violations.length > 0) {
    process.stderr.write(`Benchmark fairness scan failed:\n${violations.map((item) => `- ${item}`).join("\n")}\n`);
    process.exitCode = 1;
    return violations;
  }
  process.stdout.write("Benchmark fairness scan passed.\n");
  return [];
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
