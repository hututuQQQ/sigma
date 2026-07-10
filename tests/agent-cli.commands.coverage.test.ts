import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import type {
  AgentEventEnvelope,
  AgentEventType,
  JsonValue,
  RunCommand,
  RunOutcome,
  RuntimeClient,
  SessionOverview,
  SessionRef,
  StartSession
} from "../packages/agent-protocol/src/index.js";
import { runAgentCommand } from "../packages/agent-cli/src/index.js";
import { runInitCommand } from "../packages/agent-cli/src/commands/init.js";
import { runReplayCommand } from "../packages/agent-cli/src/commands/replay.js";
import { runSessionCommand, runSessionsCommand } from "../packages/agent-cli/src/commands/session.js";
import { runtimeStateRoot } from "../packages/agent-runtime/src/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

class Capture extends Writable {
  readonly chunks: Buffer[] = [];
  isTTY = false;

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function overview(sessionId = "session-one"): SessionOverview {
  return {
    sessionId,
    workspacePath: "C:/workspace",
    mode: "change",
    status: "completed",
    updatedAt: "2026-07-10T00:00:00.000Z",
    lastSeq: 3,
    lastMessage: "done"
  };
}

function event(
  seq: number,
  type: AgentEventType,
  payload: JsonValue = {},
  sessionId = "session-one"
): AgentEventEnvelope {
  return {
    schemaVersion: 2,
    seq,
    eventId: `event-${seq}`,
    sessionId,
    runId: "run-one",
    occurredAt: `2026-07-10T00:00:0${seq}.000Z`,
    type,
    authority: "runtime",
    payload
  };
}

class FakeRuntime implements RuntimeClient {
  readonly commands: RunCommand[] = [];
  sessions: SessionOverview[] = [];
  events = new Map<string, AgentEventEnvelope[]>();
  listFailure?: Error;

  async createSession(_input: StartSession): Promise<SessionRef> {
    return { sessionId: "created", runId: "run-created" };
  }

  async command(command: RunCommand): Promise<void> {
    this.commands.push(command);
  }

  async *subscribe(_sessionId: string, _signal?: AbortSignal): AsyncIterable<AgentEventEnvelope> {}

  async waitForOutcome(_sessionId: string, _signal?: AbortSignal): Promise<RunOutcome> {
    return { kind: "completed", message: "done", evidence: [] };
  }

  async listSessions(_limit?: number): Promise<SessionOverview[]> {
    if (this.listFailure) throw this.listFailure;
    return this.sessions;
  }

