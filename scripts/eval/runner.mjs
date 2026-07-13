import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  artifactSecretValues as collectArtifactSecretValues, cliEntry, createRedactor, digest, evalRootDir, fixtureRootDir, loadEvalSecrets,
  makeRunId, relativeArtifact, rootDir, subjectEnvironment, writeJson
} from "./common.mjs";
import { listV4Sessions, readV4Session, resolveWorkspaceStateRoot } from "./event-store.mjs";
import { reduceAgentEvents } from "./metrics.mjs";
import { writeEvalReport } from "./report.mjs";
import { EVAL_BUDGETS_V1, loadEvalManifestV1 } from "./schema.mjs";
import { runCliSubject } from "./subject-cli.mjs";
import {
  applySubjectLaunchEnvironment, createDevNodeLaunch, loadPackagedSubjectLaunch
} from "./subject-launch.mjs";
import { runTuiSubject } from "./subject-tui.mjs";
import { runPostVerifier } from "./verifier.mjs";
import {
  copyWorkspaceEvidence, diffWorkspaceSnapshots, gitDiff, seedWorkspace, snapshotWorkspace, unauthorizedChanges
} from "./workspace.mjs";
import { sigmaManifest } from "../lib/sigma-manifest.mjs";

const DEFAULT_MANIFEST = path.join(fixtureRootDir, "manifest.json");

export function packageManagerInvocation(args, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === "win32") {
    return {
      command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", "pnpm.cmd", ...args]
    };
  }
  return { command: "pnpm", args: [...args] };
}

