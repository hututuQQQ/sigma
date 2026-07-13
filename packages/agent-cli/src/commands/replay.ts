import { createPresentationState, projectEvent } from "agent-presentation";
import { loadCliConfig, parseArgs } from "../config.js";
import { createConfiguredRuntime, type RuntimeFactoryDeps } from "agent-runtime";

interface ReplayDeps {
  runtime?: import("agent-protocol").RuntimeClient;
  createConfiguredRuntime?: typeof createConfiguredRuntime;
  runtimeFactoryDeps?: RuntimeFactoryDeps;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

interface TimelineItem {
  seq: number;
  occurredAt: string;
  type: string;
}

interface ReplayReport {
  sessionId: string;
  events: number;
  state: ReturnType<typeof createPresentationState>;
  timeline?: TimelineItem[];
}

async function resolveSessionId(
  runtime: import("agent-protocol").RuntimeClient,
  requested: string | undefined,
  latest: boolean
): Promise<string> {
  const sessionId = requested ?? (latest ? (await runtime.listSessions(1))[0]?.sessionId : undefined);
  if (!sessionId) throw new Error("replay requires a session id or --latest.");
  return sessionId;
}

async function buildReplay(
  runtime: import("agent-protocol").RuntimeClient,
  sessionId: string,
  includeTimeline: boolean
): Promise<ReplayReport> {
  let state = createPresentationState();
  const timeline: TimelineItem[] = [];
  let events = 0;
  for await (const event of runtime.sessionEvents(sessionId)) {
    state = projectEvent(state, event);
    events += 1;
    if (includeTimeline) timeline.push({ seq: event.seq, occurredAt: event.occurredAt, type: event.type });
  }
  if (events === 0) throw new Error(`Session '${sessionId}' was not found.`);
  return { sessionId, events, state, ...(includeTimeline ? { timeline } : {}) };
}

function writeTextReport(report: ReplayReport, stdout: NodeJS.WritableStream): void {
  stdout.write(`session=${report.sessionId}\nevents=${report.events}\nstatus=${report.state.status}\n`);
  for (const item of report.state.transcript) stdout.write(`${item.role}> ${item.text}\n`);
  for (const item of report.timeline ?? []) stdout.write(`${item.seq} ${item.occurredAt} ${item.type}\n`);
}

async function executeReplay(argv: string[], deps: ReplayDeps, stdout: NodeJS.WritableStream): Promise<void> {
  const { flags, positionals } = parseArgs(argv);
  const configured = deps.runtime ? undefined : await (deps.createConfiguredRuntime ?? createConfiguredRuntime)(
    loadCliConfig(flags), deps.runtimeFactoryDeps ?? {}, { connectMcp: false }
  );
  const runtime = deps.runtime ?? configured!.runtime;
  try {
    const sessionId = await resolveSessionId(runtime, positionals[0], flags.latest === true);
    const report = await buildReplay(runtime, sessionId, flags.timeline === true);
    if (flags.json === true) stdout.write(`${JSON.stringify(report)}\n`);
    else writeTextReport(report, stdout);
  } finally {
    await configured?.close();
  }
}

export async function runReplayCommand(argv: string[], deps: ReplayDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout.write("agent replay <session-id> [--latest] [--timeline] [--json] [--workspace <path>]\n");
    return 0;
  }
  try {
    await executeReplay(argv, deps, stdout);
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
