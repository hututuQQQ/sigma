import type {
  AgentEventEnvelope,
  BudgetLimits,
  RuntimeClient,
  SessionOverview
} from "agent-protocol";
import { realpath } from "node:fs/promises";
import {
  activeSessionOwner,
  runtimeStateRoot,
  sendSessionCommand
} from "agent-runtime/session-admin";
import { loadCliConfig, parseArgs } from "../config.js";
import { createConfiguredRuntime } from "agent-runtime";

interface SessionCommandDeps {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  runtime?: RuntimeClient;
  createConfiguredRuntime?: typeof createConfiguredRuntime;
  activeSessionOwner?: typeof activeSessionOwner;
  sendSessionCommand?: typeof sendSessionCommand;
}

interface SessionIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

interface ConfiguredSessionCommand {
  runtime: RuntimeClient;
  flags: Record<string, unknown>;
  positionals: string[];
  storeRootDir: string;
  close?: () => Promise<void>;
}

function streams(deps: SessionCommandDeps): SessionIo {
  return { stdout: deps.stdout ?? process.stdout, stderr: deps.stderr ?? process.stderr };
}

function presentation(session: SessionOverview): string {
  return `${session.sessionId}  ${session.status.padEnd(11)}  ${session.mode.padEnd(7)}  ${session.updatedAt}  ${session.workspacePath}`;
}

async function configured(argv: string[], deps: SessionCommandDeps): Promise<ConfiguredSessionCommand> {
  const parsed = parseArgs(argv);
  const config = loadCliConfig(parsed.flags);
  const configuredRuntime = deps.runtime ? undefined : await (deps.createConfiguredRuntime ?? createConfiguredRuntime)(
    config, {}, { connectMcp: false }
  );
  const runtime = deps.runtime ?? configuredRuntime!.runtime;
  const workspace = configuredRuntime?.workspace ?? await realpath(config.workspace);
  return {
    runtime,
    storeRootDir: configuredRuntime?.storeRootDir ?? runtimeStateRoot(workspace),
    ...(configuredRuntime ? { close: async () => await configuredRuntime.close() } : {}),
    ...parsed
  };
}

function approvalDecision(flags: Record<string, unknown>): "allow" | "deny" | "always_allow" {
  return typeof flags.decision === "string"
    ? flags.decision as "allow" | "deny" | "always_allow"
    : "allow";
}

function cancellationReason(flags: Record<string, unknown>): string | undefined {
  return typeof flags.reason === "string" ? flags.reason : undefined;
}

async function targetSession(runtime: RuntimeClient, requested: string | undefined, latest: boolean): Promise<string> {
  if (requested) return requested;
  if (!latest) throw new Error("A session id is required (or pass --latest)." );
  const first = (await runtime.listSessions(1))[0];
  if (!first) throw new Error("No sessions exist in this workspace.");
  return first.sessionId;
}

async function collectEvents(runtime: RuntimeClient, sessionId: string): Promise<AgentEventEnvelope[]> {
  const events: AgentEventEnvelope[] = [];
  for await (const event of runtime.sessionEvents(sessionId)) events.push(event);
  if (events.length === 0) throw new Error(`Session '${sessionId}' was not found.`);
  return events;
}

async function showSession(parsed: ConfiguredSessionCommand, sessionId: string, io: SessionIo): Promise<number> {
  const events = await collectEvents(parsed.runtime, sessionId);
  const summary = (await parsed.runtime.listSessions(1_000)).find((item) => item.sessionId === sessionId);
  if (parsed.flags.json === true) {
    io.stdout.write(`${JSON.stringify({ summary, events })}\n`);
    return 0;
  }
  if (summary) io.stdout.write(`${presentation(summary)}\n`);
  for (const event of events) io.stdout.write(`${String(event.seq).padStart(6)}  ${event.occurredAt}  ${event.type}\n`);
  return 0;
}

function requiredRequestId(parsed: ConfiguredSessionCommand): string {
  const requestId = parsed.positionals[1];
  if (!requestId) throw new Error("session approve requires a request id.");
  return requestId;
}

