import path from "node:path";
import {
  buildResumeInstruction,
  listCheckpoints,
  listSessions,
  loadCheckpoint,
  loadSessionArtifactManifest,
  loadSessionMeta,
  loadSessionResumeContext,
  readSessionEventsText,
  readSessionSummaryText,
  restoreCheckpoint,
  searchSessions,
  truncateMiddle
} from "agent-core";
import type { DurableSessionMeta, SessionArtifactManifest, SessionIndexRecord } from "agent-core";
import { loadCliConfig, parseArgs } from "../config.js";
import { runRunCommandWithOverrides, type SolveCommandDeps } from "./run.js";

interface SessionSummaryInspection {
  harness?: {
    attempts?: unknown[];
    validation_results?: unknown[];
    precheck_results?: unknown[];
  };
  changed_files?: unknown;
  evidence?: unknown[];
  final_gate?: unknown;
  review_findings?: unknown[];
  failure_analyses?: unknown[];
  validation_plan?: unknown;
}

interface EvidenceSummary {
  finalGate: unknown;
  validation: {
    total: number;
    failed: number;
    results: unknown[];
  };
  precheck: {
    total: number;
    failed: number;
    results: unknown[];
  };
  attempts: unknown[];
  evidenceRecords: unknown[];
  reviewFindings: unknown[];
  failureAnalyses: unknown[];
  validationPlan: unknown;
}

interface RecentSessionEvent {
  type?: string;
  timestamp?: string;
  metadata?: unknown;
  raw?: string;
}

interface SessionInspectionPayload {
  meta: DurableSessionMeta;
  artifacts: Record<string, string | null>;
  changedFiles: string[];
  artifactManifest: SessionArtifactManifest | null;
  evidence: EvidenceSummary;
  eventCount: number;
  recentEvents: RecentSessionEvent[];
  recentControllerEvents: RecentSessionEvent[];
  attemptSummaries: unknown[];
  summary: SessionSummaryInspection | null;
}

interface JobSummary {
  sessionId: string;
  title: string;
  status: SessionIndexRecord["status"];
  provider: string;
  model: string;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  changedFiles: string[];
  changedFilesCount: number;
  artifacts: {
    manifest?: string;
    summary: string;
    events: string;
  };
  finishReason?: SessionIndexRecord["finishReason"];
  durationMs?: number;
  parentSessionId?: string;
  forkedFromSessionId?: string;
  lastError?: string | null;
}

function stdout(deps: SolveCommandDeps): NodeJS.WritableStream {
  return deps.stdout ?? process.stdout;
}

function stderr(deps: SolveCommandDeps): NodeJS.WritableStream {
  return deps.stderr ?? process.stderr;
}

