import path from "node:path";
import {
  buildResumeInstruction,
  listCheckpoints,
  listSessions,
  loadCheckpoint,
  loadSessionMeta,
  loadSessionResumeContext,
  readSessionEventsText,
  readSessionSummaryText,
  restoreCheckpoint,
  searchSessions,
  truncateMiddle
} from "agent-core";
import { loadCliConfig, parseArgs } from "../config.js";
import { runRunCommandWithOverrides, type SolveCommandDeps } from "./solve.js";

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

export async function runSessionCommand(argv: string[], deps: SolveCommandDeps = {}): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    stdout(deps).write(`agent session <command> [args] [flags]

Commands:
  show <session-id>
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
  const sessionId = positionals[0];
  if (!sessionId) {
    stderr(deps).write("session show requires a session id\n");
    return 1;
  }
  const config = loadCliConfig(flags);
  const meta = await loadSessionMeta({ sessionId, workspacePath: config.workspace });
  if (!meta) {
    stderr(deps).write(`Session not found: ${sessionId}\n`);
    return 1;
  }
  const events = (await readSessionEventsText(meta.eventsPath)).trim().split(/\r?\n/).filter(Boolean);
  const summaryText = await readSessionSummaryText(meta.summaryPath);
  const payload = {
    meta,
    eventCount: events.length,
    recentEvents: events.slice(-12).map((line) => {
      try {
        const parsed = JSON.parse(line) as { type?: string; timestamp?: string; metadata?: unknown };
        return { type: parsed.type, timestamp: parsed.timestamp, metadata: parsed.metadata };
      } catch {
        return { raw: line };
      }
    }),
    summary: parseJsonOrNull(summaryText)
  };
  if (flags.json) {
    writeJson(payload, deps);
  } else {
    stdout(deps).write(`${meta.sessionId}\n`);
    stdout(deps).write(`  title: ${meta.title}\n`);
    stdout(deps).write(`  status: ${meta.status}${meta.finishReason ? ` (${meta.finishReason})` : ""}\n`);
    stdout(deps).write(`  workspace: ${meta.workspacePath}\n`);
    stdout(deps).write(`  model: ${meta.provider}/${meta.model}\n`);
    stdout(deps).write(`  updated: ${compactDate(meta.updatedAt)}\n`);
    if (meta.parentSessionId) stdout(deps).write(`  parent: ${meta.parentSessionId}\n`);
    if (meta.forkedFromSessionId) stdout(deps).write(`  forkedFrom: ${meta.forkedFromSessionId}\n`);
    if (meta.changedFiles.length > 0) stdout(deps).write(`  changed: ${meta.changedFiles.join(", ")}\n`);
    if (meta.finalMessage) stdout(deps).write(`  final: ${truncateMiddle(meta.finalMessage, 300).text}\n`);
    stdout(deps).write(`  events: ${events.length}\n`);
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
    stdout(deps).write(`  changed: ${record.changedFiles.join(", ") || "(none)"}\n`);
    stdout(deps).write(`  patch: ${record.patchPath}\n`);
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
  const result = await restoreCheckpoint({ sessionId, checkpointId, workspacePath: config.workspace });
  if (flags.json) writeJson(result, deps);
  else {
    stdout(deps).write(`${result.ok ? "restored" : "restore failed"} checkpoint=${result.checkpointId} exitCode=${result.exitCode}\n`);
    if (result.stderr.trim()) stdout(deps).write(`${result.stderr.trim()}\n`);
  }
  return result.ok ? 0 : 1;
}
