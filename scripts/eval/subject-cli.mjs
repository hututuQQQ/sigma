import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { subjectNodeLaunch } from "./subject-launch.mjs";
import { sigmaManifest } from "../lib/sigma-manifest.mjs";

const OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
const CANCEL_GRACE_MS = 15_000;

function nodeCliArgs(commandArgs, subject) {
  const launch = subjectNodeLaunch(subject);
  return [
    "--experimental-ffi",
    "--disable-warning=ExperimentalWarning",
    launch.entryPath,
    ...commandArgs
  ];
}

function appendLimited(current, chunk) {
  if (Buffer.byteLength(current) >= OUTPUT_LIMIT_BYTES) return current;
  const next = `${current}${chunk}`;
  if (Buffer.byteLength(next) <= OUTPUT_LIMIT_BYTES) return next;
  return `${Buffer.from(next).subarray(0, OUTPUT_LIMIT_BYTES).toString("utf8")}\n[output truncated by evaluator]\n`;
}

function eventFromLine(line) {
  try {
    const parsed = JSON.parse(line);
    if (parsed?.kind === "event" && parsed.event?.type) return { event: parsed.event };
    if (parsed?.kind === "result" || parsed?.type === "result") return { result: parsed.result ?? parsed };
  } catch {
    // Non-JSON output remains available in stdout for diagnostics.
  }
  return {};
}

function budgetState(events, startedAt) {
  const usage = events.filter((event) => event.type === "usage.recorded").map((event) => event.payload ?? {});
  return {
    wallTimeMs: Date.now() - startedAt,
    modelTurns: events.filter((event) => event.type === "model.started").length,
    toolCalls: events.filter((event) => event.type === "tool.requested").length,
    costMicroUsd: usage.reduce((total, item) => total + Number(item.costMicroUsd ?? 0), 0)
  };
}

function breachedBudget(state, budget) {
  if (state.wallTimeMs > budget.wallTimeSec * 1_000) return { dimension: "wallTime", actual: state.wallTimeMs, limit: budget.wallTimeSec * 1_000 };
  if (state.modelTurns > budget.modelTurns) return { dimension: "modelTurns", actual: state.modelTurns, limit: budget.modelTurns };
  if (state.toolCalls > budget.toolCalls) return { dimension: "toolCalls", actual: state.toolCalls, limit: budget.toolCalls };
  if (state.costMicroUsd > Math.round(budget.costUsd * 1_000_000)) {
    return { dimension: "costMicroUsd", actual: state.costMicroUsd, limit: Math.round(budget.costUsd * 1_000_000) };
  }
  return null;
}

function terminateWindowsProcessTree(processId) {
  return new Promise((resolve, reject) => {
    const killer = spawn("taskkill.exe", ["/pid", String(processId), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore"
    });
    killer.on("error", reject);
    killer.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      try {
        process.kill(processId, 0);
        reject(new Error(`taskkill failed to terminate process tree ${processId} (exit ${exitCode ?? "unknown"}).`));
      } catch {
        resolve();
      }
    });
  });
}