function writeJson(value: unknown, deps: SolveCommandDeps): void {
  stdout(deps).write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseJsonOrNull(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function compactDate(value: string | undefined): string {
  if (!value) return "-";
  return value.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function isExitFailure(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { exit_code?: unknown }).exit_code !== 0);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function evidenceSummary(summary: SessionSummaryInspection | null): EvidenceSummary {
  const validation = arrayValue(summary?.harness?.validation_results);
  const precheck = arrayValue(summary?.harness?.precheck_results);
  return {
    finalGate: summary?.final_gate ?? null,
    validation: {
      total: validation.length,
      failed: validation.filter(isExitFailure).length,
      results: validation
    },
    precheck: {
      total: precheck.length,
      failed: precheck.filter(isExitFailure).length,
      results: precheck
    },
    attempts: arrayValue(summary?.harness?.attempts),
    evidenceRecords: arrayValue(summary?.evidence),
    reviewFindings: arrayValue(summary?.review_findings),
    failureAnalyses: arrayValue(summary?.failure_analyses),
    validationPlan: summary?.validation_plan ?? null
  };
}

function artifactsForMeta(meta: DurableSessionMeta): Record<string, string | null> {
  const sessionDir = path.dirname(meta.summaryPath);
  return {
    manifest: meta.artifactManifestPath ?? path.join(sessionDir, "artifacts.json"),
    meta: path.join(sessionDir, "meta.json"),
    summary: meta.summaryPath,
    events: meta.eventsPath,
    checkpoints: meta.checkpointsDir,
    trace: meta.traceJsonlPath ?? null,
    sessionJsonl: meta.sessionJsonlPath ?? null,
    runSummary: meta.runSummaryJsonPath ?? null
  };
}

function compactUnknown(value: unknown, max = 220): string {
  if (value === null || value === undefined) return "none";
  return truncateMiddle(JSON.stringify(value), max).text;
}

function evidenceLine(label: string, value: { total: number; failed: number }): string {
  if (value.total === 0) return `${label}: none`;
  return `${label}: ${value.total - value.failed}/${value.total} passed${value.failed > 0 ? ` (${value.failed} failed)` : ""}`;
}

function numberFlag(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

async function resolveSessionId(options: {
  positionals: string[];
  flags: Record<string, string | boolean>;
  workspacePath: string;
  defaultLatest: boolean;
}): Promise<string | undefined> {
  const explicit = options.positionals[0];
  if (explicit) return explicit;
  if (options.flags.latest === true || options.defaultLatest) {
    const latest = (await listSessions({ workspacePath: options.workspacePath, limit: 1 }))[0];
    return latest?.sessionId;
  }
  return undefined;
}

async function loadSessionInspection(options: {
  sessionId: string;
  workspacePath: string;
}): Promise<SessionInspectionPayload | null> {
  const meta = await loadSessionMeta({ sessionId: options.sessionId, workspacePath: options.workspacePath });
  if (!meta) return null;
  const events = (await readSessionEventsText(meta.eventsPath)).trim().split(/\r?\n/).filter(Boolean);
  const summaryText = await readSessionSummaryText(meta.summaryPath);
  const summary = parseJsonOrNull(summaryText) as SessionSummaryInspection | null;
  const artifactManifest = await loadSessionArtifactManifest({
    sessionId: options.sessionId,
    workspacePath: options.workspacePath
  });
  const evidence = evidenceSummary(summary);
  const changedFiles = meta.changedFiles.length > 0 ? meta.changedFiles : stringArray(summary?.changed_files);
  const artifacts = artifactsForMeta(meta);
  const recentEvents: RecentSessionEvent[] = events.slice(-12).map((line) => {
    try {
      const parsed = JSON.parse(line) as { type?: string; timestamp?: string; metadata?: unknown };
      return { type: parsed.type, timestamp: parsed.timestamp, metadata: parsed.metadata };
    } catch {
      return { raw: line };
    }
  });
  return {
    meta,
    artifacts,
    changedFiles,
    artifactManifest,
    evidence,
    eventCount: events.length,
    recentEvents,
    recentControllerEvents: recentEvents.filter((item) =>
      item.type === "harness_check_start" ||
      item.type === "harness_check_end" ||
      item.type === "run_start" ||
      item.type === "run_end"
    ),
    attemptSummaries: evidence.attempts,
    summary
  };
}

function printSessionInspection(payload: SessionInspectionPayload, deps: SolveCommandDeps): void {
  const { artifacts, changedFiles, evidence, meta } = payload;
  stdout(deps).write(`${meta.sessionId}\n`);
  stdout(deps).write(`  title: ${meta.title}\n`);
  stdout(deps).write(`  status: ${meta.status}${meta.finishReason ? ` (${meta.finishReason})` : ""}\n`);
  stdout(deps).write(`  workspace: ${meta.workspacePath}\n`);
  stdout(deps).write(`  model: ${meta.provider}/${meta.model}\n`);
  stdout(deps).write(`  updated: ${compactDate(meta.updatedAt)}\n`);
  if (meta.parentSessionId) stdout(deps).write(`  parent: ${meta.parentSessionId}\n`);
  if (meta.forkedFromSessionId) stdout(deps).write(`  forkedFrom: ${meta.forkedFromSessionId}\n`);
  if (changedFiles.length > 0) stdout(deps).write(`  changed: ${changedFiles.join(", ")}\n`);
  if (meta.finalMessage) stdout(deps).write(`  final: ${truncateMiddle(meta.finalMessage, 300).text}\n`);
  stdout(deps).write(`  events: ${payload.eventCount}\n`);
  stdout(deps).write("  artifacts:\n");
  for (const [name, value] of Object.entries(artifacts)) {
    stdout(deps).write(`    ${name}: ${value ?? "none"}\n`);
  }
  stdout(deps).write("  evidence:\n");
  stdout(deps).write(`    final_gate: ${compactUnknown(evidence.finalGate)}\n`);
  stdout(deps).write(`    ${evidenceLine("validation", evidence.validation)}\n`);
  stdout(deps).write(`    ${evidenceLine("precheck", evidence.precheck)}\n`);
  stdout(deps).write(`    attempts: ${evidence.attempts.length}\n`);
  stdout(deps).write(`    evidence_records: ${evidence.evidenceRecords.length}\n`);
}

function printArtifacts(payload: SessionInspectionPayload, deps: SolveCommandDeps): void {
  stdout(deps).write(`${payload.meta.sessionId}\n`);
  stdout(deps).write(`  status: ${payload.meta.status}${payload.meta.finishReason ? ` (${payload.meta.finishReason})` : ""}\n`);
  stdout(deps).write("  artifacts:\n");
  for (const [name, value] of Object.entries(payload.artifacts)) {
    stdout(deps).write(`    ${name}: ${value ?? "none"}\n`);
  }
  stdout(deps).write("  changed:\n");
  if (payload.changedFiles.length === 0) stdout(deps).write("    (none)\n");
  else {
    for (const file of payload.changedFiles) stdout(deps).write(`    ${file}\n`);
  }
  stdout(deps).write("  evidence:\n");
  stdout(deps).write(`    ${evidenceLine("validation", payload.evidence.validation)}\n`);
  stdout(deps).write(`    ${evidenceLine("precheck", payload.evidence.precheck)}\n`);
  stdout(deps).write(`    attempts: ${payload.evidence.attempts.length}\n`);
}

function failedJob(record: SessionIndexRecord): boolean {
  return record.status === "error" ||
    record.finishReason === "validation_failed" ||
    record.finishReason === "precheck_failed" ||
    record.finishReason === "error" ||
    Boolean(record.lastError);
}

function jobFromRecord(record: SessionIndexRecord): JobSummary {
  return {
    sessionId: record.sessionId,
    title: record.title,
    status: record.status,
    provider: record.provider,
    model: record.model,
    workspacePath: record.workspacePath,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    changedFiles: record.changedFiles,
    changedFilesCount: record.changedFiles.length,
    artifacts: {
      ...(record.artifactManifestPath ? { manifest: record.artifactManifestPath } : {}),
      summary: record.summaryPath,
      events: record.eventsPath
    },
    ...(record.finishReason ? { finishReason: record.finishReason } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    ...(record.parentSessionId ? { parentSessionId: record.parentSessionId } : {}),
    ...(record.forkedFromSessionId ? { forkedFromSessionId: record.forkedFromSessionId } : {}),
    ...(record.lastError !== undefined ? { lastError: record.lastError } : {})
  };
}

function jobsSummary(records: SessionIndexRecord[]): Record<string, number> {
  return {
    total: records.length,
    running: records.filter((record) => record.status === "running").length,
    completed: records.filter((record) => record.status === "completed").length,
    stopped: records.filter((record) => record.status === "stopped").length,
    error: records.filter((record) => record.status === "error").length,
    failed: records.filter(failedJob).length,
    changed: records.filter((record) => record.changedFiles.length > 0).length
  };
}

function printJobs(payload: { workspace: string; summary: Record<string, number>; jobs: JobSummary[] }, deps: SolveCommandDeps): void {
  if (payload.jobs.length === 0) {
    stdout(deps).write("No jobs found.\n");
    return;
  }
  stdout(deps).write(`workspace: ${payload.workspace}\n`);
  stdout(deps).write(
    `jobs: total=${payload.summary.total} running=${payload.summary.running} completed=${payload.summary.completed} stopped=${payload.summary.stopped} error=${payload.summary.error} failed=${payload.summary.failed} changed=${payload.summary.changed}\n`
  );
  for (const job of payload.jobs) {
    const finish = job.finishReason ? ` finish=${job.finishReason}` : "";
    const duration = job.durationMs !== undefined ? ` duration=${Math.round(job.durationMs)}ms` : "";
    stdout(deps).write(
      `${job.sessionId}  ${job.status}${finish}${duration} changed=${job.changedFilesCount}  ${compactDate(job.updatedAt)}  ${truncateMiddle(job.title, 80).text}\n`
    );
  }
}

function flagArgv(flags: Record<string, string | boolean>): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(flags)) {
    if (value === false) continue;
    args.push(`--${key}`);
    if (value !== true) args.push(value);
  }
  return args;
}

function printSessions(records: Awaited<ReturnType<typeof listSessions>>, deps: SolveCommandDeps): void {
  if (records.length === 0) {
    stdout(deps).write("No sessions found.\n");
    return;
  }
  for (const record of records) {
    const changed = record.changedFiles.length > 0 ? ` changed=${record.changedFiles.length}` : "";
    const finish = record.finishReason ? ` finish=${record.finishReason}` : "";
    stdout(deps).write(
      `${record.sessionId}  ${record.status}${finish}${changed}  ${compactDate(record.updatedAt)}  ${truncateMiddle(record.title, 80).text}\n`
    );
  }
}

export async function runSessionsCommand(argv: string[], deps: SolveCommandDeps = {}): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = loadCliConfig(flags);
  const records = await listSessions({ workspacePath: config.workspace, limit: 100 });
  if (flags.json) writeJson(records, deps);
  else printSessions(records, deps);
  return 0;
}

export async function runJobsCommand(argv: string[], deps: SolveCommandDeps = {}): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout(deps).write(`agent jobs [flags]

Summarize recent Sigma session jobs for this workspace.

Flags:
  --workspace <path>
  --limit <number>
  --json
`);
    return 0;
  }
  const { flags } = parseArgs(argv);
  const config = loadCliConfig(flags);
  const limit = numberFlag(flags.limit, 20, 1, 500);
  const records = await listSessions({ workspacePath: config.workspace, limit });
  const payload = {
    workspace: path.resolve(config.workspace),
    summary: jobsSummary(records),
    jobs: records.map(jobFromRecord)
  };
  if (flags.json) writeJson(payload, deps);
  else printJobs(payload, deps);
  return 0;
}

