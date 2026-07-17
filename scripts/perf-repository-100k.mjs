#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RepositoryContextProvider } from "../packages/agent-context/dist/index.js";

async function git(workspace, args, input = "") {
  return await new Promise((resolve, reject) => {
    const hasInput = input.length > 0;
    const child = spawn("git", ["-C", workspace, ...args], {
      windowsHide: true,
      stdio: [hasInput ? "pipe" : "ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`git ${args[0]} failed: ${stderr}`)));
    if (hasInput) {
      child.stdin.on("error", (error) => { if (error.code !== "EPIPE") reject(error); });
      child.stdin.end(input);
    }
  });
}

async function createIndex(workspace, count) {
  await git(workspace, ["init", "-q"]);
  await git(workspace, ["config", "user.email", "performance@example.invalid"]);
  await git(workspace, ["config", "user.name", "Sigma performance check"]);
  const blob = await git(workspace, ["hash-object", "-w", "--stdin"]);
  const names = Array.from({ length: count }, (_, index) => `files/${String(index).padStart(6, "0")}.txt`);
  await git(workspace, ["update-index", "--index-info"], names.map((name) => `100644 ${blob}\t${name}\n`).join(""));
  // RepositoryContextProvider V4 intentionally indexes the pinned host tree,
  // not Git's mutable index, so materialize the synthetic entries as files.
  await git(workspace, ["checkout-index", "--all"]);
  await git(workspace, ["commit", "-q", "-m", "synthetic 100k-file index"]);
  await git(workspace, ["update-index", "--assume-unchanged", "--stdin"], `${names.join("\n")}\n`);
}

const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-repo-100k-"));
const execution = {
  async execute(request) {
    if (request.command.executable !== "git") {
      throw new Error(`100k repository performance execution denied '${request.command.executable}'.`);
    }
    const started = performance.now();
    const stdout = await git(request.command.cwd, request.command.args ?? []);
    return {
      state: "exited", exitCode: 0, signal: null, durationMs: performance.now() - started,
      timedOut: false, idleTimedOut: false, cancelled: false, stdout, stderr: "",
      stdoutDroppedBytes: 0, stderrDroppedBytes: 0, outputTruncated: false
    };
  }
};
try {
  await createIndex(workspace, 100_000);
  const beforeHeap = process.memoryUsage().heapUsed;
  const started = performance.now();
  const items = await new RepositoryContextProvider(execution).collect(
    workspace, "files 099999", new AbortController().signal
  );
  const durationMs = performance.now() - started;
  const heapDelta = Math.max(0, process.memoryUsage().heapUsed - beforeHeap);
  const indexed = items.some((item) => item.content.includes("Repository files (100000"));
  if (!indexed || durationMs > 30_000 || heapDelta > 300 * 1024 * 1024) {
    const repositorySummary = items.find((item) => item.id.startsWith("repo:index:"))?.content.split("\n", 1)[0] ?? "missing";
    throw new Error(
      `100k repository performance failed: indexed=${indexed} durationMs=${durationMs.toFixed(1)} `
      + `heapDelta=${heapDelta} repositorySummary=${repositorySummary}`
    );
  }
  console.log(`PASS 100k repository context durationMs=${durationMs.toFixed(1)} heapDeltaMiB=${(heapDelta / 1024 / 1024).toFixed(1)}`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
