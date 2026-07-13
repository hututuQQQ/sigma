import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
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
import type { ConfiguredRuntime } from "../packages/agent-runtime/src/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostExecutionBroker } from "./helpers/host-execution-broker.js";

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

function configuredComposition(
  runtime: RuntimeClient,
  root: string,
  close: () => Promise<void>
): ConfiguredRuntime {
  return {
    runtime: runtime as ConfiguredRuntime["runtime"],
    workspace: root,
    storeRootDir: root,
    execution: {} as ConfiguredRuntime["execution"],
    close
  };
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
    await expect(runInitCommand(["--workspace", root, "--init-profile", "ci", "--json"], { stdout: json })).resolves.toBe(0);
    expect(JSON.parse(json.text())).toMatchObject({ ok: true, profile: "ci" });
    expect(await readFile(path.join(root, ".agent", "config.toml"), "utf8")).toContain('mode = "auto"');

    const existsError = new Capture();
    await expect(runInitCommand(["--workspace", root], { stderr: existsError })).resolves.toBe(1);
    expect(existsError.text()).toContain("already exists");

    const forced = new Capture();
    await expect(runInitCommand([
      "--workspace", root, "--init-profile", "team", "--permission-mode", "deny", "--force"
    ], { stdout: forced })).resolves.toBe(0);
    expect(forced.text()).toContain("initialized");
    expect(await readFile(path.join(root, ".agent", "config.toml"), "utf8")).toContain('mode = "deny"');
  });

  it("reports invalid init options", async () => {
    const stderr = new Capture();
    await expect(runInitCommand(["--init-profile", "unknown"], { stderr })).resolves.toBe(1);
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
    await expect(runReplayCommand(["--latest", "--workspace", root], {
      stderr,
      runtimeFactoryDeps: { executionBroker: createHostExecutionBroker() }
    })).resolves.toBe(1);
    expect(stderr.text()).toContain("replay requires a session id");
  });

  it("closes an owned replay composition when replay fails", async () => {
    const root = await workspace("sigma-replay-owned-runtime-");
    const runtime = new FakeRuntime();
    const close = vi.fn(async () => undefined);
    const stderr = new Capture();
    await expect(runReplayCommand(["--latest", "--workspace", root], {
      stderr,
      createConfiguredRuntime: async () => configuredComposition(runtime, root, close)
    })).resolves.toBe(1);
    expect(stderr.text()).toContain("replay requires a session id");
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("CLI session branches", () => {
  it("closes and awaits the child process owned by a configured list runtime", async () => {
    const root = await workspace("sigma-session-owned-runtime-");
    const runtime = new FakeRuntime();
    runtime.sessions = [overview()];
    const child = spawn(process.execPath, [
      "-e",
      "process.stdin.resume(); process.stdin.on('end', () => setTimeout(() => process.exit(0), 25));"
    ], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    await once(child, "spawn");
    const childClosed = once(child, "close");
    const close = vi.fn(async () => {
      child.stdin.end();
      await childClosed;
    });
    try {
      const stdout = new Capture();
      await expect(runSessionsCommand(["--workspace", root, "--json"], {
        stdout,
        createConfiguredRuntime: async () => configuredComposition(runtime, root, close)
      })).resolves.toBe(0);
      expect(close).toHaveBeenCalledOnce();
      expect(child.exitCode).toBe(0);
      expect(JSON.parse(stdout.text()).sessions).toHaveLength(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill();
        await closed;
      }
    }
  });

  it("closes an owned session composition when a subcommand fails", async () => {
    const root = await workspace("sigma-session-owned-failure-");
    const runtime = new FakeRuntime();
    const close = vi.fn(async () => undefined);
    const stderr = new Capture();
    await expect(runSessionCommand(["show", "missing", "--workspace", root], {
      stderr,
      createConfiguredRuntime: async () => configuredComposition(runtime, root, close)
    })).resolves.toBe(1);
    expect(stderr.text()).toContain("was not found");
    expect(close).toHaveBeenCalledOnce();
  });

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
    await expect(runSessionCommand([
      "recover", "stored", "checkpoint-one", "--restore"
    ], { runtime, stdout: new Capture() })).resolves.toBe(0);
    expect(runtime.commands.at(-1)).toEqual({
      type: "checkpoint_recovery",
      sessionId: "stored",
      checkpointId: "checkpoint-one",
      decision: "restore"
    });
    await expect(runSessionCommand([
      "budget", "stored", "--max-input-tokens", "500", "--max-agent-depth", "1"
    ], { runtime, stdout: new Capture() })).resolves.toBe(0);
    expect(runtime.commands.at(-1)).toEqual({
      type: "budget_increase", sessionId: "stored", increase: { inputTokens: 500, maxDepth: 1 }
    });
    await expect(runSessionCommand([
      "waive-reviewer", "stored", "checkpoint-three", "--reason", "Reviewed directly by the operator."
    ], { runtime, stdout: new Capture() })).resolves.toBe(0);
    expect(runtime.commands.at(-1)).toEqual({
      type: "reviewer_waiver",
      sessionId: "stored",
      checkpointId: "checkpoint-three",
      reason: "Reviewed directly by the operator."
    });
    await expect(runSessionCommand([
      "waive-reviewer", "stored", "--reason", "Use the latest pending checkpoint."
    ], { runtime, stdout: new Capture() })).resolves.toBe(0);
    expect(runtime.commands.at(-1)).toEqual({
      type: "reviewer_waiver", sessionId: "stored", reason: "Use the latest pending checkpoint."
    });

    const missingRequest = new Capture();
    await expect(runSessionCommand(["approve", "stored"], { runtime, stderr: missingRequest })).resolves.toBe(1);
    expect(missingRequest.text()).toContain("requires a request id");
    const invalidRecovery = new Capture();
    await expect(runSessionCommand([
      "recover", "stored", "checkpoint-one", "--restore", "--keep"
    ], { runtime, stderr: invalidRecovery })).resolves.toBe(1);
    expect(invalidRecovery.text()).toContain("exactly one");
    const invalidBudget = new Capture();
    await expect(runSessionCommand([
      "budget", "stored", "--max-tool-calls", "-1"
    ], { runtime, stderr: invalidBudget })).resolves.toBe(1);
    expect(invalidBudget.text()).toContain("maxToolCalls");
    const invalidWaiver = new Capture();
    await expect(runSessionCommand([
      "waive-reviewer", "stored"
    ], { runtime, stderr: invalidWaiver })).resolves.toBe(1);
    expect(invalidWaiver.text()).toContain("requires --reason");
    const unknown = new Capture();
    await expect(runSessionCommand(["unknown", "stored"], { runtime, stderr: unknown })).resolves.toBe(1);
    expect(unknown.text()).toContain("Unknown session command");
  });

  it("routes active session commands through the durable owner inbox", async () => {
    const root = await workspace("sigma-session-owner-");
    const runtime = new FakeRuntime();
    const sent: RunCommand[] = [];
    const activeOwner = async () => ({
      pid: process.pid,
      instanceId: "test-owner",
      startedAt: new Date().toISOString()
    });
    const sendCommand = async (_root: string, command: RunCommand) => { sent.push(command); };

    const resume = new Capture();
    await expect(runSessionCommand(["resume", "active", "--workspace", root], {
      runtime, stdout: resume, activeSessionOwner: activeOwner
    })).resolves.toBe(0);
    expect(resume.text()).toContain(`pid=${process.pid}`);

    const cancel = new Capture();
    await expect(runSessionCommand([
      "cancel", "active", "--workspace", root, "--reason", "operator"
    ], { runtime, stdout: cancel, activeSessionOwner: activeOwner, sendSessionCommand: sendCommand })).resolves.toBe(0);
    const approval = new Capture();
    await expect(runSessionCommand([
      "approve", "active", "request-two", "--workspace", root, "--decision", "deny"
    ], { runtime, stderr: approval, activeSessionOwner: activeOwner })).resolves.toBe(1);
    expect(approval.text()).toContain("controlling TUI");

    await expect(runSessionCommand([
      "recover", "active", "checkpoint-two", "--workspace", root, "--keep"
    ], { runtime, stdout: new Capture(), activeSessionOwner: activeOwner, sendSessionCommand: sendCommand })).resolves.toBe(0);
    await expect(runSessionCommand([
      "budget", "active", "--workspace", root, "--max-model-turns", "8"
    ], { runtime, stdout: new Capture(), activeSessionOwner: activeOwner, sendSessionCommand: sendCommand })).resolves.toBe(0);
    await expect(runSessionCommand([
      "waive-reviewer", "active", "checkpoint-three", "--workspace", root,
      "--reason", "Explicit operator decision."
    ], { runtime, stdout: new Capture(), activeSessionOwner: activeOwner, sendSessionCommand: sendCommand })).resolves.toBe(0);

    expect(sent).toEqual([
      { type: "cancel", sessionId: "active", reason: "operator" },
      {
        type: "checkpoint_recovery",
        sessionId: "active",
        checkpointId: "checkpoint-two",
        decision: "keep"
      },
      { type: "budget_increase", sessionId: "active", increase: { modelTurns: 8 } },
      {
        type: "reviewer_waiver",
        sessionId: "active",
        checkpointId: "checkpoint-three",
        reason: "Explicit operator decision."
      }
    ]);

    const unknown = new Capture();
    await expect(runSessionCommand(["unknown", "active", "--workspace", root], {
      runtime,
      stderr: unknown,
      activeSessionOwner: activeOwner
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
      runtimeFactoryDeps: { executionBroker: createHostExecutionBroker() },
      tuiRunner: async (options) => { selected = options.sessionId; }
    })).resolves.toBe(0);
    expect(selected).toBe("chosen");
  });

  it("passes an injected runtime through registry session dispatch", async () => {
    const runtime = new FakeRuntime();
    runtime.sessions = [overview()];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(runAgentCommand(["sessions", "--json"], { runtime })).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("session-one"));
  });
});