export async function runArtifactsCommand(argv: string[], deps: SolveCommandDeps = {}): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout(deps).write(`agent artifacts [session-id] [flags]

Show artifact paths, changed files, and evidence for a session.
Defaults to the latest session when no session id is provided.

Flags:
  --workspace <path>
  --latest
  --json
`);
    return 0;
  }
  const { flags, positionals } = parseArgs(argv);
  const config = loadCliConfig(flags);
  const sessionId = await resolveSessionId({
    positionals,
    flags,
    workspacePath: config.workspace,
    defaultLatest: true
  });
  if (!sessionId) {
    stderr(deps).write("artifacts requires a session id or an existing latest session\n");
    return 1;
  }
  const payload = await loadSessionInspection({ sessionId, workspacePath: config.workspace });
  if (!payload) {
    stderr(deps).write(`Session not found: ${sessionId}\n`);
    return 1;
  }
  if (flags.json) writeJson(payload, deps);
  else printArtifacts(payload, deps);
  return 0;
}

export async function runSessionCommand(argv: string[], deps: SolveCommandDeps = {}): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    stdout(deps).write(`agent session <command> [args] [flags]

Commands:
  show <session-id>
  show --latest
  search <query>
  resume <session-id> <instruction>
  fork <session-id> <instruction>
`);
    return 0;
  }
  if (subcommand === "show") return await runSessionShow(rest, deps);
  if (subcommand === "search") return await runSessionSearch(rest, deps);
  if (subcommand === "resume") return await runSessionResumeLike(rest, deps, "resume");
  if (subcommand === "fork") return await runSessionResumeLike(rest, deps, "fork");
  stderr(deps).write(`Unknown session command: ${subcommand}\n`);
  return 1;
}