  async *sessionEvents(sessionId: string, _afterSeq?: number): AsyncIterable<AgentEventEnvelope> {
    for (const item of this.events.get(sessionId) ?? []) yield item;
  }
}

async function workspace(prefix: string): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeOwner(root: string, sessionId: string): Promise<void> {
  const directory = path.join(runtimeStateRoot(root), "sessions", sessionId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "runtime-owner.json"), JSON.stringify({
    pid: process.pid,
    instanceId: "coverage-owner",
    startedAt: new Date().toISOString()
  }), "utf8");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("CLI init and replay branches", () => {
  it("prints init help and handles profiles, JSON, force, and existing files", async () => {
    const root = await workspace("sigma-init-coverage-");
    const help = new Capture();
    await expect(runInitCommand(["--help"], { stdout: help })).resolves.toBe(0);
    expect(help.text()).toContain("agent init");

    const json = new Capture();
    await expect(runInitCommand(["--workspace", root, "--profile", "ci", "--json"], { stdout: json })).resolves.toBe(0);
    expect(JSON.parse(json.text())).toMatchObject({ ok: true, profile: "ci" });
    expect(await readFile(path.join(root, ".agent", "config.toml"), "utf8")).toContain('mode = "auto"');

    const existsError = new Capture();
    await expect(runInitCommand(["--workspace", root], { stderr: existsError })).resolves.toBe(1);
    expect(existsError.text()).toContain("already exists");

    const forced = new Capture();
    await expect(runInitCommand([
      "--workspace", root, "--profile", "team", "--permission-mode", "deny", "--force"
    ], { stdout: forced })).resolves.toBe(0);
    expect(forced.text()).toContain("initialized");
    expect(await readFile(path.join(root, ".agent", "config.toml"), "utf8")).toContain('mode = "deny"');
  });

  it("reports invalid init options", async () => {
    const stderr = new Capture();
    await expect(runInitCommand(["--profile", "unknown"], { stderr })).resolves.toBe(1);
    expect(stderr.text()).toContain("must be one of");
  });

  it("replays the latest session as text with a timeline", async () => {
    const runtime = new FakeRuntime();
    runtime.sessions = [overview()];
    runtime.events.set("session-one", [
      event(1, "user.message", { text: "question" }),
      event(2, "model.delta", { delta: "answer", turnId: 1 }),
      event(3, "run.completed", { message: "answer" })
    ]);
    const stdout = new Capture();
    await expect(runReplayCommand(["--latest", "--timeline"], { runtime, stdout })).resolves.toBe(0);
    expect(stdout.text()).toContain("session=session-one");
    expect(stdout.text()).toContain("user> question");
    expect(stdout.text()).toContain("3 2026-07-10T00:00:03.000Z run.completed");
  });

  it("covers replay help and missing-session failures", async () => {
    const runtime = new FakeRuntime();
    const help = new Capture();
    await expect(runReplayCommand(["-h"], { runtime, stdout: help })).resolves.toBe(0);
    expect(help.text()).toContain("agent replay");

    for (const argv of [[], ["--latest"], ["missing"]]) {
      const stderr = new Capture();
      await expect(runReplayCommand(argv, { runtime, stderr })).resolves.toBe(1);
      expect(stderr.text()).toMatch(/requires a session id|No session|was not found/);
    }
  });

  it("constructs the configured replay runtime when one is not injected", async () => {
    const root = await workspace("sigma-replay-runtime-");
    const stderr = new Capture();
    await expect(runReplayCommand(["--latest", "--workspace", root], { stderr })).resolves.toBe(1);
    expect(stderr.text()).toContain("replay requires a session id");
  });
});

describe("CLI session branches", () => {
  it("lists empty, text, JSON, limited, and failed session results", async () => {
    const runtime = new FakeRuntime();
    const empty = new Capture();
    await expect(runSessionsCommand([], { runtime, stdout: empty })).resolves.toBe(0);
    expect(empty.text()).toBe("No sessions.\n");
    const defaultCommand = new Capture();
    await expect(runSessionCommand([], { runtime, stdout: defaultCommand })).resolves.toBe(0);
    expect(defaultCommand.text()).toBe("No sessions.\n");

    runtime.sessions = [overview()];
    const text = new Capture();
    await expect(runSessionsCommand(["--limit", "3"], { runtime, stdout: text })).resolves.toBe(0);
    expect(text.text()).toContain("session-one");
    const json = new Capture();
    await expect(runSessionsCommand(["--json"], { runtime, stdout: json })).resolves.toBe(0);
    expect(JSON.parse(json.text()).sessions).toHaveLength(1);

    runtime.listFailure = new Error("list failed");
    const stderr = new Capture();
    await expect(runSessionsCommand([], { runtime, stderr })).resolves.toBe(1);
    expect(stderr.text()).toContain("list failed");
  });

  it("shows sessions as text and JSON and reports missing events", async () => {
    const runtime = new FakeRuntime();
    runtime.sessions = [overview()];
    runtime.events.set("session-one", [event(1, "run.started"), event(2, "run.completed")]);
    runtime.events.set("orphan", [event(1, "run.started", {}, "orphan")]);

    const text = new Capture();
    await expect(runSessionCommand(["show", "session-one"], { runtime, stdout: text })).resolves.toBe(0);
    expect(text.text()).toContain("run.completed");
    const json = new Capture();
    await expect(runSessionCommand(["show", "session-one", "--json"], { runtime, stdout: json })).resolves.toBe(0);
    expect(JSON.parse(json.text()).events).toHaveLength(2);
    const noSummary = new Capture();
    await expect(runSessionCommand(["show", "orphan"], { runtime, stdout: noSummary })).resolves.toBe(0);
    expect(noSummary.text()).not.toContain("C:/workspace");

    const stderr = new Capture();
    await expect(runSessionCommand(["show", "missing"], { runtime, stderr })).resolves.toBe(1);
    expect(stderr.text()).toContain("was not found");
  });

  it("validates help, target selection, and latest selection", async () => {
    const runtime = new FakeRuntime();
    const help = new Capture();
    await expect(runSessionCommand(["--help"], { runtime, stdout: help })).resolves.toBe(0);
    expect(help.text()).toContain("agent session");

    const missing = new Capture();
    await expect(runSessionCommand(["resume"], { runtime, stderr: missing })).resolves.toBe(1);
    expect(missing.text()).toContain("session id is required");
    const latest = new Capture();
    await expect(runSessionCommand(["resume", "--latest"], { runtime, stderr: latest })).resolves.toBe(1);
    expect(latest.text()).toContain("No sessions");

    runtime.sessions = [overview()];
    const resumed = new Capture();
    await expect(runSessionCommand(["resume", "--latest"], { runtime, stdout: resumed })).resolves.toBe(0);
    expect(resumed.text()).toContain("resumed session-one");
  });

  it("routes stored cancel and approval commands through RuntimeClient", async () => {
    const runtime = new FakeRuntime();
    const cancel = new Capture();
    await expect(runSessionCommand(["cancel", "stored", "--reason", "stop"], { runtime, stdout: cancel })).resolves.toBe(0);
    expect(runtime.commands.slice(-2)).toEqual([
      { type: "resume", sessionId: "stored" },
      { type: "cancel", sessionId: "stored", reason: "stop" }
    ]);

    const approve = new Capture();
    await expect(runSessionCommand([
      "approve", "stored", "request-one", "--decision", "always_allow"
    ], { runtime, stdout: approve })).resolves.toBe(0);
    expect(runtime.commands.at(-1)).toEqual({
      type: "approve", sessionId: "stored", requestId: "request-one", decision: "always_allow"
    });

    await expect(runSessionCommand(["cancel", "defaults"], { runtime, stdout: new Capture() })).resolves.toBe(0);
    expect(runtime.commands.at(-1)).toEqual({ type: "cancel", sessionId: "defaults", reason: undefined });
    await expect(runSessionCommand(["approve", "defaults", "request-default"], {
      runtime,
      stdout: new Capture()
    })).resolves.toBe(0);
    expect(runtime.commands.at(-1)).toEqual({
      type: "approve", sessionId: "defaults", requestId: "request-default", decision: "allow"
    });

    const missingRequest = new Capture();
    await expect(runSessionCommand(["approve", "stored"], { runtime, stderr: missingRequest })).resolves.toBe(1);
    expect(missingRequest.text()).toContain("requires a request id");
    const unknown = new Capture();
    await expect(runSessionCommand(["unknown", "stored"], { runtime, stderr: unknown })).resolves.toBe(1);
    expect(unknown.text()).toContain("Unknown session command");
  });

  it("routes active session commands through the durable owner inbox", async () => {
    const root = await workspace("sigma-session-owner-");
    vi.stubEnv("SIGMA_STATE_HOME", path.join(root, "private-state"));
    const runtime = new FakeRuntime();
    await writeOwner(root, "active");

    const resume = new Capture();
    await expect(runSessionCommand(["resume", "active", "--workspace", root], { runtime, stdout: resume })).resolves.toBe(0);
    expect(resume.text()).toContain(`pid=${process.pid}`);

    const cancel = new Capture();
    await expect(runSessionCommand([
      "cancel", "active", "--workspace", root, "--reason", "operator"
    ], { runtime, stdout: cancel })).resolves.toBe(0);
    const approval = new Capture();
    await expect(runSessionCommand([
      "approve", "active", "request-two", "--workspace", root, "--decision", "deny"
    ], { runtime, stderr: approval })).resolves.toBe(1);
    expect(approval.text()).toContain("controlling TUI");

    const commandDir = path.join(runtimeStateRoot(root), "sessions", "active", "commands");
    const files = await readdir(commandDir);
    const commands = await Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(commandDir, file), "utf8")) as RunCommand));
    expect(commands).toEqual([{ type: "cancel", sessionId: "active", reason: "operator" }]);

