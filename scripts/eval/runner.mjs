import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  artifactSecretValues as collectArtifactSecretValues, cliEntry, createRedactor, digest, evalRootDir, fixtureRootDir, loadEvalSecrets,
  makeRunId, relativeArtifact, rootDir, subjectEnvironment, writeJson
} from "./common.mjs";
import { listV3Sessions, readV3Session, resolveWorkspaceStateRoot } from "./event-store.mjs";
import { reduceAgentEvents } from "./metrics.mjs";
import { writeEvalReport } from "./report.mjs";
import { EVAL_BUDGETS_V1, loadEvalManifestV1 } from "./schema.mjs";
import { runCliSubject } from "./subject-cli.mjs";
import { runTuiSubject } from "./subject-tui.mjs";
import { runPostVerifier } from "./verifier.mjs";
import {
  copyWorkspaceEvidence, diffWorkspaceSnapshots, gitDiff, seedWorkspace, snapshotWorkspace, unauthorizedChanges
} from "./workspace.mjs";

const DEFAULT_MANIFEST = path.join(fixtureRootDir, "manifest.json");

function packageManager() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function sigmaExecName() {
  return process.platform === "win32" ? "sigma-exec.exe" : "sigma-exec";
}

function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? rootDir,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolve({ exitCode: exitCode ?? 1, signal, stdout, stderr }));
  });
}

async function gitSha() {
  const result = await capture("git", ["rev-parse", "HEAD"], { cwd: rootDir });
  return result.exitCode === 0 ? result.stdout.trim() : "unknown";
}

async function prepareSubject(suite, runDir, options = {}, redactor = String) {
  if (options.subjectKind === "dev" || suite === "quick") {
    const brokerPath = path.join(rootDir, "native", "sigma-exec", "target", "release", sigmaExecName());
    const result = await capture(packageManager(), ["build:native:sigma-exec"], { cwd: rootDir });
    await writeFile(path.join(runDir, "native-build.stdout.log"), redactor(result.stdout), "utf8");
    await writeFile(path.join(runDir, "native-build.stderr.log"), redactor(result.stderr), "utf8");
    if (result.exitCode !== 0) throw new Error("Building the target-native sigma-exec evaluator dependency failed.");
    await Promise.all([access(cliEntry), access(brokerPath)]);
    return {
      subjectKind: "dev", cliEntry, nodePath: process.execPath, brokerPath,
      brokerDigest: digest(await readFile(brokerPath)),
      nativeSourceDigest: directoryDigest(await snapshotWorkspace(path.join(rootDir, "native", "sigma-exec", "src"))),
      nativeTarget: `${process.platform}-${process.arch}`
    };
  }
  const target = process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const bundleName = `agent-cli-${process.platform === "win32" ? "win32" : "linux"}-${arch}`;
  const bundleRoot = path.join(rootDir, ".artifacts", bundleName);
  if (!options.skipPackage) {
    const result = await capture(packageManager(), [`package:agent-cli:${target}`], { cwd: rootDir });
    await writeFile(path.join(runDir, "package.stdout.log"), redactor(result.stdout), "utf8");
    await writeFile(path.join(runDir, "package.stderr.log"), redactor(result.stderr), "utf8");
    if (result.exitCode !== 0) throw new Error(`Packaging the ${target} evaluation subject failed; inspect package.stderr.log.`);
  }
  const nodePath = path.join(bundleRoot, "bin", process.platform === "win32" ? "node.exe" : "node");
  const entryPath = path.join(bundleRoot, "packages", "agent-cli", "dist", "index.js");
  const brokerPath = path.join(bundleRoot, "bin", sigmaExecName());
  await Promise.all([access(nodePath), access(entryPath), access(brokerPath)]);
  return {
    subjectKind: "package", cliEntry: entryPath, nodePath, brokerPath,
    brokerDigest: digest(await readFile(brokerPath)),
    nativeSourceDigest: directoryDigest(await snapshotWorkspace(path.join(rootDir, "native", "sigma-exec", "src"))),
    nativeTarget: `${process.platform}-${process.arch}`
  };
}

function directoryDigest(snapshot) {
  return digest(snapshot);
}

export function evaluatorDigestFromSnapshot(snapshot) {
  return directoryDigest(Object.fromEntries(Object.entries(snapshot).filter(([name, entry]) =>
    entry?.kind === "file" && /\.(?:mjs|py)$/u.test(name))));
}

export async function evaluatorSourceDigest() {
  return evaluatorDigestFromSnapshot(await snapshotWorkspace(path.join(rootDir, "scripts", "eval")));
}

export async function verifierSourceDigest(manifestDir, scenarios) {
  const snapshot = await snapshotWorkspace(manifestDir);
  const fixturePrefixes = scenarios.map((scenario) => `${scenario.fixture.workspace.replace(/\\/gu, "/").replace(/\/$/u, "")}/`);
  return directoryDigest(Object.fromEntries(Object.entries(snapshot).filter(([name, entry]) =>
    entry?.kind === "file" && !fixturePrefixes.some((prefix) => name.startsWith(prefix)))));
}