async function runSessionShow(argv: string[], deps: SolveCommandDeps): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const config = loadCliConfig(flags);
  const sessionId = await resolveSessionId({
    positionals,
    flags,
    workspacePath: config.workspace,
    defaultLatest: false
  });
  if (!sessionId) {
    stderr(deps).write("session show requires a session id or --latest\n");
    return 1;
  }
  const payload = await loadSessionInspection({ sessionId, workspacePath: config.workspace });
  if (!payload) {
    stderr(deps).write(`Session not found: ${sessionId}\n`);
    return 1;
  }
  if (flags.json) {
    writeJson(payload, deps);
  } else {
    printSessionInspection(payload, deps);
  }
  return 0;
}

async function runSessionSearch(argv: string[], deps: SolveCommandDeps): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const query = positionals.join(" ").trim();
  if (!query) {
    stderr(deps).write("session search requires a query\n");
    return 1;
  }
  const config = loadCliConfig(flags);
  const results = await searchSessions({ query, workspacePath: config.workspace });
  if (flags.json) {
    writeJson(results, deps);
  } else if (results.length === 0) {
    stdout(deps).write("No matching sessions found.\n");
  } else {
    for (const result of results) {
      stdout(deps).write(`${result.session.sessionId}  score=${result.score}  ${truncateMiddle(result.session.title, 80).text}\n`);
      for (const match of result.matches.slice(0, 2)) {
        stdout(deps).write(`  ${truncateMiddle(match, 140).text}\n`);
      }
    }
  }
  return 0;
}

