import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { truncateMiddle } from "../compaction.js";
import { bashExecutable } from "../command-runner.js";
import type { ToolExecutionContext, ToolResult } from "../types.js";
import {
  isProbablyMutatingCommand,
  requestToolPermission,
  resolveWorkspacePath,
  workspaceRelativePath
} from "../policy.js";

type ShellSessionAction = "start" | "send" | "read" | "stop" | "list";

interface ShellSessionArgs {
  action?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  input?: unknown;
  timeoutSec?: unknown;
  maxOutputChars?: unknown;
}

interface ShellSessionRecord {
  id: string;
  child: ChildProcessWithoutNullStreams;
  cwd: string;
  stdout: string;
  stderr: string;
  startedAt: string;
  sequence: number;
}

interface ShellSessionStore {
  sessions: Map<string, ShellSessionRecord>;
}

export interface ShellSessionToolController {
  execute(args: unknown, context: ToolExecutionContext): Promise<ToolResult>;
  close(): Promise<void>;
}

const MAX_BUFFER_CHARS = 200000;

function actionValue(value: unknown): ShellSessionAction | null {
  return value === "start" || value === "send" || value === "read" || value === "stop" || value === "list" ? value : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function appendBounded(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= MAX_BUFFER_CHARS ? combined : combined.slice(-MAX_BUFFER_CHARS);
}

function readAndClear(session: ShellSessionRecord): { stdout: string; stderr: string } {
  const stdout = session.stdout;
  const stderr = session.stderr;
  session.stdout = "";
  session.stderr = "";
  return { stdout, stderr };
}

function formatOutput(stdout: string, stderr: string, exitCode?: number, timedOut?: boolean): string {
  const lines: string[] = [];
  if (exitCode !== undefined) lines.push(`exitCode: ${exitCode}`);
  if (timedOut) lines.push("timedOut: true");
  lines.push("stdout:");
  lines.push(stdout);
  lines.push("stderr:");
  lines.push(stderr);
  return lines.join("\n");
}

function killWindowsProcessTree(pid: number): void {
  const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
    stdio: "ignore",
    windowsHide: true
  });
  killer.on("error", () => {
    // Fall back to child.kill in stopSession.
  });
  killer.unref();
}