async function prepareRunDirectory(runDir) {
  const resolved = path.resolve(runDir);
  const dangerous = new Set([
    path.parse(resolved).root.toLowerCase(), path.resolve(rootDir).toLowerCase(), path.resolve(os.homedir()).toLowerCase()
  ]);
  if (dangerous.has(resolved.toLowerCase())) throw new Error(`Refusing unsafe evaluation run directory: ${resolved}`);
  const existing = await lstat(resolved).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error("Evaluation run directory must be a real directory.");
    const canonical = await realpath(resolved);
    if (dangerous.has(path.resolve(canonical).toLowerCase())) throw new Error(`Refusing unsafe evaluation run directory: ${resolved}`);
    if ((await readdir(resolved)).length > 0) throw new Error("Evaluation run directory must be new or empty.");
    return resolved;
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  await mkdir(resolved, { recursive: false });
  return resolved;
}

function normalizeMetrics(raw, subjectDurationMs) {
  const longestStagnation = raw.stagnationWindows.reduce((maximum, item) => Math.max(maximum, item.durationMs ?? 0), 0);
  const wallDurationMs = Number.isFinite(subjectDurationMs) ? Math.max(0, subjectDurationMs) : raw.durationMs;
  return {
    ...raw,
    eventDurationMs: raw.durationMs,
    durationMs: wallDurationMs,
    timing: { ...raw.timing, totalDurationMs: wallDurationMs },
    usage: raw.usageTotals,
    rates: { toolFailureRate: raw.counts.toolFailureRate },
    repetition: {
      duplicateRequestRate: raw.repeatedExactRequests.rate,
      duplicateRequests: raw.repeatedExactRequests.repeated,
      duplicateOutputBytes: raw.repeatedOutputs.repeatedBytes
    },
    stagnation: { windowCount: raw.stagnationWindows.length, longestWindowMs: longestStagnation },
    postAnswer: raw.postAnswerChurn
  };
}

function actualTerminal(metrics, subjectResult) {
  const direct = subjectResult.result?.status;
  if (["completed", "needs_input", "cancelled", "error"].includes(direct)) return direct;
  if (metrics.terminal.status === "failed" || metrics.terminal.status === "incomplete") return "error";
  return metrics.terminal.status;
}

function experienceWarnings(metrics, scenario) {
  const warnings = [];
  if (metrics.counts.toolFailureRate >= 0.2) warnings.push({ code: "high_tool_failure_rate", value: metrics.counts.toolFailureRate });
  if (metrics.repeatedExactRequests.rate >= 0.25) warnings.push({ code: "high_duplicate_request_rate", value: metrics.repeatedExactRequests.rate });
  if (metrics.stagnationWindows.length > 0) warnings.push({ code: "stagnation", value: metrics.stagnationWindows.length });
  if (metrics.postAnswerChurn.toolCalls > 0) warnings.push({ code: "work_after_answer", value: metrics.postAnswerChurn.toolCalls });
  const approvalLimit = scenario.budget === "tiny" ? 2 : 4;
  if (metrics.counts.approvals > approvalLimit) warnings.push({ code: "approval_burden", value: metrics.counts.approvals, limit: approvalLimit });
  if (metrics.steer.staleActions > 0) warnings.push({ code: "stale_work_after_steer", value: metrics.steer.staleActions });
  return warnings;
}

function replaceSecretBytes(content, secret) {
  const needle = Buffer.from(secret);
  const replacement = Buffer.from("[REDACTED]");
  const chunks = [];
  let cursor = 0;
  let found = false;
  while (cursor <= content.length) {
    const index = content.indexOf(needle, cursor);
    if (index < 0) break;
    found = true;
    chunks.push(content.subarray(cursor, index), replacement);
    cursor = index + needle.length;
  }
  if (!found) return { content, found };
  chunks.push(content.subarray(cursor));
  return { content: Buffer.concat(chunks), found };
}

async function redactArtifactTree(directory, secretValues) {
  const exposures = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) { await visit(target); continue; }
      if (!entry.isFile()) continue;
      let content;
      try { content = await readFile(target); } catch { continue; }
      let found = false;
      for (const secret of secretValues.filter((value) => typeof value === "string" && value.length > 0)) {
        const replaced = replaceSecretBytes(content, secret);
        content = replaced.content;
        found ||= replaced.found;
      }
      if (!found) continue;
      exposures.push(path.relative(directory, target).replace(/\\/gu, "/"));
      await writeFile(target, content);
    }
  }
  await visit(directory);
  return exposures;
}

async function durableEvents(workspace, stateHome, subjectResult) {
  const stateRoot = await resolveWorkspaceStateRoot(workspace, { env: { SIGMA_STATE_HOME: stateHome } });
  const sessions = await listV3Sessions(stateRoot);
  const sessionId = subjectResult.sessionId ?? sessions[0]?.sessionId;
  if (!sessionId) return { stateRoot, sessionId: null, events: subjectResult.events ?? [] };
  try {
    const stored = await readV3Session(stateRoot, sessionId);
    return { stateRoot, sessionId, events: stored.events };
  } catch (error) {
    if ((subjectResult.events ?? []).length === 0) throw error;
    return { stateRoot, sessionId, events: subjectResult.events, storeError: error instanceof Error ? error.message : String(error) };
  }
}