async function runSessionResumeLike(
  argv: string[],
  deps: SolveCommandDeps,
  mode: "resume" | "fork"
): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const [sessionId, ...instructionParts] = positionals;
  const instruction = instructionParts.join(" ").trim();
  if (!sessionId || !instruction) {
    stderr(deps).write(`session ${mode} requires a session id and instruction\n`);
    return 1;
  }
  const config = loadCliConfig(flags);
  const context = await loadSessionResumeContext({ sessionId, workspacePath: config.workspace });
  if (!context) {
    stderr(deps).write(`Session not found: ${sessionId}\n`);
    return 1;
  }
  const workspacePath = typeof flags.workspace === "string" ? config.workspace : context.session.workspacePath;
  const runFlags = flagArgv({ ...flags, workspace: workspacePath });
  return await runRunCommandWithOverrides(runFlags, deps, {
    workspacePath,
    instruction: buildResumeInstruction({ context, instruction, mode }),
    parentSessionId: context.session.sessionId,
    forkedFromSessionId: mode === "fork" ? context.session.sessionId : undefined
  });
}

export async function runCheckpointsCommand(argv: string[], deps: SolveCommandDeps = {}): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const sessionId = positionals[0];
  if (!sessionId) {
    stderr(deps).write("checkpoints requires a session id\n");
    return 1;
  }
  const config = loadCliConfig(flags);
  const records = await listCheckpoints({ sessionId, workspacePath: config.workspace });
  if (flags.json) writeJson(records, deps);
  else if (records.length === 0) stdout(deps).write("No checkpoints found.\n");
  else {
    for (const record of records) {
      stdout(deps).write(
        `${record.id}  ${record.toolName}  files=${record.changedFiles.length}  ${compactDate(record.createdAt)}  ${truncateMiddle(record.resultSummary, 80).text}\n`
      );
    }
  }
  return 0;
}

export async function runCheckpointCommand(argv: string[], deps: SolveCommandDeps = {}): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === "show") return await runCheckpointShow(rest, deps);
  if (subcommand === "restore") return await runCheckpointRestore(rest, deps);
  stdout(deps).write(`agent checkpoint <command> [args]

Commands:
  show <session-id> <checkpoint-id>
  restore <session-id> <checkpoint-id>
`);
  return subcommand ? 1 : 0;
}

async function runCheckpointShow(argv: string[], deps: SolveCommandDeps): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const [sessionId, checkpointId] = positionals;
  if (!sessionId || !checkpointId) {
    stderr(deps).write("checkpoint show requires a session id and checkpoint id\n");
    return 1;
  }
  const config = loadCliConfig(flags);
  const record = await loadCheckpoint({ sessionId, checkpointId, workspacePath: config.workspace });
  if (!record) {
    stderr(deps).write(`Checkpoint not found: ${path.join(sessionId, checkpointId)}\n`);
    return 1;
  }
  if (flags.json) writeJson(record, deps);
  else {
    stdout(deps).write(`${record.id}  ${record.toolName}  ${compactDate(record.createdAt)}\n`);
    stdout(deps).write(`  mode: ${record.mode ?? (record.patchPath ? "git" : "file")}\n`);
    stdout(deps).write(`  changed: ${record.changedFiles.join(", ") || "(none)"}\n`);
    if (record.patchPath) stdout(deps).write(`  patch: ${record.patchPath}\n`);
    if (record.fileSnapshotPath) stdout(deps).write(`  snapshot: ${record.fileSnapshotPath}\n`);
    if (record.skippedFiles && record.skippedFiles.length > 0) stdout(deps).write(`  skipped: ${record.skippedFiles.join(", ")}\n`);
    stdout(deps).write(`  result: ${record.resultSummary}\n`);
  }
  return 0;
}

async function runCheckpointRestore(argv: string[], deps: SolveCommandDeps): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const [sessionId, checkpointId] = positionals;
  if (!sessionId || !checkpointId) {
    stderr(deps).write("checkpoint restore requires a session id and checkpoint id\n");
    return 1;
  }
  const config = loadCliConfig(flags);
  const result = await restoreCheckpoint({ sessionId, checkpointId, workspacePath: config.workspace, force: flags.force === true });
  if (flags.json) writeJson(result, deps);
  else {
    stdout(deps).write(`${result.ok ? "restored" : "restore failed"} checkpoint=${result.checkpointId} exitCode=${result.exitCode}\n`);
    if (result.stderr.trim()) stdout(deps).write(`${result.stderr.trim()}\n`);
  }
  return result.ok ? 0 : 1;
}