function checkpointRecovery(parsed: ConfiguredSessionCommand): {
  checkpointId: string;
  decision: "restore" | "keep";
} {
  const checkpointId = parsed.positionals[1];
  if (!checkpointId) throw new Error("session recover requires a checkpoint id.");
  const restore = parsed.flags.restore === true;
  const keep = parsed.flags.keep === true;
  if (restore === keep) throw new Error("session recover requires exactly one of --restore or --keep.");
  return { checkpointId, decision: restore ? "restore" : "keep" };
}

function reviewerWaiver(parsed: ConfiguredSessionCommand): {
  reason: string;
  checkpointId?: string;
} {
  const reason = typeof parsed.flags.reason === "string" ? parsed.flags.reason.trim() : "";
  if (!reason || reason.length > 2_000) {
    throw new Error("session waive-reviewer requires --reason with 1 to 2,000 characters.");
  }
  const checkpointId = parsed.positionals[1]?.trim();
  return { reason, ...(checkpointId ? { checkpointId } : {}) };
}

const BUDGET_FLAGS = {
  "max-input-tokens": "inputTokens",
  "max-output-tokens": "outputTokens",
  "max-cost-micro-usd": "costMicroUsd",
  "max-model-turns": "modelTurns",
  "max-tool-calls": "toolCalls",
  "max-children": "children",
  "max-agent-depth": "maxDepth"
} as const satisfies Record<string, keyof BudgetLimits>;