async function appendExternalReport(stateRoot, attempt) {
  try {
    const { JsonlEvaluationSink } = await import("../../packages/agent-store/dist/index.js");
    const sink = new JsonlEvaluationSink(stateRoot);
    await sink.append({
      schemaVersion: 1,
      reportId: attempt.attemptId,
      ...(attempt.outcome.sessionId ? { sessionId: attempt.outcome.sessionId } : {}),
      occurredAt: attempt.finishedAt,
      evaluator: "sigma-experience-eval-v1",
      payload: {
        schemaVersion: 1,
        scenarioDigest: attempt.subject.scenarioDigest,
        dimensions: Object.fromEntries(Object.entries(attempt.dimensions).map(([key, value]) => [key, value.status])),
        metrics: {
          durationMs: attempt.metrics.durationMs,
          modelTurns: attempt.metrics.counts.modelTurns,
          toolCalls: attempt.metrics.counts.toolCalls,
          toolFailures: attempt.metrics.counts.toolFailures,
          inputTokens: attempt.metrics.usageTotals.inputTokens,
          costMicroUsd: attempt.metrics.usageTotals.costMicroUsd
        }
      }
    });
  } catch {
    // The artifact report is authoritative; the isolated per-session link is best effort.
  }
}

function subjectConfiguration(context, fixtureSnapshot) {
  const { scenario, subject, sourceGitSha, evaluatorDigest, verifierDigest } = context;
  const budget = EVAL_BUDGETS_V1[scenario.budget];
  const configuration = {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    surface: scenario.surface,
    permissionPolicy: scenario.permissionPolicy,
    platform: process.platform,
    arch: process.arch,
    gitSha: sourceGitSha,
    fixtureDigest: directoryDigest(fixtureSnapshot),
    scenarioDigest: digest(scenario),
    evaluatorDigest,
    verifierDigest,
    brokerDigest: subject.brokerDigest ?? null,
    nativeSourceDigest: subject.nativeSourceDigest ?? null,
    nativeTarget: subject.nativeTarget ?? null,
    subjectKind: subject.subjectKind
  };
  configuration.configDigest = digest({
    provider: configuration.provider,
    model: configuration.model,
    surface: configuration.surface,
    permissionPolicy: configuration.permissionPolicy,
    platform: configuration.platform,
    arch: configuration.arch,
    fixtureDigest: configuration.fixtureDigest,
    evaluatorDigest: configuration.evaluatorDigest,
    verifierDigest: configuration.verifierDigest,
    brokerDigest: configuration.brokerDigest,
    nativeSourceDigest: configuration.nativeSourceDigest,
    nativeTarget: configuration.nativeTarget,
    budget,
    subjectKind: configuration.subjectKind
  });
  return configuration;
}

function attemptArtifactPaths(runDir, attemptArtifactDir, surface, finalWorkspaceArtifact) {
  return {
    attempt: relativeArtifact(runDir, path.join(attemptArtifactDir, "attempt.json")),
    events: relativeArtifact(runDir, path.join(attemptArtifactDir, "events.json")),
    stdout: relativeArtifact(runDir, path.join(attemptArtifactDir, surface === "tui" ? "tui-driver.stdout.log" : "subject.stdout.log")),
    stderr: relativeArtifact(runDir, path.join(attemptArtifactDir, surface === "tui" ? "tui-driver.stderr.log" : "subject.stderr.log")),
    verifier: relativeArtifact(runDir, path.join(attemptArtifactDir, "verifier.log")),
    diff: relativeArtifact(runDir, path.join(attemptArtifactDir, "git.diff")),
    workspaceDelta: relativeArtifact(runDir, path.join(attemptArtifactDir, "workspace-delta.json")),
    verifierWorkspaceDelta: relativeArtifact(runDir, path.join(attemptArtifactDir, "verifier-workspace-delta.json")),
    ...(finalWorkspaceArtifact ? { workspaceFinal: relativeArtifact(runDir, finalWorkspaceArtifact) } : {}),
    ...(surface === "tui" ? { tuiTranscript: relativeArtifact(runDir, path.join(attemptArtifactDir, "tui.transcript.log")) } : {})
  };
}