    const unknown = new Capture();
    await expect(runSessionCommand(["unknown", "active", "--workspace", root], {
      runtime,
      stderr: unknown
    })).resolves.toBe(1);
    expect(unknown.text()).toContain("Unknown session command");
  });
});

describe("CLI command registry dispatch", () => {
  it("routes help-capable public commands and normalized argv", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(runAgentCommand(["--"])).resolves.toBe(0);
    await expect(runAgentCommand(["run", "--help"])).resolves.toBe(0);
    await expect(runAgentCommand(["inspect", "--help"])).resolves.toBe(0);
    await expect(runAgentCommand(["tui", "--help"])).resolves.toBe(0);
    await expect(runAgentCommand(["session", "--help"])).resolves.toBe(0);
    await expect(runAgentCommand(["cancel", "--help"])).resolves.toBe(0);
    await expect(runAgentCommand(["replay", "--help"])).resolves.toBe(0);
    await expect(runAgentCommand(["doctor", "--help"])).resolves.toBe(0);
    await expect(runAgentCommand(["init", "--help"])).resolves.toBe(0);
    await expect(runAgentCommand(["version"])).resolves.toBe(0);
    expect(stdout).toHaveBeenCalled();
  });

  it("generates every supported completion and rejects unknown commands and shells", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    for (const shell of ["bash", "zsh", "fish"]) {
      await expect(runAgentCommand(["completion", shell])).resolves.toBe(0);
    }
    await expect(runAgentCommand(["completion", "powershell"])).rejects.toThrow("bash, zsh, or fish");
    await expect(runAgentCommand(["does-not-exist"])).resolves.toBe(1);
    expect(stdout).toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Unknown command"));
  });

  it("passes a selected session to the injected TUI boundary", async () => {
    const root = await workspace("sigma-index-tui-");
    let selected: string | undefined;
    await expect(runAgentCommand(["tui", "--workspace", root, "--session", "chosen"], {
      tuiRunner: async (options) => { selected = options.sessionId; }
    })).resolves.toBe(0);
    expect(selected).toBe("chosen");
  });
});
