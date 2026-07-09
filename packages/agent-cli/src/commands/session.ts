import type { AgentEventEnvelope, RuntimeClient, SessionOverview } from "agent-protocol";
import path from "node:path";
import { activeSessionOwner, sendSessionCommand } from "agent-runtime";
import { loadCliConfig, parseArgs } from "../config.js";
import { createConfiguredRuntime } from "agent-runtime";

interface SessionCommandDeps {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  runtime?: RuntimeClient;
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
  const runtime = deps.runtime ?? (await createConfiguredRuntime(config, {}, { connectMcp: false })).runtime;
  return { runtime, storeRootDir: path.join(config.workspace, ".agent"), ...parsed };
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
  if (!first) throw new Error("No v2 sessions exist in this workspace.");
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

async function handleOwnedSession(
  subcommand: string,
  parsed: ConfiguredSessionCommand,
  sessionId: string,
  ownerPid: number,
  io: SessionIo
): Promise<number | undefined> {
  if (subcommand === "resume") {
    io.stdout.write(`already active ${sessionId} pid=${ownerPid}\n`);
    return 0;
  }
  if (subcommand === "cancel") {
    await sendSessionCommand(parsed.storeRootDir, {
      type: "cancel", sessionId, reason: cancellationReason(parsed.flags)
    });
    io.stdout.write(`cancel requested ${sessionId}\n`);
    return 0;
  }
  if (subcommand !== "approve") return undefined;
  const requestId = requiredRequestId(parsed);
  const decision = approvalDecision(parsed.flags);
  await sendSessionCommand(parsed.storeRootDir, { type: "approve", sessionId, requestId, decision });
  io.stdout.write(`${decision} requested for ${requestId}\n`);
  return 0;
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
  throw new Error(`Unknown session command '${subcommand}'.`);
}

async function executeSessionCommand(argv: string[], deps: SessionCommandDeps, io: SessionIo): Promise<number> {
  const [subcommand = "list", ...rest] = argv;
  if (subcommand === "list") return await runSessionsCommand(rest, deps);
  const parsed = await configured(rest, deps);
  const sessionId = await targetSession(parsed.runtime, parsed.positionals[0], parsed.flags.latest === true);
  if (subcommand === "show") return await showSession(parsed, sessionId, io);
  const owner = await activeSessionOwner(parsed.storeRootDir, sessionId);
  if (owner) {
    const result = await handleOwnedSession(subcommand, parsed, sessionId, owner.pid, io);
    if (result !== undefined) return result;
  }
  return await handleStoredSession(subcommand, parsed, sessionId, io);
}

export async function runSessionsCommand(argv: string[], deps: SessionCommandDeps = {}): Promise<number> {
  const io = streams(deps);
  try {
    const { runtime, flags } = await configured(argv, deps);
    const limit = typeof flags.limit === "string" ? Number(flags.limit) : 20;
    const sessions = await runtime.listSessions(limit);
    if (flags.json === true) io.stdout.write(`${JSON.stringify({ sessions })}\n`);
    else if (sessions.length === 0) io.stdout.write("No v2 sessions.\n");
    else io.stdout.write(`${sessions.map(presentation).join("\n")}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function runSessionCommand(argv: string[], deps: SessionCommandDeps = {}): Promise<number> {
  const io = streams(deps);
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout.write("agent session <list|show|resume|cancel|approve> [session] [request-id] [flags]\n");
    return 0;
  }
  try {
    return await executeSessionCommand(argv, deps, io);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