function budgetIncrease(flags: Record<string, unknown>): Partial<BudgetLimits> {
  const increase: Partial<BudgetLimits> = {};
  for (const [flag, dimension] of Object.entries(BUDGET_FLAGS)) {
    const raw = flags[flag];
    if (raw === undefined) continue;
    const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${flag} must be a non-negative integer.`);
    increase[dimension] = value;
  }
  if (!Object.values(increase).some((value) => value > 0)) {
    throw new Error("session budget requires at least one positive limit increase.");
  }
  return increase;
}

async function handleOwnedSession(
  subcommand: string,
  parsed: ConfiguredSessionCommand,
  sessionId: string,
  ownerPid: number,
  io: SessionIo,
  sendCommand: typeof sendSessionCommand
): Promise<number | undefined> {
  if (subcommand === "resume") {
    io.stdout.write(`already active ${sessionId} pid=${ownerPid}\n`);
    return 0;
  }
  if (subcommand === "cancel") {
    await sendCommand(parsed.storeRootDir, {
      type: "cancel", sessionId, reason: cancellationReason(parsed.flags)
    });
    io.stdout.write(`cancel requested ${sessionId}\n`);
    return 0;
  }
  if (subcommand === "recover") {
    const recovery = checkpointRecovery(parsed);
    await sendCommand(parsed.storeRootDir, {
      type: "checkpoint_recovery",
      sessionId,
      ...recovery
    });
    io.stdout.write(`${recovery.decision} requested ${recovery.checkpointId}\n`);
    return 0;
  }
  if (subcommand === "budget") {
    const increase = budgetIncrease(parsed.flags);
    await sendCommand(parsed.storeRootDir, { type: "budget_increase", sessionId, increase });
    io.stdout.write(`budget increase requested ${sessionId} ${JSON.stringify(increase)}\n`);
    return 0;
  }
  if (subcommand === "waive-reviewer") {
    const waiver = reviewerWaiver(parsed);
    await sendCommand(parsed.storeRootDir, { type: "reviewer_waiver", sessionId, ...waiver });
    io.stdout.write(`reviewer waiver requested ${waiver.checkpointId ?? "latest-pending"}\n`);
    return 0;
  }
  if (subcommand !== "approve") return undefined;
  throw new Error("An active session approval must be answered in its controlling TUI; cross-process approval is disabled.");
}

async function handleStoredSession(
  subcommand: string,
  parsed: ConfiguredSessionCommand,
  sessionId: string,
  io: SessionIo
): Promise<number> {
  await parsed.runtime.command({ type: "resume", sessionId });
  if (subcommand === "resume") {
    io.stdout.write(`resumed ${sessionId}\n`);
    return 0;
  }
  if (subcommand === "cancel") {
    await parsed.runtime.command({ type: "cancel", sessionId, reason: cancellationReason(parsed.flags) });
    io.stdout.write(`cancelled ${sessionId}\n`);
    return 0;
  }
  if (subcommand === "approve") {
    const requestId = requiredRequestId(parsed);
    const decision = approvalDecision(parsed.flags);
    await parsed.runtime.command({ type: "approve", sessionId, requestId, decision });
    io.stdout.write(`${decision} ${requestId}\n`);
    return 0;
  }
  if (subcommand === "undo") {
    if (!parsed.runtime.undoLatestCheckpoint) throw new Error("This runtime does not support safe checkpoint undo.");
    const restored = await parsed.runtime.undoLatestCheckpoint(sessionId);
    io.stdout.write(`restored ${restored.checkpointId}\n`);
    return 0;
  }
  if (subcommand === "recover") {
    const recovery = checkpointRecovery(parsed);
    await parsed.runtime.command({
      type: "checkpoint_recovery",
      sessionId,
      ...recovery
    });
    io.stdout.write(`${recovery.decision} ${recovery.checkpointId}\n`);
    return 0;
  }
  if (subcommand === "budget") {
    const increase = budgetIncrease(parsed.flags);
    await parsed.runtime.command({ type: "budget_increase", sessionId, increase });
    io.stdout.write(`budget increased ${sessionId} ${JSON.stringify(increase)}\n`);
    return 0;
  }
  if (subcommand === "waive-reviewer") {
    const waiver = reviewerWaiver(parsed);
    await parsed.runtime.command({ type: "reviewer_waiver", sessionId, ...waiver });
    io.stdout.write(`reviewer waived ${waiver.checkpointId ?? "latest-pending"}\n`);
    return 0;
  }
  throw new Error(`Unknown session command '${subcommand}'.`);
}

async function executeConfiguredSessionCommand(
  subcommand: string,
  parsed: ConfiguredSessionCommand,
  deps: SessionCommandDeps,
  io: SessionIo
): Promise<number> {
  const sessionId = await targetSession(parsed.runtime, parsed.positionals[0], parsed.flags.latest === true);
  if (subcommand === "show") return await showSession(parsed, sessionId, io);
  const owner = await (deps.activeSessionOwner ?? activeSessionOwner)(parsed.storeRootDir, sessionId);
  if (owner) {
    const result = await handleOwnedSession(
      subcommand, parsed, sessionId, owner.pid, io, deps.sendSessionCommand ?? sendSessionCommand
    );
    if (result !== undefined) return result;
  }
  return await handleStoredSession(subcommand, parsed, sessionId, io);
}

async function executeSessionCommand(argv: string[], deps: SessionCommandDeps, io: SessionIo): Promise<number> {
  const [subcommand = "list", ...rest] = argv;
  if (subcommand === "list") return await executeSessionsCommand(rest, deps, io);
  const parsed = await configured(rest, deps);
  try {
    return await executeConfiguredSessionCommand(subcommand, parsed, deps, io);
  } finally {
    await parsed.close?.();
  }
}

async function executeSessionsCommand(argv: string[], deps: SessionCommandDeps, io: SessionIo): Promise<number> {
  const parsed = await configured(argv, deps);
  try {
    const { runtime, flags } = parsed;
    const limit = typeof flags.limit === "string" ? Number(flags.limit) : 20;
    const sessions = await runtime.listSessions(limit);
    if (flags.json === true) io.stdout.write(`${JSON.stringify({ sessions })}\n`);
    else if (sessions.length === 0) io.stdout.write("No sessions.\n");
    else io.stdout.write(`${sessions.map(presentation).join("\n")}\n`);
    return 0;
  } finally {
    await parsed.close?.();
  }
}

export async function runSessionsCommand(argv: string[], deps: SessionCommandDeps = {}): Promise<number> {
  const io = streams(deps);
  try {
    return await executeSessionsCommand(argv, deps, io);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function runSessionCommand(argv: string[], deps: SessionCommandDeps = {}): Promise<number> {
  const io = streams(deps);
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout.write("agent session <list|show|resume|cancel|approve|undo|recover|budget|waive-reviewer> [session] [request-or-checkpoint-id] [flags]\n");
    return 0;
  }
  try {
    return await executeSessionCommand(argv, deps, io);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