export async function terminateProcessTree(child) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) return;
  if (process.platform === "win32") {
    await terminateWindowsProcessTree(child.pid);
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function spawnCapture(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let terminationTimer;
  child.stdout.on("data", (chunk) => { stdout = appendLimited(stdout, chunk.toString("utf8")); });
  child.stderr.on("data", (chunk) => { stderr = appendLimited(stderr, chunk.toString("utf8")); });
  const exited = new Promise((resolve, reject) => {
    const clear = () => {
      clearTimeout(terminationTimer);
    };
    child.on("error", (error) => { clear(); reject(error); });
    child.on("close", (exitCode, signal) => {
      clear();
      resolve({ exitCode: exitCode ?? 1, signal, stdout, stderr, timedOut });
    });
    if (options.timeoutMs) {
      terminationTimer = setTimeout(() => {
        timedOut = true;
        void terminateProcessTree(child).catch(() => child.kill("SIGKILL"));
      }, options.timeoutMs);
    }
  });
  return { child, exited, getOutput: () => ({ stdout, stderr }) };
}

async function cancelSession({ sessionId, workspace, env, reason, subject }) {
  if (!sessionId) return { exitCode: 1, stderr: "Session id was not observed before cancellation." };
  const launch = subjectNodeLaunch(subject);
  const operation = spawnCapture(launch.executablePath, nodeCliArgs([
    "session", "cancel", sessionId,
    "--workspace", workspace,
    "--provider", "deepseek",
    "--model", sigmaManifest.evaluation.model,
    "--reason", reason
  ], subject), { cwd: workspace, env, timeoutMs: CANCEL_GRACE_MS });
  return await operation.exited;
}

function startCliSubject({ workspace, stateHome, promptPath, runMode, env, subject }) {
  const command = runMode === "analyze" ? "inspect" : "run";
  const args = nodeCliArgs([
    command,
    "--workspace", workspace,
    "--prompt-file", promptPath,
    "--provider", "deepseek",
    "--model", sigmaManifest.evaluation.model,
    "--permission-mode", "auto",
    "--output-format", "stream-json",
    "--output-schema", "3"
  ], subject);
  const launch = subjectNodeLaunch(subject);
  return {
    startedAt: Date.now(),
    child: spawn(launch.executablePath, args, {
      cwd: workspace,
      env: { ...env, SIGMA_STATE_HOME: stateHome },
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    })
  };
}

export async function runCliSubject(options) {
  const {
    workspace, stateHome, promptPath, runMode, env, budget, artifactDir, redactor,
    onEvent = () => undefined, subject = {}
  } = options;
  await mkdir(artifactDir, { recursive: true });
  const { child, startedAt } = startCliSubject({ workspace, stateHome, promptPath, runMode, env, subject });
  const events = [];
  let result;
  let stdout = "";
  let stderr = "";
  let sessionId;
  let cancellation;
  let cancelRequestedAt;
  let cancelPromise;
  let treeTerminationPromise;

  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    stdout = appendLimited(stdout, `${line}\n`);
    const parsed = eventFromLine(line);
    if (parsed.event) {
      events.push(parsed.event);
      sessionId = sessionId ?? parsed.event.sessionId;
      onEvent(parsed.event);
    }
    if (parsed.result) {
      result = parsed.result;
      sessionId = sessionId ?? parsed.result.sessionId;
    }
  });
  child.stderr.on("data", (chunk) => { stderr = appendLimited(stderr, chunk.toString("utf8")); });

  const monitor = setInterval(() => {
    if (cancellation) {
      const elapsed = cancelRequestedAt ? Date.now() - cancelRequestedAt : 0;
      if (elapsed > CANCEL_GRACE_MS && !treeTerminationPromise) {
        treeTerminationPromise = terminateProcessTree(child);
      }
      return;
    }
    const breach = breachedBudget(budgetState(events, startedAt), budget);
    if (!breach) return;
    cancellation = { reason: "experience_budget_exceeded", ...breach, requestedAt: new Date().toISOString() };
    cancelRequestedAt = Date.now();
    cancelPromise = cancelSession({
      sessionId,
      workspace,
      env: { ...env, SIGMA_STATE_HOME: stateHome },
      reason: `Evaluation experience budget exceeded: ${breach.dimension}.`,
      subject
    }).then((cancelResult) => {
      cancellation.cancelExitCode = cancelResult.exitCode;
      if (cancelResult.exitCode !== 0 && !treeTerminationPromise) {
        treeTerminationPromise = terminateProcessTree(child);
      }
    })
      .catch((error) => { cancellation.cancelError = error instanceof Error ? error.message : String(error); });
  }, 250);

  const processResult = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolve({ exitCode: exitCode ?? 1, signal }));
  }).finally(() => clearInterval(monitor));
  await cancelPromise;
  await treeTerminationPromise;
  lines.close();
  await writeFile(path.join(artifactDir, "subject.stdout.log"), redactor(stdout), "utf8");
  await writeFile(path.join(artifactDir, "subject.stderr.log"), redactor(stderr), "utf8");
  return {
    ...processResult,
    sessionId,
    result,
    events,
    cancellation,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt
  };
}

export { breachedBudget, budgetState, eventFromLine, nodeCliArgs };
