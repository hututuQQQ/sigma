#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, digest } from "./common.mjs";

const execFile = promisify(execFileCallback);
// Candidate binding covers every root that OptimizationExperimentV1 may
// authorize, including the ordinary tests that establish generality.
const PRODUCT_ROOTS = ["packages", "native", "tests"];
const EVALUATION_CONTROL_PATHS = [
  "scripts/eval",
  "scripts/release",
  "scripts/lib/sigma-manifest.mjs",
  "test-fixtures/agent-evals",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "sigma-manifest.json"
];

async function git(execute, cwd, args) {
  const result = await execute("git", args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return result.stdout;
}

async function untrackedDigests(workspace, names) {
  const result = [];
  for (const name of names) {
    const target = path.resolve(workspace, name);
    if (!target.startsWith(`${workspace}${path.sep}`)) throw new Error("Unsafe untracked product path.");
    result.push([name.replaceAll("\\", "/"), digest(await readFile(target))]);
  }
  return result.sort(([left], [right]) => left.localeCompare(right));
}

export async function computeProductDigest(workspace, options = {}) {
  const cwd = path.resolve(workspace);
  const execute = options.execFile ?? execFile;
  const separator = ["--", ...PRODUCT_ROOTS];
  const [tracked, diff, untrackedText] = await Promise.all([
    git(execute, cwd, ["ls-files", "-s", ...separator]),
    git(execute, cwd, ["diff", "--binary", "HEAD", ...separator]),
    git(execute, cwd, ["ls-files", "--others", "--exclude-standard", ...separator])
  ]);
  const untrackedNames = untrackedText.split(/\r?\n/u).filter(Boolean);
  const untracked = await untrackedDigests(cwd, untrackedNames);
  return {
    digest: digest(canonicalJson({ tracked, diffDigest: digest(diff), untracked })),
    clean: diff.length === 0 && untracked.length === 0
  };
}

export async function computeEvaluationControlDigest(workspace, options = {}) {
  const cwd = path.resolve(workspace);
  const execute = options.execFile ?? execFile;
  const separator = ["--", ...EVALUATION_CONTROL_PATHS];
  const [tracked, diff, untrackedText] = await Promise.all([
    git(execute, cwd, ["ls-files", "-s", ...separator]),
    git(execute, cwd, ["diff", "--binary", "HEAD", ...separator]),
    git(execute, cwd, ["ls-files", "--others", "--exclude-standard", ...separator])
  ]);
  const untrackedNames = untrackedText.split(/\r?\n/u).filter(Boolean);
  const untracked = await untrackedDigests(cwd, untrackedNames);
  return {
    digest: digest(canonicalJson({ tracked, diffDigest: digest(diff), untracked })),
    clean: diff.length === 0 && untracked.length === 0
  };
}

export async function isGitWorktreeClean(workspace, options = {}) {
  const cwd = path.resolve(workspace);
  const execute = options.execFile ?? execFile;
  const status = await git(execute, cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return status.trim().length === 0;
}

async function trackedIndex(workspace, execute) {
  const output = await git(execute, workspace, ["ls-files", "-s"]);
  const entries = new Map();
  for (const line of output.split(/\r?\n/u).filter(Boolean)) {
    const match = /^(\d+) ([a-f0-9]+) \d+\t(.+)$/u.exec(line);
    if (match) entries.set(match[3].replaceAll("\\", "/"), `${match[1]}:${match[2]}`);
  }
  return entries;
}

function globRegex(pattern) {
  const normalized = pattern.replaceAll("\\", "/");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }
  return new RegExp(`^${source}$`, "u");
}

export async function assertCandidateModificationScope(baseline, candidate, allowedGlobs, options = {}) {
  const execute = options.execFile ?? execFile;
  const [before, after] = await Promise.all([
    trackedIndex(path.resolve(baseline), execute), trackedIndex(path.resolve(candidate), execute)
  ]);
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changed = names.filter((name) => before.get(name) !== after.get(name));
  const patterns = allowedGlobs.map(globRegex);
  const outside = changed.filter((name) => !patterns.some((pattern) => pattern.test(name)));
  if (outside.length > 0) {
    throw new Error(`Frozen candidate changed files outside its preregistered scope: ${outside.join(", ")}`);
  }
  if (changed.length === 0) throw new Error("Frozen candidate contains no tracked product change.");
  if (!changed.some((name) => name.startsWith("packages/") || name.startsWith("native/"))) {
    throw new Error("Frozen candidate must include at least one packages/ or native/ product change; tests alone are not a candidate.");
  }
  return changed;
}

async function main(argv = process.argv.slice(2)) {
  const workspace = argv[0] ? path.resolve(argv[0]) : process.cwd();
  const result = await computeProductDigest(workspace);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