function stopSessionRecord(session: ShellSessionRecord): void {
  if (session.child.pid !== undefined) {
    if (process.platform === "win32") {
      killWindowsProcessTree(session.child.pid);
    } else {
      try {
        process.kill(-session.child.pid, "SIGTERM");
        return;
      } catch {
        // Fall back below.
      }
    }
  }
  session.child.kill("SIGTERM");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractMarker(stdout: string, marker: string): { found: boolean; stdout: string; exitCode?: number } {
  const regex = new RegExp(`\\r?\\n?${marker}:(\\d+)\\r?\\n?`);
  const match = regex.exec(stdout);
  if (!match) return { found: false, stdout };
  const exitCode = Number(match[1]);
  return {
    found: true,
    stdout: stdout.slice(0, match.index) + stdout.slice(match.index + match[0].length),
    exitCode: Number.isFinite(exitCode) ? exitCode : undefined
  };
}

async function startSession(args: ShellSessionArgs, context: ToolExecutionContext, store: ShellSessionStore): Promise<ToolResult> {
  const denied = await requestToolPermission(context, {
    toolName: "shell_session",
    arguments: args,
    risk: "execute",
    reason: "Start a persistent shell session"
  });
  if (denied) return denied;

  let cwd: string;
  try {
    cwd = typeof args.cwd === "string" ? resolveWorkspacePath(context.workspacePath, args.cwd) : context.workspacePath;
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }

  const id = stringValue(args.sessionId) ?? randomUUID();
  if (store.sessions.has(id)) return { ok: false, content: `shell_session already exists: ${id}` };
  const child = spawn(bashExecutable(), ["--noprofile", "--norc"], {
    cwd,
    env: process.env,
    detached: process.platform !== "win32",
    windowsHide: true
  });
  const session: ShellSessionRecord = {
    id,
    child,
    cwd,
    stdout: "",
    stderr: "",
    startedAt: new Date().toISOString(),
    sequence: 0
  };
  child.stdout.on("data", (chunk: Buffer) => {
    session.stdout = appendBounded(session.stdout, chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    session.stderr = appendBounded(session.stderr, chunk.toString("utf8"));
  });
  child.on("exit", () => {
    store.sessions.delete(id);
  });
  child.on("error", (error) => {
    session.stderr = appendBounded(session.stderr, error.message);
    store.sessions.delete(id);
  });
  store.sessions.set(id, session);
  return {
    ok: true,
    content: `shell_session ${id} started cwd=${workspaceRelativePath(context.workspacePath, cwd) || "."}`,
    metadata: { sessionId: id, cwd, startedAt: session.startedAt }
  };
}

async function sendToSession(args: ShellSessionArgs, context: ToolExecutionContext, store: ShellSessionStore): Promise<ToolResult> {
  const id = stringValue(args.sessionId);
  const input = stringValue(args.input);
  if (!id || !input) return { ok: false, content: "shell_session.send requires sessionId and input" };
  const session = store.sessions.get(id);
  if (!session) return { ok: false, content: `Unknown shell_session: ${id}` };

  if (isProbablyMutatingCommand(input)) {
    const denied = await requestToolPermission(context, {
      toolName: "shell_session",
      arguments: args,
      risk: "execute",
      reason: `Persistent shell input appears mutating or risky: ${input}`
    });
    if (denied) return denied;
  }

  readAndClear(session);
  session.sequence += 1;
  const marker = `__SIGMA_SESSION_DONE_${session.id.replace(/[^A-Za-z0-9_]/g, "_")}_${session.sequence}__`;
  const command = `${input.endsWith("\n") ? input : `${input}\n`}printf '\\n${marker}:%s\\n' "$?"\n`;
  session.child.stdin.write(command);

  const timeoutSec = numberValue(args.timeoutSec, context.commandTimeoutSec, 1, 3600);
  const deadline = Date.now() + timeoutSec * 1000;
  let exitCode: number | undefined;
  let found = false;
  while (Date.now() <= deadline) {
    const extracted = extractMarker(session.stdout, marker);
    if (extracted.found) {
      session.stdout = extracted.stdout;
      exitCode = extracted.exitCode;
      found = true;
      break;
    }
    await sleep(50);
  }

  const output = readAndClear(session);
  if (!found) {
    stopSessionRecord(session);
    store.sessions.delete(id);
  }
  const content = [
    formatOutput(output.stdout, output.stderr, exitCode, !found),
    !found ? "sessionState: stopped_after_timeout" : ""
  ].filter(Boolean).join("\n");
  const maxOutputChars = numberValue(args.maxOutputChars, context.maxToolOutputChars, 200, 50000);
  const truncated = truncateMiddle(content, maxOutputChars);
  return {
    ok: found && exitCode === 0,
    content: truncated.text,
    metadata: {
      sessionId: id,
      exitCode,
      timedOut: !found,
      sessionState: found ? "idle" : "stopped_after_timeout",
      truncated: truncated.truncated
    }
  };
}

async function readSession(args: ShellSessionArgs, context: ToolExecutionContext, store: ShellSessionStore): Promise<ToolResult> {
  const id = stringValue(args.sessionId);
  if (!id) return { ok: false, content: "shell_session.read requires sessionId" };
  const session = store.sessions.get(id);
  if (!session) return { ok: false, content: `Unknown shell_session: ${id}` };
  const output = readAndClear(session);
  const maxOutputChars = numberValue(args.maxOutputChars, context.maxToolOutputChars, 200, 50000);
  const content = formatOutput(output.stdout, output.stderr);
  const truncated = truncateMiddle(content, maxOutputChars);
  return { ok: true, content: truncated.text, metadata: { sessionId: id, truncated: truncated.truncated } };
}

async function stopSession(args: ShellSessionArgs, context: ToolExecutionContext, store: ShellSessionStore): Promise<ToolResult> {
  const id = stringValue(args.sessionId);
  if (!id) return { ok: false, content: "shell_session.stop requires sessionId" };
  const session = store.sessions.get(id);
  if (!session) return { ok: false, content: `Unknown shell_session: ${id}` };
  const denied = await requestToolPermission(context, {
    toolName: "shell_session",
    arguments: args,
    risk: "execute",
    reason: `Stop persistent shell session ${id}`
  });
  if (denied) return denied;
  stopSessionRecord(session);
  store.sessions.delete(id);
  return { ok: true, content: `shell_session ${id} stopped`, metadata: { sessionId: id } };
}

function listSessions(store: ShellSessionStore): ToolResult {
  return {
    ok: true,
    content: JSON.stringify(
      [...store.sessions.values()].map((session) => ({
        sessionId: session.id,
        cwd: session.cwd,
        startedAt: session.startedAt
      })),
      null,
      2
    ),
    metadata: { sessionIds: [...store.sessions.keys()] }
  };
}

async function executeShellSessionToolWithStore(
  args: unknown,
  context: ToolExecutionContext,
  store: ShellSessionStore
): Promise<ToolResult> {
  const parsed = (args && typeof args === "object" ? args : {}) as ShellSessionArgs;
  const action = actionValue(parsed.action);
  if (!action) return { ok: false, content: "shell_session requires action: start, send, read, stop, or list" };
  if (action === "start") return await startSession(parsed, context, store);
  if (action === "send") return await sendToSession(parsed, context, store);
  if (action === "read") return await readSession(parsed, context, store);
  if (action === "stop") return await stopSession(parsed, context, store);
  return listSessions(store);
}

async function closeShellSessionStore(store: ShellSessionStore): Promise<void> {
  for (const session of store.sessions.values()) {
    stopSessionRecord(session);
  }
  store.sessions.clear();
}

export function createShellSessionToolController(): ShellSessionToolController {
  const store: ShellSessionStore = { sessions: new Map<string, ShellSessionRecord>() };
  return {
    async execute(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
      return await executeShellSessionToolWithStore(args, context, store);
    },
    async close(): Promise<void> {
      await closeShellSessionStore(store);
    }
  };
}

const defaultShellSessionController = createShellSessionToolController();

export async function executeShellSessionTool(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  return await defaultShellSessionController.execute(args, context);
}

export async function closeShellSessions(): Promise<void> {
  await defaultShellSessionController.close();
}