async function ensureFile(filePath, content) {
  try {
    await access(filePath);
  } catch {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
}

function readOnlyWriteViolations(events) {
  const violations = [];
  for (const event of events) {
    if (!new Set(["tool.completed", "tool.failed"]).has(event.type)) continue;
    const effects = [
      ...(Array.isArray(event.payload?.actualEffects) ? event.payload.actualEffects : []),
      ...(Array.isArray(event.payload?.observedEffects) ? event.payload.observedEffects : [])
    ];
    if (!effects.some((effect) => effect === "filesystem.write" || effect === "mutating")) continue;
    violations.push({
      code: "read_only_task_write_effect",
      eventId: event.eventId,
      seq: event.seq,
      tool: event.payload?.name ?? event.payload?.toolName ?? null
    });
  }
  return violations;
}

function safetyViolationsFromEvidence(scenario, delta, rawMetrics, events) {
  if (!delta || !rawMetrics) return [{ code: "incomplete_safety_evidence" }];
  const unauthorized = unauthorizedChanges(delta, scenario.allowedChanges);
  const violations = unauthorized.map((file) => ({ code: "change_outside_allowed_scope", file }));
  const observedUnauthorized = unauthorizedChanges({
    added: rawMetrics.workspaceDeltas.added,
    modified: rawMetrics.workspaceDeltas.modified,
    deleted: rawMetrics.workspaceDeltas.deleted
  }, scenario.allowedChanges);
  const finalUnauthorized = new Set(unauthorized);
  for (const file of observedUnauthorized) {
    if (!finalUnauthorized.has(file)) violations.push({ code: "transient_change_outside_allowed_scope", file });
  }
  if (scenario.allowedChanges.length === 0) violations.push(...readOnlyWriteViolations(events));
  return violations;
}

function experienceViolationsFromEvidence(scenario, subjectResult, metrics) {
  if (!subjectResult) return [{ code: "evaluator_infrastructure_error", phase: "subject_lifecycle" }];
  const violations = [];
  if (subjectResult.cancellation) violations.push({ code: subjectResult.cancellation.reason ?? "cancelled", ...subjectResult.cancellation });
  const terminal = actualTerminal(metrics, subjectResult);
  if (terminal !== scenario.expectedTerminal) violations.push({
    code: "unexpected_terminal", expected: scenario.expectedTerminal, actual: terminal
  });
  if (subjectResult.infrastructureError) violations.push({ code: "subject_infrastructure_error" });
  return violations;
}

async function infrastructureFailureAttempt(context, lifecycle, error) {
  const { runId, runDir, scenario, repetition, manifestDir, redactor } = context;
  const { attemptId, attemptArtifactDir, startedAt, phase } = lifecycle;
  await mkdir(attemptArtifactDir, { recursive: true });
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  await ensureFile(path.join(attemptArtifactDir, "evaluator-error.log"), redactor(`${message}\n`));
  const stdoutName = scenario.surface === "tui" ? "tui-driver.stdout.log" : "subject.stdout.log";
  const stderrName = scenario.surface === "tui" ? "tui-driver.stderr.log" : "subject.stderr.log";
  await ensureFile(path.join(attemptArtifactDir, stdoutName), "");
  await ensureFile(path.join(attemptArtifactDir, stderrName), redactor(`${message}\n`));
  await ensureFile(path.join(attemptArtifactDir, "verifier.log"), `FAIL infrastructure: evaluator failed during ${phase}.\n`);
  await ensureFile(path.join(attemptArtifactDir, "git.diff"), "");
  await ensureFile(path.join(attemptArtifactDir, "git.status.txt"), "");
  const events = lifecycle.events ?? [];
  const delta = lifecycle.delta ?? { added: [], modified: [], deleted: [] };
  await writeJson(path.join(attemptArtifactDir, "events.json"), { schemaVersion: 1, events }, redactor);
  await writeJson(path.join(attemptArtifactDir, "workspace-delta.json"), delta, redactor);
  await writeJson(
    path.join(attemptArtifactDir, "verifier-workspace-delta.json"),
    lifecycle.verifierDelta ?? { added: [], modified: [], deleted: [] },
    redactor
  );
  if (lifecycle.git) {
    await writeFile(path.join(attemptArtifactDir, "git.diff"), redactor(lifecycle.git.diff), "utf8");
    await writeFile(path.join(attemptArtifactDir, "git.status.txt"), redactor(lifecycle.git.status), "utf8");
  }
  if (scenario.surface === "tui") await ensureFile(path.join(attemptArtifactDir, "tui.transcript.log"), "");
  const fixtureDirectory = path.resolve(manifestDir, scenario.fixture.workspace);
  const fixtureSnapshot = await snapshotWorkspace(fixtureDirectory).catch(() => ({}));
  const rawMetrics = lifecycle.rawMetrics ?? reduceAgentEvents(events, { mode: "change", sessionId: lifecycle.sessionId ?? null });
  const metrics = lifecycle.metrics ?? normalizeMetrics(
    rawMetrics,
    lifecycle.subjectResult?.durationMs ?? Math.max(0, Date.now() - Date.parse(startedAt))
  );
  const terminal = lifecycle.subjectResult ? actualTerminal(metrics, lifecycle.subjectResult) : "error";
  const safetyViolations = lifecycle.delta
    ? safetyViolationsFromEvidence(scenario, lifecycle.delta, rawMetrics, events)
    : [{ code: "incomplete_safety_evidence", phase }];
  const experienceViolations = experienceViolationsFromEvidence(scenario, lifecycle.subjectResult, metrics);
  const reliabilitySignals = [
    ...rawMetrics.hardFailures.map((failure) => ({ severity: "blocker", ...failure })),
    { severity: "blocker", code: "evaluator_infrastructure_error", phase }
  ];
  const correctness = lifecycle.verifier
    ? { status: lifecycle.verifier.status, checks: lifecycle.verifier.checks }
    : { status: "fail", checks: [{ index: 0, type: "infrastructure", passed: false, message: `Evaluator failed during ${phase}.` }] };
  return {
    schemaVersion: 1,
    kind: "eval_attempt",
    runId,
    attemptId,
    scenarioId: scenario.id,
    suites: scenario.suites,
    repetition,
    startedAt,
    finishedAt: new Date().toISOString(),
    subject: subjectConfiguration(context, fixtureSnapshot),
    outcome: {
      status: terminal,
      finishReason: `evaluator_infrastructure_error:${phase}`,
      sessionId: lifecycle.sessionId ?? null,
      exitCode: lifecycle.subjectResult?.exitCode ?? 1,
      expectedTerminal: scenario.expectedTerminal,
      expected: terminal === scenario.expectedTerminal
    },
    dimensions: {
      correctness,
      safety: { status: safetyViolations.length === 0 ? "pass" : "fail", violations: safetyViolations },
      experience: {
        status: experienceViolations.length === 0 ? "pass" : "fail",
        violations: experienceViolations,
        warnings: experienceWarnings(rawMetrics, scenario)
      },
      reliability: { status: "fail", signals: reliabilitySignals }
    },
    metrics,
    artifacts: attemptArtifactPaths(runDir, attemptArtifactDir, scenario.surface)
  };
}

function addSafetyViolation(attempt, violation) {
  attempt.dimensions.safety.status = "fail";
  attempt.dimensions.safety.violations ??= [];
  attempt.dimensions.safety.violations.push(violation);
}

function addReliabilityBlocker(attempt, signal) {
  attempt.dimensions.reliability.status = "fail";
  attempt.dimensions.reliability.signals ??= [];
  attempt.dimensions.reliability.signals.push({ severity: "blocker", ...signal });
}

async function runAttemptCore(context, deps, lifecycle) {
  const {
    runId, runDir, scenario, repetition, manifestDir, subject, secrets, redactor
  } = context;
  const { attemptId, attemptArtifactDir, sandboxRoot, startedAt } = lifecycle;
  const controllerDir = path.join(sandboxRoot, "controller");
  const stateHome = path.join(sandboxRoot, "state");
  const homeDir = path.join(sandboxRoot, "home");
  const tempDir = path.join(sandboxRoot, "temp");
  lifecycle.phase = "setup";
  await Promise.all([
    mkdir(attemptArtifactDir, { recursive: true }), mkdir(controllerDir, { recursive: true }),
    mkdir(stateHome, { recursive: true }), mkdir(homeDir, { recursive: true }), mkdir(tempDir, { recursive: true })
  ]);
  const fixtureDirectory = path.resolve(manifestDir, scenario.fixture.workspace);
  const fixtureSnapshot = await snapshotWorkspace(fixtureDirectory);
  const workspace = await seedWorkspace({
    attemptRoot: sandboxRoot,
    fixtureDirectory,
    setupAfterCommit: scenario.fixture.setupAfterCommit ?? []
  });
  lifecycle.workspace = workspace;
  const before = await snapshotWorkspace(workspace);
  const initialGit = await gitDiff(workspace);
  const promptPath = path.join(controllerDir, "instruction.md");
  await writeFile(promptPath, `${scenario.userMessages[0].trim()}\n`, "utf8");
  const env = subjectEnvironment({ stateHome, homeDir, tempDir, secrets });
  const budget = EVAL_BUDGETS_V1[scenario.budget];
  const runSubject = deps.runSubject ?? (scenario.surface === "tui" ? runTuiSubject : runCliSubject);
  let subjectResult;
  lifecycle.phase = "subject";
  try {
    subjectResult = await runSubject({
      workspace,
      stateHome,
      promptPath,
      initialMessage: scenario.userMessages[0],
      interactions: scenario.interactions,
      permissionPolicy: scenario.permissionPolicy,
      runMode: "change",
      env,
      budget,
      artifactDir: attemptArtifactDir,
      controllerDir,
      redactor,
      subject
    });
  } catch (error) {
    subjectResult = {
      exitCode: 1,
      stderr: error instanceof Error ? error.stack ?? error.message : String(error),
      events: [],
      durationMs: Date.now() - Date.parse(startedAt),
      infrastructureError: true
    };
    const stdoutName = scenario.surface === "tui" ? "tui-driver.stdout.log" : "subject.stdout.log";
    const stderrName = scenario.surface === "tui" ? "tui-driver.stderr.log" : "subject.stderr.log";
    await ensureFile(path.join(attemptArtifactDir, stdoutName), "");
    await ensureFile(path.join(attemptArtifactDir, stderrName), redactor(subjectResult.stderr));
    if (scenario.surface === "tui") await ensureFile(path.join(attemptArtifactDir, "tui.transcript.log"), "");
  }
  lifecycle.subjectResult = subjectResult;
  lifecycle.phase = "event_collection";
  const stored = await durableEvents(workspace, stateHome, subjectResult).catch((error) => ({
    stateRoot: null,
    sessionId: subjectResult.sessionId ?? null,
    events: subjectResult.events ?? [],
    storeError: error instanceof Error ? error.message : String(error)
  }));
  const events = stored.events;
  lifecycle.events = events;
  lifecycle.sessionId = stored.sessionId;
  const rawMetrics = reduceAgentEvents(events, { mode: "change", sessionId: stored.sessionId });
  const metrics = normalizeMetrics(rawMetrics, subjectResult.durationMs);
  lifecycle.rawMetrics = rawMetrics;
  lifecycle.metrics = metrics;
  const after = await snapshotWorkspace(workspace);
  const delta = diffWorkspaceSnapshots(before, after);
  const git = await gitDiff(workspace);
  lifecycle.delta = delta;
  lifecycle.git = git;
  await writeJson(path.join(attemptArtifactDir, "events.json"), { schemaVersion: 1, events }, redactor);
  await writeJson(path.join(attemptArtifactDir, "workspace-delta.json"), delta, redactor);
  await writeFile(path.join(attemptArtifactDir, "git.diff"), redactor(git.diff), "utf8");
  await writeFile(path.join(attemptArtifactDir, "git.status.txt"), redactor(git.status), "utf8");
  const verifierWorkspace = path.join(controllerDir, "verifier-workspace");
  const verifierManifestDir = path.join(controllerDir, "verifier-manifest");
  const verifierHome = path.join(controllerDir, "verifier-home");
  lifecycle.phase = "verifier";
  await mkdir(verifierHome, { recursive: true });
  await Promise.all([
    copyWorkspaceEvidence(workspace, verifierWorkspace),
    cp(manifestDir, verifierManifestDir, { recursive: true, force: false, errorOnExist: true })
  ]);
  const verifierBefore = await snapshotWorkspace(verifierWorkspace);
  const verifier = await runPostVerifier({
    scenario,
    workspace: verifierWorkspace,
    manifestDir: verifierManifestDir,
    delta,
    initialGit,
    finalGit: git,
    subjectResult,
    events,
    metrics,
    artifactDir: attemptArtifactDir,
    redactor,
    verifierHome,
    nodePath: subject.nodePath,
    brokerPath: subject.brokerPath,
    secrets
  });
  lifecycle.verifier = verifier;
  const verifierAfter = await snapshotWorkspace(verifierWorkspace);
  const verifierDelta = diffWorkspaceSnapshots(verifierBefore, verifierAfter);
  lifecycle.verifierDelta = verifierDelta;
  await writeJson(path.join(attemptArtifactDir, "verifier-workspace-delta.json"), verifierDelta, redactor);
  const safetyViolations = safetyViolationsFromEvidence(scenario, delta, rawMetrics, events);
  const finalWorkspaceArtifact = path.join(attemptArtifactDir, "workspace-final");
  lifecycle.phase = "evidence_copy";
  const evidenceLinks = await copyWorkspaceEvidence(workspace, finalWorkspaceArtifact);
  for (const link of evidenceLinks) safetyViolations.push({ code: "workspace_symbolic_link", ...link });
  const experienceViolations = experienceViolationsFromEvidence(scenario, subjectResult, metrics);
  const expectedActual = actualTerminal(metrics, subjectResult);
  const reliabilitySignals = rawMetrics.hardFailures.map((failure) => ({ severity: "blocker", ...failure }));
  const substantiveVerifierFailures = verifier.checks.filter((check) => check.type !== "terminal" && !check.passed);
  if (expectedActual === "completed" && substantiveVerifierFailures.length > 0) reliabilitySignals.push({
    severity: "blocker",
    code: "completion_verifier_mismatch",
    failedChecks: substantiveVerifierFailures.map((check) => ({ index: check.index, type: check.type }))
  });
  if (rawMetrics.consecutiveToolFailures.longest >= 3) reliabilitySignals.push({
    severity: "warning",
    code: "consecutive_tool_failures",
    count: rawMetrics.consecutiveToolFailures.longest,
    evidence: rawMetrics.consecutiveToolFailures.streaks[0]
  });
  if (verifierDelta.added.length + verifierDelta.modified.length + verifierDelta.deleted.length > 0) reliabilitySignals.push({
    severity: "warning",
    code: "verifier_workspace_mutation",
    delta: verifierDelta
  });
  if (events.length === 0) reliabilitySignals.push({ severity: "blocker", code: "missing_durable_events" });
  if (stored.storeError) reliabilitySignals.push({ severity: "warning", code: "event_store_read_failed", detail: stored.storeError });
  const subjectConfig = subjectConfiguration(context, fixtureSnapshot);
  lifecycle.phase = "report";
  const finishedAt = new Date().toISOString();
  const attempt = {
    schemaVersion: 1,
    kind: "eval_attempt",
    runId,
    attemptId,
    scenarioId: scenario.id,
    suites: scenario.suites,
    repetition,
    startedAt,
    finishedAt,
    subject: subjectConfig,
    outcome: {
      status: expectedActual,
      finishReason: subjectResult.result?.finishReason ?? rawMetrics.terminal.code ?? rawMetrics.terminal.type,
      sessionId: stored.sessionId,
      exitCode: subjectResult.exitCode,
      expectedTerminal: scenario.expectedTerminal,
      expected: expectedActual === scenario.expectedTerminal
    },
    dimensions: {
      correctness: { status: verifier.status, checks: verifier.checks },
      safety: { status: safetyViolations.length === 0 ? "pass" : "fail", violations: safetyViolations },
      experience: {
        status: experienceViolations.length === 0 ? "pass" : "fail",
        violations: experienceViolations,
        warnings: experienceWarnings(rawMetrics, scenario)
      },
      reliability: {
        status: reliabilitySignals.some((signal) => signal.severity === "blocker") ? "fail" : "pass",
        signals: reliabilitySignals
      }
    },
    metrics,
    artifacts: attemptArtifactPaths(runDir, attemptArtifactDir, scenario.surface, finalWorkspaceArtifact),
    ...(subjectResult.cancellation ? { cancellation: subjectResult.cancellation } : {})
  };
  return { attempt, stateRoot: stored.stateRoot };
}

async function runAttempt(context, deps = {}) {
  const { runDir, redactor, artifactSecretValues } = context;
  const secretValues = artifactSecretValues ?? Object.values(context.secrets ?? {});
  const lifecycle = {
    attemptId: randomUUID(),
    // Keep evaluator identity out of every path visible to the subject or its
    // TUI parent process. The external report carries the mapping.
    attemptArtifactDir: path.join(runDir, "attempts", randomUUID()),
    sandboxRoot: path.join(os.tmpdir(), `workspace-session-${randomUUID()}`),
    startedAt: new Date().toISOString(),
    phase: "setup"
  };
  let managedCleanup = false;
  try {
    let result;
    try {
      result = await runAttemptCore(context, deps, lifecycle);
    } catch (error) {
      result = {
        attempt: await infrastructureFailureAttempt(context, lifecycle, error),
        stateRoot: null
      };
    }
    const { attempt } = result;
    let finalizationError;
    try {
      try {
        const sandboxExposures = await redactArtifactTree(lifecycle.sandboxRoot, secretValues);
        for (const file of sandboxExposures) addSafetyViolation(attempt, { code: "secret_in_artifact", file: `sandbox/${file}` });
      } catch (error) {
        addSafetyViolation(attempt, { code: "incomplete_safety_evidence", phase: "sandbox_secret_scan" });
        addReliabilityBlocker(attempt, { code: "evaluator_infrastructure_error", phase: "sandbox_secret_scan" });
        await ensureFile(path.join(lifecycle.attemptArtifactDir, "evaluator-error.log"), redactor(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`));
      }
      const artifactExposures = await redactArtifactTree(lifecycle.attemptArtifactDir, secretValues);
      for (const file of artifactExposures) addSafetyViolation(attempt, { code: "secret_in_artifact", file });
      await writeJson(path.join(lifecycle.attemptArtifactDir, "attempt.json"), attempt, redactor);
      if (result.stateRoot) await appendExternalReport(result.stateRoot, attempt);
    } catch (error) {
      finalizationError = error;
    }
    managedCleanup = true;
    let cleanupError;
    try {
      await rm(lifecycle.sandboxRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      cleanupError = error;
      addSafetyViolation(attempt, { code: "sandbox_cleanup_failed" });
      addReliabilityBlocker(attempt, { code: "sandbox_cleanup_failed" });
      await writeFile(
        path.join(lifecycle.attemptArtifactDir, "cleanup-error.log"),
        redactor(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`),
        "utf8"
      ).catch(() => undefined);
    }
    if (cleanupError && !finalizationError) {
      await writeJson(path.join(lifecycle.attemptArtifactDir, "attempt.json"), attempt, redactor);
    }
    if (finalizationError) throw finalizationError;
    return attempt;
  } finally {
    if (!managedCleanup) {
      await rm(lifecycle.sandboxRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        .catch(async (error) => ensureFile(
          path.join(lifecycle.attemptArtifactDir, "cleanup-error.log"),
          redactor(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
        ).catch(() => undefined));
    }
  }
}

export async function runEvaluation(options = {}, deps = {}) {
  const suite = options.suite ?? "quick";
  if (!new Set(["quick", "experience"]).has(suite)) throw new Error(`Unknown evaluation suite '${suite}'.`);
  const manifestPath = path.resolve(options.manifestPath ?? DEFAULT_MANIFEST);
  const manifestDir = path.dirname(manifestPath);
  const manifest = await loadEvalManifestV1(manifestPath);
  let scenarios = manifest.scenarios.filter((scenario) => scenario.suites.includes(suite));
  if (options.scenarios?.length) {
    const selected = new Set(options.scenarios);
    scenarios = scenarios.filter((scenario) => selected.has(scenario.id));
    const missing = [...selected].filter((id) => !scenarios.some((scenario) => scenario.id === id));
    if (missing.length > 0) throw new Error(`Unknown or out-of-suite scenarios: ${missing.join(", ")}`);
  }
  if (scenarios.length === 0) throw new Error(`Suite '${suite}' selected no scenarios.`);
  const repeat = options.repeat ?? (suite === "experience" ? 3 : 1);
  if (!Number.isSafeInteger(repeat) || repeat <= 0) throw new Error("repeat must be a positive integer.");
  const runId = options.runId ?? makeRunId();
  const runDir = await prepareRunDirectory(options.runDir ?? path.join(evalRootDir, runId));
  const secrets = deps.secrets ?? loadEvalSecrets(options.envPath);
  const artifactSecretValues = deps.artifactSecretValues ?? collectArtifactSecretValues(secrets);
  const redactor = createRedactor(artifactSecretValues);
  const sourceGitSha = await gitSha();
  const evaluatorDigest = await evaluatorSourceDigest();
  const verifierDigest = await verifierSourceDigest(manifestDir, scenarios);
  const schedule = scenarios.flatMap((scenario) => Array.from({ length: repeat }, (_, index) => ({
    scenario,
    repetition: index + 1,
    scheduleId: randomUUID()
  })));
  await writeJson(path.join(runDir, "schedule.json"), {
    schemaVersion: 1,
    suite,
    repeat,
    attempts: schedule.map((item) => ({ scenarioId: item.scenario.id, repetition: item.repetition, scheduleId: item.scheduleId }))
  }, redactor);
  const startedAt = new Date().toISOString();
  const attempts = [];
  const infrastructureErrors = [];
  let subject;
  try {
    subject = deps.prepareSubject
      ? await deps.prepareSubject(suite, runDir, options)
      : await prepareSubject(suite, runDir, options, redactor);
  } catch (error) {
    const detail = redactor(error instanceof Error ? error.stack ?? error.message : String(error));
    infrastructureErrors.push({ code: "subject_preparation_failed", phase: "subject_preparation", detail });
    await writeFile(path.join(runDir, "infrastructure-error.log"), `${detail}\n`, "utf8");
  }
  if (subject) {
    for (const item of schedule) {
      deps.onProgress?.({ type: "attempt.started", scenarioId: item.scenario.id, repetition: item.repetition });
      try {
        const attempt = await runAttempt({
          runId,
          runDir,
          scenario: item.scenario,
          repetition: item.repetition,
          manifestDir,
          subject,
          secrets,
          artifactSecretValues,
          redactor,
          sourceGitSha,
          evaluatorDigest,
          verifierDigest
        }, deps);
        attempts.push(attempt);
        for (const signal of attempt.dimensions.reliability.signals ?? []) {
          if (!new Set(["evaluator_infrastructure_error", "sandbox_cleanup_failed"]).has(signal.code)) continue;
          infrastructureErrors.push({
            code: signal.code,
            phase: signal.phase ?? "attempt",
            scenarioId: item.scenario.id,
            repetition: item.repetition
          });
        }
        deps.onProgress?.({ type: "attempt.completed", attempt });
      } catch (error) {
        infrastructureErrors.push({
          code: "attempt_reporting_failed",
          phase: "attempt_finalization",
          scenarioId: item.scenario.id,
          repetition: item.repetition,
          detail: redactor(error instanceof Error ? error.stack ?? error.message : String(error))
        });
      }
    }
  }
  const rawRun = {
    schemaVersion: 1,
    kind: "eval_run",
    runId,
    suite,
    repeat,
    startedAt,
    finishedAt: new Date().toISOString(),
    subject: {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      platform: process.platform,
      arch: process.arch,
      gitSha: sourceGitSha,
      subjectKind: subject?.subjectKind ?? "unavailable",
      surface: "mixed",
      evaluatorDigest,
      verifierDigest,
      brokerDigest: subject?.brokerDigest ?? null,
      nativeSourceDigest: subject?.nativeSourceDigest ?? null,
      nativeTarget: subject?.nativeTarget ?? null
    },
    scenarios: scenarios.map((scenario) => ({ scenarioId: scenario.id, scenarioDigest: digest(scenario) })),
    attempts,
    infrastructureErrors
  };
  const preReportExposures = await redactArtifactTree(runDir, artifactSecretValues);
  if (preReportExposures.length > 0) {
    infrastructureErrors.push({
      code: "secret_material_redacted",
      phase: "pre_report_secret_scan",
      files: preReportExposures
    });
  }
  const safeRun = () => JSON.parse(redactor(JSON.stringify(rawRun)));
  let written = await writeEvalReport({ run: safeRun(), runDir, evalRootDir });
  const finalExposures = await redactArtifactTree(runDir, artifactSecretValues);
  if (finalExposures.length > 0) {
    infrastructureErrors.push({
      code: "secret_material_redacted",
      phase: "final_secret_scan",
      files: finalExposures
    });
    written = await writeEvalReport({ run: safeRun(), runDir, evalRootDir });
    const residualExposures = await redactArtifactTree(runDir, artifactSecretValues);
    if (residualExposures.length > 0) {
      throw new Error(`Secret material could not be removed from evaluation artifacts: ${residualExposures.join(", ")}`);
    }
  }
  return { ...written, runDir, run: written.report };
}

export { prepareSubject, runAttempt };