export function resolveEvaluatorHost(platform = process.platform, arch = process.arch) {
  if (platform === "linux" && arch === "x64") return {
    packageTarget: "linux", targetPlatform: "linux", targetArch: "x64",
    bundleName: "agent-cli-linux-x64", brokerName: "sigma-exec", nativeTarget: "linux-x64"
  };
  if (platform === "win32" && arch === "x64") return {
    packageTarget: "windows", targetPlatform: "win32", targetArch: "x64",
    bundleName: "agent-cli-win32-x64", brokerName: "sigma-exec.exe", nativeTarget: "win32-x64"
  };
  throw Object.assign(new Error(
    `Unsupported evaluator host '${platform}-${arch}'. Supported hosts are linux-x64 and win32-x64.`
  ), { code: "unsupported_evaluator_host", platform, arch });
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

async function digestTrees(trees) {
  const entries = {};
  for (const tree of trees) {
    const snapshot = await snapshotWorkspace(tree.directory);
    for (const [name, value] of Object.entries(snapshot)) entries[`${tree.label}/${name}`] = value;
  }
  return directoryDigest(entries);
}

async function devRuntimeTrees() {
  const trees = [];
  for (const entry of await readdir(path.join(rootDir, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(rootDir, "packages", entry.name, "dist");
    try {
      await access(directory);
      trees.push({ label: `packages/${entry.name}/dist`, directory });
    } catch {
      // Packages without runtime output are not part of the executable subject.
    }
  }
  const assets = path.join(rootDir, "assets");
  await access(assets);
  trees.push({ label: "assets", directory: assets });
  return trees;
}

async function subjectIdentity({ subjectKind, cliTreeDigest, nodePath, brokerPath }) {
  const [nodeDigest, brokerDigest] = await Promise.all([
    readFile(nodePath).then(digest),
    readFile(brokerPath).then(digest)
  ]);
  return {
    nodeDigest,
    brokerDigest,
    cliTreeDigest,
    subjectDigest: digest({ subjectKind, cliTreeDigest, nodeDigest, brokerDigest })
  };
}

async function prepareSubject(runDir, options = {}, redactor = String) {
  const host = resolveEvaluatorHost(options.platform, options.arch);
  const subjectKind = options.subjectKind ?? "package";
  if (!new Set(["dev", "package"]).has(subjectKind)) {
    throw new Error("Evaluation subject must be 'package' or 'dev'.");
  }
  if (options.skipPackage && subjectKind !== "package") {
    throw new Error("--skip-package is valid only with --subject package.");
  }
  if (subjectKind === "dev") {
    const brokerPath = path.join(rootDir, "native", "sigma-exec", "target", "release", host.brokerName);
    const invocation = packageManagerInvocation(["build:native:sigma-exec"]);
    const result = await capture(invocation.command, invocation.args, { cwd: rootDir });
    await writeFile(path.join(runDir, "native-build.stdout.log"), redactor(result.stdout), "utf8");
    await writeFile(path.join(runDir, "native-build.stderr.log"), redactor(result.stderr), "utf8");
    if (result.exitCode !== 0) throw new Error("Building the target-native sigma-exec evaluator dependency failed.");
    await Promise.all([access(cliEntry), access(brokerPath)]);
    const identity = await subjectIdentity({
      subjectKind,
      cliTreeDigest: await digestTrees(await devRuntimeTrees()),
      nodePath: process.execPath,
      brokerPath
    });
    return {
      subjectKind, cliEntry, nodePath: process.execPath, brokerPath,
      launch: createDevNodeLaunch(process.execPath, cliEntry),
      ...identity,
      nativeSourceDigest: directoryDigest(await snapshotWorkspace(path.join(rootDir, "native", "sigma-exec", "src"))),
      nativeTarget: host.nativeTarget
    };
  }
  const bundleRoot = path.join(rootDir, ".artifacts", host.bundleName);
  if (!options.skipPackage) {
    const invocation = packageManagerInvocation([`package:agent-cli:${host.packageTarget}`]);
    const result = await capture(invocation.command, invocation.args, { cwd: rootDir });
    await writeFile(path.join(runDir, "package.stdout.log"), redactor(result.stdout), "utf8");
    await writeFile(path.join(runDir, "package.stderr.log"), redactor(result.stderr), "utf8");
    if (result.exitCode !== 0) throw new Error(`Packaging the ${host.packageTarget} evaluation subject failed; inspect package.stderr.log.`);
  }
  const packaged = await loadPackagedSubjectLaunch(bundleRoot, {
    targetPlatform: host.targetPlatform,
    targetArch: host.targetArch
  });
  const { nodePath, brokerPath } = packaged;
  const identity = await subjectIdentity({
    subjectKind,
    cliTreeDigest: directoryDigest(await snapshotWorkspace(bundleRoot)),
    nodePath,
    brokerPath
  });
  return {
    subjectKind, ...packaged, ...identity,
    nativeSourceDigest: directoryDigest(await snapshotWorkspace(path.join(rootDir, "native", "sigma-exec", "src"))),
    nativeTarget: host.nativeTarget
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

async function scanArtifactTree(directory, secretValues) {
  const exposures = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) { await visit(target); continue; }
      if (!entry.isFile()) continue;
      let content;
      try { content = await readFile(target); } catch { continue; }
      if (!secretValues.some((secret) => typeof secret === "string" && secret.length > 0
        && content.includes(Buffer.from(secret)))) continue;
      exposures.push(path.relative(directory, target).replace(/\\/gu, "/"));
    }
  }
  await visit(directory);
  return exposures;
}

async function durableEvents(workspace, stateHome, subjectResult) {
  const stateRoot = await resolveWorkspaceStateRoot(workspace, { env: { SIGMA_STATE_HOME: stateHome } });
  const sessions = await listV4Sessions(stateRoot);
  const sessionId = subjectResult.sessionId ?? sessions[0]?.sessionId;
  if (!sessionId) return { stateRoot, sessionId: null, events: subjectResult.events ?? [] };
  try {
    const stored = await readV4Session(stateRoot, sessionId);
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
    model: sigmaManifest.evaluation.model,
    surface: scenario.surface,
    permissionPolicy: scenario.permissionPolicy,
    platform: process.platform,
    arch: process.arch,
    gitSha: sourceGitSha,
    fixtureDigest: directoryDigest(fixtureSnapshot),
    scenarioDigest: digest(scenario),
    evaluatorDigest,
    verifierDigest,
    nodeDigest: subject.nodeDigest ?? null,
    cliTreeDigest: subject.cliTreeDigest ?? null,
    brokerDigest: subject.brokerDigest ?? null,
    subjectDigest: subject.subjectDigest ?? null,
    nativeSourceDigest: subject.nativeSourceDigest ?? null,
    nativeTarget: subject.nativeTarget ?? null,
    subjectKind: subject.subjectKind
  };
  configuration.environmentDigest = digest({
    provider: configuration.provider,
    model: configuration.model,
    surface: configuration.surface,
    permissionPolicy: configuration.permissionPolicy,
    platform: configuration.platform,
    arch: configuration.arch,
    fixtureDigest: configuration.fixtureDigest,
    evaluatorDigest: configuration.evaluatorDigest,
    verifierDigest: configuration.verifierDigest,
    budget
  });
  // configDigest remains as a compatibility alias for schema-v1 readers. It
  // now describes controlled evaluation conditions rather than subject bytes.
  configuration.configDigest = configuration.environmentDigest;
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

async function writeInfrastructureFailureArtifacts(context, lifecycle, message) {
  const { scenario, redactor } = context;
  const { attemptArtifactDir, phase } = lifecycle;
  await mkdir(attemptArtifactDir, { recursive: true });
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
}

async function infrastructureAttemptEvidence(context, lifecycle) {
  const { scenario, manifestDir } = context;
  const { startedAt, phase } = lifecycle;
  const events = lifecycle.events ?? [];
  const delta = lifecycle.delta ?? { added: [], modified: [], deleted: [] };
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
    fixtureSnapshot, rawMetrics, metrics, terminal, safetyViolations, experienceViolations, reliabilitySignals, correctness,
    delta, events
  };
}

function infrastructureAttemptReport(context, lifecycle, evidence) {
  const { runId, runDir, scenario, repetition } = context;
  const { attemptId, attemptArtifactDir, startedAt, phase } = lifecycle;
  const { fixtureSnapshot, rawMetrics, metrics, terminal, safetyViolations, experienceViolations,
    reliabilitySignals, correctness } = evidence;
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

async function infrastructureFailureAttempt(context, lifecycle, error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  await writeInfrastructureFailureArtifacts(context, lifecycle, message);
  const evidence = await infrastructureAttemptEvidence(context, lifecycle);
  return infrastructureAttemptReport(context, lifecycle, evidence);
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

async function prepareAttemptExecution(context, deps, lifecycle) {
  const { scenario, manifestDir, subject, secrets } = context;
  const { attemptArtifactDir, sandboxRoot } = lifecycle;
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
  const baseSubjectEnv = subjectEnvironment({ stateHome, homeDir, tempDir, secrets });
  // An injected runSubject owns process creation and may use a synthetic
  // subject in unit tests. The built-in launchers always require the prepared
  // descriptor and apply its package-bound environment here.
  const env = deps.runSubject && !subject.launch
    ? baseSubjectEnv
    : applySubjectLaunchEnvironment(baseSubjectEnv, subject.launch);
  const budget = EVAL_BUDGETS_V1[scenario.budget];
  const runSubject = deps.runSubject ?? (scenario.surface === "tui" ? runTuiSubject : runCliSubject);
  return {
    controllerDir, stateHome, fixtureSnapshot, workspace, before, initialGit,
    promptPath, env, budget, runSubject
  };
}

async function executeAttemptSubject(context, lifecycle, prepared) {
  const { scenario, subject, redactor } = context;
  const { attemptArtifactDir, startedAt } = lifecycle;
  const { runSubject, workspace, stateHome, promptPath, env, budget, controllerDir } = prepared;
  lifecycle.phase = "subject";
  try {
    const result = await runSubject({
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
    lifecycle.subjectResult = result;
    return result;
  } catch (error) {
    const result = {
      exitCode: 1,
      stderr: error instanceof Error ? error.stack ?? error.message : String(error),
      events: [],
      durationMs: Date.now() - Date.parse(startedAt),
      infrastructureError: true
    };
    const stdoutName = scenario.surface === "tui" ? "tui-driver.stdout.log" : "subject.stdout.log";
    const stderrName = scenario.surface === "tui" ? "tui-driver.stderr.log" : "subject.stderr.log";
    await ensureFile(path.join(attemptArtifactDir, stdoutName), "");
    await ensureFile(path.join(attemptArtifactDir, stderrName), redactor(result.stderr));
    if (scenario.surface === "tui") await ensureFile(path.join(attemptArtifactDir, "tui.transcript.log"), "");
    lifecycle.subjectResult = result;
    return result;
  }
}

async function collectAttemptEvidence(context, lifecycle, prepared, subjectResult) {
  const { redactor } = context;
  const { attemptArtifactDir } = lifecycle;
  const { workspace, stateHome, before } = prepared;
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
  return { stored, events, rawMetrics, metrics, delta, git };
}

async function verifyAttempt(context, lifecycle, prepared, subjectResult, collected) {
  const { scenario, manifestDir, subject, secrets, redactor } = context;
  const { attemptArtifactDir } = lifecycle;
  const { controllerDir, workspace, initialGit } = prepared;
  const { delta, git, events, metrics } = collected;
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
  return { verifier, verifierDelta };
}

function attemptReliabilitySignals(collected, verified, expectedActual) {
  const { rawMetrics, events, stored } = collected;
  const { verifier, verifierDelta } = verified;
  const reliabilitySignals = rawMetrics.hardFailures.map((failure) => ({ severity: "blocker", ...failure }));
  const substantiveVerifierFailures = verifier.checks.filter((check) => check.type !== "terminal" && !check.passed);
  if (expectedActual === "completed" && substantiveVerifierFailures.length > 0) reliabilitySignals.push({
    severity: "blocker",
    code: "completion_verifier_mismatch",
    failedChecks: substantiveVerifierFailures.map((check) => ({ index: check.index, type: check.type }))
  });
  if (rawMetrics.consecutiveToolFailures.longest >= 3) reliabilitySignals.push({
    severity: "warning", code: "consecutive_tool_failures",
    count: rawMetrics.consecutiveToolFailures.longest,
    evidence: rawMetrics.consecutiveToolFailures.streaks[0]
  });
  const verifierChanges = verifierDelta.added.length + verifierDelta.modified.length + verifierDelta.deleted.length;
  if (verifierChanges > 0) reliabilitySignals.push({
    severity: "warning", code: "verifier_workspace_mutation", delta: verifierDelta
  });
  if (events.length === 0) reliabilitySignals.push({ severity: "blocker", code: "missing_durable_events" });
  if (stored.storeError) reliabilitySignals.push({
    severity: "warning", code: "event_store_read_failed", detail: stored.storeError
  });
  return reliabilitySignals;
}

function buildAttemptReport(context, lifecycle, collected, verified, evidence) {
  const { runId, runDir, scenario, repetition } = context;
  const { attemptId, attemptArtifactDir, startedAt } = lifecycle;
  const { subjectResult, safetyViolations, experienceViolations, expectedActual,
    reliabilitySignals, subjectConfig, finalWorkspaceArtifact } = evidence;
  const { stored, rawMetrics, metrics } = collected;
  const { verifier } = verified;
  return {
    schemaVersion: 1, kind: "eval_attempt", runId, attemptId,
    scenarioId: scenario.id, suites: scenario.suites, repetition, startedAt,
    finishedAt: new Date().toISOString(), subject: subjectConfig,
    outcome: {
      status: expectedActual,
      finishReason: subjectResult.result?.finishReason ?? rawMetrics.terminal.code ?? rawMetrics.terminal.type,
      sessionId: stored.sessionId, exitCode: subjectResult.exitCode,
      expectedTerminal: scenario.expectedTerminal, expected: expectedActual === scenario.expectedTerminal
    },
    dimensions: {
      correctness: { status: verifier.status, checks: verifier.checks },
      safety: { status: safetyViolations.length === 0 ? "pass" : "fail", violations: safetyViolations },
      experience: {
        status: experienceViolations.length === 0 ? "pass" : "fail", violations: experienceViolations,
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
}

async function runAttemptCore(context, deps, lifecycle) {
  const { scenario } = context;
  const prepared = await prepareAttemptExecution(context, deps, lifecycle);
  const subjectResult = await executeAttemptSubject(context, lifecycle, prepared);
  if (subjectResult.infrastructureError) {
    throw new Error(`Evaluation subject infrastructure failed: ${JSON.stringify(
      subjectResult.controllerInfrastructureError ?? { code: "subject_infrastructure_error" }
    )}`);
  }
  const collected = await collectAttemptEvidence(context, lifecycle, prepared, subjectResult);
  const verified = await verifyAttempt(context, lifecycle, prepared, subjectResult, collected);
  const safetyViolations = safetyViolationsFromEvidence(
    scenario, collected.delta, collected.rawMetrics, collected.events
  );
  const finalWorkspaceArtifact = path.join(lifecycle.attemptArtifactDir, "workspace-final");
  lifecycle.phase = "evidence_copy";
  const evidenceLinks = await copyWorkspaceEvidence(prepared.workspace, finalWorkspaceArtifact);
  for (const link of evidenceLinks) safetyViolations.push({ code: "workspace_symbolic_link", ...link });
  const experienceViolations = experienceViolationsFromEvidence(scenario, subjectResult, collected.metrics);
  const expectedActual = actualTerminal(collected.metrics, subjectResult);
  const reliabilitySignals = attemptReliabilitySignals(collected, verified, expectedActual);
  const subjectConfig = subjectConfiguration(context, prepared.fixtureSnapshot);
  lifecycle.phase = "report";
  const attempt = buildAttemptReport(context, lifecycle, collected, verified, {
    subjectResult, safetyViolations, experienceViolations, expectedActual,
    reliabilitySignals, subjectConfig, finalWorkspaceArtifact
  });
  return { attempt, stateRoot: collected.stored.stateRoot };
}

function createAttemptLifecycle(runDir) {
  return {
    attemptId: randomUUID(),
    // Keep evaluator identity out of every path visible to the subject or its
    // TUI parent process. The external report carries the mapping.
    attemptArtifactDir: path.join(runDir, "attempts", randomUUID()),
    sandboxRoot: path.join(os.tmpdir(), `workspace-session-${randomUUID()}`),
    startedAt: new Date().toISOString(),
    phase: "setup"
  };
}

async function executeAttemptCoreSafely(context, deps, lifecycle) {
  try {
    return await runAttemptCore(context, deps, lifecycle);
  } catch (error) {
    return { attempt: await infrastructureFailureAttempt(context, lifecycle, error), stateRoot: null };
  }
}

async function scanAttemptSecrets(context, lifecycle, attempt, secretValues) {
  const { redactor } = context;
  try {
    const exposures = await redactArtifactTree(lifecycle.sandboxRoot, secretValues);
    for (const file of exposures) addSafetyViolation(attempt, { code: "secret_in_artifact", file: `sandbox/${file}` });
  } catch (error) {
    addSafetyViolation(attempt, { code: "incomplete_safety_evidence", phase: "sandbox_secret_scan" });
    addReliabilityBlocker(attempt, { code: "evaluator_infrastructure_error", phase: "sandbox_secret_scan" });
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    await ensureFile(path.join(lifecycle.attemptArtifactDir, "evaluator-error.log"), redactor(`${message}\n`));
  }
  const exposures = await redactArtifactTree(lifecycle.attemptArtifactDir, secretValues);
  for (const file of exposures) addSafetyViolation(attempt, { code: "secret_in_artifact", file });
}

async function finalizeAttempt(context, lifecycle, result, secretValues) {
  const { redactor } = context;
  await scanAttemptSecrets(context, lifecycle, result.attempt, secretValues);
  await writeJson(path.join(lifecycle.attemptArtifactDir, "attempt.json"), result.attempt, redactor);
  if (result.stateRoot) await appendExternalReport(result.stateRoot, result.attempt);
}

async function cleanupAttempt(context, lifecycle, attempt) {
  try {
    await rm(lifecycle.sandboxRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return false;
  } catch (error) {
    addSafetyViolation(attempt, { code: "sandbox_cleanup_failed" });
    addReliabilityBlocker(attempt, { code: "sandbox_cleanup_failed" });
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    await writeFile(path.join(lifecycle.attemptArtifactDir, "cleanup-error.log"), context.redactor(`${message}\n`), "utf8")
      .catch(() => undefined);
    return true;
  }
}

async function emergencyAttemptCleanup(context, lifecycle) {
  await rm(lifecycle.sandboxRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    .catch(async (error) => ensureFile(
      path.join(lifecycle.attemptArtifactDir, "cleanup-error.log"),
      context.redactor(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    ).catch(() => undefined));
}

async function runAttempt(context, deps = {}) {
  const secretValues = context.artifactSecretValues ?? Object.values(context.secrets ?? {});
  const lifecycle = createAttemptLifecycle(context.runDir);
  let cleanupManaged = false;
  try {
    const result = await executeAttemptCoreSafely(context, deps, lifecycle);
    let finalizationError;
    try { await finalizeAttempt(context, lifecycle, result, secretValues); } catch (error) { finalizationError = error; }
    cleanupManaged = true;
    const cleanupFailed = await cleanupAttempt(context, lifecycle, result.attempt);
    if (cleanupFailed && !finalizationError) {
      await writeJson(path.join(lifecycle.attemptArtifactDir, "attempt.json"), result.attempt, context.redactor);
    }
    if (finalizationError) throw finalizationError;
    return result.attempt;
  } finally {
    if (!cleanupManaged) await emergencyAttemptCleanup(context, lifecycle);
  }
}

async function resolveEvaluationInput(options) {
  const { suite, subjectKind } = validateEvaluationOptions(options);
  const manifestPath = path.resolve(options.manifestPath ?? DEFAULT_MANIFEST);
  const manifestDir = path.dirname(manifestPath);
  const manifest = await loadEvalManifestV1(manifestPath);
  const scenarios = selectEvaluationScenarios(manifest, suite, options.scenarios);
  const repeat = evaluationRepeat(options.repeat, suite);
  const runId = options.runId ?? makeRunId();
  const destination = evaluationDestination(options, runId);
  const runDir = await prepareRunDirectory(destination.destination);
  return {
    suite, subjectKind, manifestDir, scenarios, repeat, runId,
    effectiveEvalRoot: destination.root, runDir
  };
}

function validateEvaluationOptions(options) {
  const suite = options.suite ?? "quick";
  if (!new Set(["quick", "experience"]).has(suite)) throw new Error(`Unknown evaluation suite '${suite}'.`);
  const subjectKind = options.subjectKind ?? "package";
  if (!new Set(["dev", "package"]).has(subjectKind)) {
    throw new Error("Evaluation subject must be 'package' or 'dev'.");
  }
  if (options.skipPackage && subjectKind !== "package") {
    throw new Error("--skip-package is valid only with --subject package.");
  }
  return { suite, subjectKind };
}

function selectEvaluationScenarios(manifest, suite, requested) {
  let scenarios = manifest.scenarios.filter((scenario) => scenario.suites.includes(suite));
  if (requested?.length) {
    const selected = new Set(requested);
    scenarios = scenarios.filter((scenario) => selected.has(scenario.id));
    const missing = [...selected].filter((id) => !scenarios.some((scenario) => scenario.id === id));
    if (missing.length > 0) throw new Error(`Unknown or out-of-suite scenarios: ${missing.join(", ")}`);
  }
  if (scenarios.length === 0) throw new Error(`Suite '${suite}' selected no scenarios.`);
  return scenarios;
}

function evaluationRepeat(requested, suite) {
  const repeat = requested ?? (suite === "experience" ? 3 : 1);
  if (!Number.isSafeInteger(repeat) || repeat <= 0) throw new Error("repeat must be a positive integer.");
  return repeat;
}

function evaluationDestination(options, runId) {
  const requestedRunDir = options.runDir ? path.resolve(options.runDir) : undefined;
  const effectiveEvalRoot = path.resolve(options.evalRootDir
    ?? (requestedRunDir ? path.dirname(requestedRunDir) : evalRootDir));
  const destination = requestedRunDir ?? path.join(effectiveEvalRoot, runId);
  const relativeDestination = path.relative(effectiveEvalRoot, destination);
  if (relativeDestination.startsWith("..") || path.isAbsolute(relativeDestination)) {
    throw new Error("Evaluation run directory must be inside its results root.");
  }
  return { root: effectiveEvalRoot, destination };
}

async function prepareEvaluationContext(input, options, deps) {
  const { suite, repeat, scenarios, runDir, manifestDir } = input;
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
  return {
    ...input, secrets, artifactSecretValues, redactor, sourceGitSha, evaluatorDigest, verifierDigest, schedule,
    startedAt: new Date().toISOString()
  };
}

async function prepareEvaluationSubject(context, options, deps, infrastructureErrors) {
  const { runDir, redactor } = context;
  try {
    return deps.prepareSubject
      ? await deps.prepareSubject(runDir, options)
      : await prepareSubject(runDir, options, redactor);
  } catch (error) {
    const detail = redactor(error instanceof Error ? error.stack ?? error.message : String(error));
    infrastructureErrors.push({ code: "subject_preparation_failed", phase: "subject_preparation", detail });
    await writeFile(path.join(runDir, "infrastructure-error.log"), `${detail}\n`, "utf8");
    return undefined;
  }
}

function attemptInfrastructureErrors(attempt, item) {
  return (attempt.dimensions.reliability.signals ?? [])
    .filter((signal) => new Set(["evaluator_infrastructure_error", "sandbox_cleanup_failed"]).has(signal.code))
    .map((signal) => ({
      code: signal.code, phase: signal.phase ?? "attempt",
      scenarioId: item.scenario.id, repetition: item.repetition
    }));
}

async function executeEvaluationSchedule(context, subject, deps, infrastructureErrors) {
  const attempts = [];
  if (!subject) return attempts;
  const { schedule, runId, runDir, manifestDir, secrets, artifactSecretValues, redactor,
    sourceGitSha, evaluatorDigest, verifierDigest } = context;
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
        infrastructureErrors.push(...attemptInfrastructureErrors(attempt, item));
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
  return attempts;
}

function rawEvaluationRun(context, subject, attempts, infrastructureErrors) {
  const { runId, suite, repeat, startedAt, sourceGitSha, evaluatorDigest, verifierDigest, scenarios } = context;
  const firstEnvironmentDigest = attempts[0]?.subject?.environmentDigest ?? null;
  return {
    schemaVersion: 1,
    kind: "eval_run",
    runId,
    suite,
    repeat,
    startedAt,
    finishedAt: new Date().toISOString(),
    subject: rawRunSubject(subject, sourceGitSha, evaluatorDigest, verifierDigest, firstEnvironmentDigest),
    scenarios: scenarios.map((scenario) => ({ scenarioId: scenario.id, scenarioDigest: digest(scenario) })),
    attempts,
    infrastructureErrors
  };
}

function subjectValue(subject, key) {
  return subject && subject[key] !== undefined ? subject[key] : null;
}

function rawRunSubject(subject, sourceGitSha, evaluatorDigest, verifierDigest, environmentDigest) {
  return {
    provider: "deepseek", model: sigmaManifest.evaluation.model,
    platform: process.platform, arch: process.arch, gitSha: sourceGitSha,
    subjectKind: subjectValue(subject, "subjectKind") ?? "unavailable", surface: "mixed",
    evaluatorDigest, verifierDigest,
    nodeDigest: subjectValue(subject, "nodeDigest"), cliTreeDigest: subjectValue(subject, "cliTreeDigest"),
    brokerDigest: subjectValue(subject, "brokerDigest"), subjectDigest: subjectValue(subject, "subjectDigest"),
    nativeSourceDigest: subjectValue(subject, "nativeSourceDigest"),
    nativeTarget: subjectValue(subject, "nativeTarget"), environmentDigest, configDigest: environmentDigest
  };
}

async function writeSafeEvaluationReport(context, rawRun, infrastructureErrors) {
  const { runDir, effectiveEvalRoot, artifactSecretValues, redactor } = context;
  const preReportExposures = await redactArtifactTree(runDir, artifactSecretValues);
  if (preReportExposures.length > 0) {
    infrastructureErrors.push({
      code: "secret_material_redacted",
      phase: "pre_report_secret_scan",
      files: preReportExposures
    });
  }
  const safeRun = () => JSON.parse(redactor(JSON.stringify(rawRun)));
  let written = await writeEvalReport({ run: safeRun(), runDir, evalRootDir: effectiveEvalRoot });
  const finalExposures = await redactArtifactTree(runDir, artifactSecretValues);
  if (finalExposures.length > 0) {
    infrastructureErrors.push({
      code: "secret_material_redacted",
      phase: "final_secret_scan",
      files: finalExposures
    });
    written = await writeEvalReport({ run: safeRun(), runDir, evalRootDir: effectiveEvalRoot });
    await redactArtifactTree(runDir, artifactSecretValues);
  }
  const residualExposures = await scanArtifactTree(runDir, artifactSecretValues);
  if (residualExposures.length > 0) {
    throw new Error(`Secret material could not be removed from evaluation artifacts: ${residualExposures.join(", ")}`);
  }
  return { ...written, runDir, run: written.report };
}

export async function runEvaluation(options = {}, deps = {}) {
  const input = await resolveEvaluationInput(options);
  const context = await prepareEvaluationContext(input, options, deps);
  const infrastructureErrors = [];
  const subject = await prepareEvaluationSubject(context, options, deps, infrastructureErrors);
  const attempts = await executeEvaluationSchedule(context, subject, deps, infrastructureErrors);
  const rawRun = rawEvaluationRun(context, subject, attempts, infrastructureErrors);
  return await writeSafeEvaluationReport(context, rawRun, infrastructureErrors);
}

export { prepareSubject, runAttempt };
