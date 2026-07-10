import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope, RunCommand, RunOutcome, RuntimeClient, SessionOverview, SessionRef, StartSession } from "../packages/agent-protocol/src/index.js";
import { createPresentationState, projectEvent } from "../packages/agent-presentation/src/index.js";
import { backspace, cellWidth, composerText, createComposer, insertText, moveCursor } from "../packages/agent-tui/src/v2/composer.js";
import { parseApprovalInput } from "../packages/agent-tui/src/v2/approval-input.js";
import { TuiController } from "../packages/agent-tui/src/v2/controller.js";
import { renderFrame, sanitizeTerminalText } from "../packages/agent-tui/src/v2/render.js";
import { createTuiState } from "../packages/agent-tui/src/v2/state.js";

function event(seq: number, type: AgentEventEnvelope["type"], payload: AgentEventEnvelope["payload"]): AgentEventEnvelope {
  return { schemaVersion: 2, seq, eventId: `e-${seq}`, sessionId: "session", runId: "run", occurredAt: new Date(seq).toISOString(), type, authority: "runtime", payload };
}

function runEvent(
  seq: number,
  runId: string,
  type: AgentEventEnvelope["type"],
  payload: AgentEventEnvelope["payload"]
): AgentEventEnvelope {
  return { ...event(seq, type, payload), runId };
}

class FakeRuntime implements RuntimeClient {
  readonly commands: RunCommand[] = [];
  readonly released: string[] = [];
  private sessions = 0;

  constructor(
    private readonly events: AgentEventEnvelope[] = [event(1, "session.created", {})],
    private readonly createGate: Promise<void> = Promise.resolve()
  ) {}

  async createSession(_input: StartSession): Promise<SessionRef> {
    await this.createGate;
    this.sessions += 1;
    return { sessionId: this.sessions === 1 ? "session" : `session-${this.sessions}`, runId: "run" };
  }
  async command(command: RunCommand): Promise<void> { this.commands.push(command); }
  async *subscribe(): AsyncIterable<AgentEventEnvelope> { for (const item of this.events) yield item; }
  async waitForOutcome(): Promise<RunOutcome> { return { kind: "completed", message: "ok", evidence: [] }; }
  async listSessions(): Promise<SessionOverview[]> { return []; }
  async *sessionEvents(): AsyncIterable<AgentEventEnvelope> { /* no persisted events */ }
  async releaseSession(sessionId: string): Promise<void> { this.released.push(sessionId); }
}

describe("Sigma v2 TUI", () => {
  it("edits by grapheme cluster across CJK, combining marks, and emoji", () => {
    let state = createComposer("你é👨‍👩‍👧‍👦");
    expect(state.graphemes).toEqual(["你", "é", "👨‍👩‍👧‍👦"]);
    state = moveCursor(state, -1);
    state = backspace(state);
    state = insertText(state, "好");
    expect(composerText(state)).toBe("你好👨‍👩‍👧‍👦");
    expect(cellWidth(composerText(state))).toBe(6);
    expect(cellWidth("🇨🇳1️⃣Ａ")).toBe(6);
  });

  it("keeps all approvals visible until each request is resolved", () => {
    let view = createPresentationState();
    view = projectEvent(view, event(1, "tool.approval_requested", { requestId: "a", toolName: "write", reason: "write" }));
    view = projectEvent(view, event(2, "tool.approval_requested", { requestId: "b", toolName: "exec", reason: "exec" }));
    view = projectEvent(view, event(3, "tool.approval_resolved", { requestId: "a", decision: "allow" }));
    expect(view.status).toBe("needs_input");
    expect(view.approvals.filter((item) => item.status === "pending").map((item) => item.requestId)).toEqual(["b"]);
    expect(parseApprovalInput("new steering context", "b")).toBeNull();
    expect(parseApprovalInput("y", "b")).toEqual({ requestId: "b", decision: "allow" });
    expect(parseApprovalInput("/approve b always", "a")).toEqual({ requestId: "b", decision: "always_allow" });
    expect(() => parseApprovalInput("/approve b maybe", "a")).toThrow("must be y, n, or always");

    view = projectEvent(view, event(4, "child.spawned", { childId: "child-one", payload: { intent: "write" } }));
    view = projectEvent(view, event(5, "child.message", { childId: "child-one", payload: { kind: "started" } }));
    view = projectEvent(view, event(6, "child.completed", { childId: "child-one", payload: { status: "completed" } }));
    expect(view.activity.find((item) => item.id === "child:child-one")).toMatchObject({ kind: "child", status: "completed" });
  });

  it("shows a typed user-input request once in the transcript", () => {
    let view = projectEvent(createPresentationState(), event(1, "run.suspended", {
      requestId: "need-target", message: "Which target should I change?"
    }));
    view = projectEvent(view, event(2, "run.suspended", {
      requestId: "need-target", message: "Which target should I change?"
    }));
    expect(view.status).toBe("needs_input");
    expect(view.transcript).toMatchObject([{
      role: "assistant", text: "Which target should I change?", streaming: false
    }]);
  });

  it("renders bounded responsive frames and virtualizes long transcripts", () => {
    const heapBefore = process.memoryUsage().heapUsed;
    let view = createPresentationState();
    for (let index = 1; index <= 10_000; index += 1) view = projectEvent(view, event(index, "user.message", { text: `消息 ${index} 🙂` }));
    expect(view.transcript).toHaveLength(2_000);
    for (const [width, height] of [[20, 5], [80, 24], [240, 80]] as const) {
      const state = { ...createTuiState(), sessionId: "session", view };
      const started = performance.now();
      const frame = renderFrame(state, { width, height });
      expect(performance.now() - started).toBeLessThan(100);
      expect(frame.split("\n")).toHaveLength(height);
      expect(frame).toContain("消息 10000");
    }
    for (let index = 0; index < 5; index += 1) renderFrame({ ...createTuiState(), sessionId: "session", view }, { width: 120, height: 40 });
    const timings = Array.from({ length: 40 }, () => {
      const started = performance.now();
      renderFrame({ ...createTuiState(), sessionId: "session", view }, { width: 120, height: 40 });
      return performance.now() - started;
    }).sort((left, right) => left - right);
    expect(timings[Math.ceil(timings.length * 0.95) - 1]).toBeLessThan(16);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(150 * 1024 * 1024);
  });

  it("renders one long streaming answer and a long composer in linear time", () => {
    const view = projectEvent(createPresentationState(), event(1, "model.delta", {
      turnId: 1,
      delta: "长回答🙂".repeat(40_000)
    }));
    const state = {
      ...createTuiState(),
      sessionId: "session",
      view,
      composer: createComposer("输入内容界".repeat(10_000))
    };
    const started = performance.now();
    const frame = renderFrame(state, { width: 120, height: 40 });
    expect(performance.now() - started).toBeLessThan(150);
    expect(frame.split("\n")).toHaveLength(40);
  });

  it("sanitizes terminal control injection and renders the approval inbox", () => {
    let view = createPresentationState();
    view = projectEvent(view, event(1, "user.message", { text: "safe\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007\u001b[31mOWN" }));
    view = projectEvent(view, event(2, "tool.approval_requested", { requestId: "request-1", toolName: "shell", reason: "process.spawn" }));
    const frame = renderFrame({ ...createTuiState(), sessionId: "session", view }, { width: 80, height: 12 });
    expect(frame).not.toContain("evil.example");
    expect(frame).not.toContain("\u001b[31mOWN");
    expect(frame).toContain("shell: process.spawn [request-1]");
    expect(sanitizeTerminalText("a\tb\u0000c")).toBe("a    b�c");
  });

  it("settles the matching model activity and reports each run failure once", () => {
    let view = createPresentationState();
    view = projectEvent(view, runEvent(1, "run-a", "model.started", { turnId: 1, model: "deepseek-v4-pro" }));
    view = projectEvent(view, runEvent(2, "run-a", "model.delta", { turnId: 1, delta: "partial" }));
    view = projectEvent(view, runEvent(3, "run-a", "model.failed", { turnId: 1, code: "bad_request", message: "first failure" }));
    view = projectEvent(view, runEvent(4, "run-a", "run.failed", { code: "bad_request", message: "first failure" }));
    view = projectEvent(view, runEvent(5, "run-b", "model.started", { turnId: 1, model: "glm-5" }));
    view = projectEvent(view, runEvent(6, "run-b", "model.failed", { turnId: 1, code: "overloaded", message: "second failure" }));
    view = projectEvent(view, runEvent(7, "run-b", "run.failed", { code: "overloaded", message: "second failure" }));

    expect(view.activity.filter((item) => item.kind === "model")).toMatchObject([
      { id: "model:run-a:1", title: "deepseek-v4-pro", detail: "bad_request: first failure", status: "failed" },
      { id: "model:run-b:1", title: "glm-5", detail: "overloaded: second failure", status: "failed" }
    ]);
    expect(view.activity.some((item) => item.detail === "Generating response")).toBe(false);
    expect(view.transcript.filter((item) => item.role === "system")).toHaveLength(2);
    expect(view.transcript.filter((item) => item.streaming)).toHaveLength(0);
  });

  it("shows a generic run failure when no model failure preceded it", () => {
    const view = projectEvent(createPresentationState(), event(1, "run.failed", {}));
    expect(view.status).toBe("failed");
    expect(view.transcript).toMatchObject([{
      id: "error:run", role: "system", text: "Run failed without an error message.", streaming: false
    }]);
    expect(view.activity).toMatchObject([{
      id: "run:run", kind: "diagnostic", title: "run failed", status: "failed"
    }]);
  });

  it("renders the full provider root cause in red with bounded, sanitized wrapping", () => {
    const rootCause = "messages[1].role: unknown variant `developer`, expected system, user, assistant, or tool";
    const failure = `deepseek stream HTTP 400: ${"request body context ".repeat(24)}${rootCause}`;
    let view = createPresentationState();
    view = projectEvent(view, event(1, "model.started", { turnId: 1, model: "deepseek-v4-pro" }));
    view = projectEvent(view, event(2, "model.delta", { turnId: 1, delta: "partial response" }));
    view = projectEvent(view, event(3, "model.failed", { turnId: 1, code: "model_error", message: `${failure}\u001b[31m` }));
    view = projectEvent(view, event(4, "run.failed", { code: "model_error", message: failure }));
    const frame = renderFrame({ ...createTuiState(), sessionId: "session", view }, { width: 80, height: 18 });

    expect(frame.split("\n")).toHaveLength(18);
    expect(frame).toContain("\u001b[38;5;203merror");
    expect(frame).toContain("messages[1].role");
    expect(frame).toContain("`developer`");
    expect(frame).not.toContain("Generating response");
    expect(frame).not.toContain("\u001b[31m\u001b[0m");
    expect(view.activity.at(-1)?.detail).toBe(`model_error: ${failure}\u001b[31m`);
    expect(view.transcript.filter((item) => item.role === "system")).toHaveLength(1);
    expect(view.transcript.some((item) => item.streaming)).toBe(false);
  });

  it("projects only diagnostics with user-meaningful detail", () => {
    let view = createPresentationState();
    view = projectEvent(view, event(1, "diagnostic", { kind: "steering.restart", turnId: 1 }));
    view = projectEvent(view, event(2, "diagnostic", { kind: "nested_instructions_loaded", items: [] }));
    view = projectEvent(view, event(3, "diagnostic", {
      kind: "provider_notice",
      diagnostics: ["retrying provider", "", 42, "root diagnostic remains visible"]
    }));
    expect(view.activity).toHaveLength(1);
    expect(view.activity[0]).toMatchObject({
      kind: "diagnostic",
      title: "provider_notice",
      detail: "retrying provider\nroot diagnostic remains visible"
    });
    const frame = renderFrame({ ...createTuiState(), view }, { width: 34, height: 8 });
    expect(frame.split("\n")).toHaveLength(8);
    expect(frame).toContain("root diagnostic remains visible");
  });

  it("decodes chunked input and always restores terminal state", async () => {
    const runtime = new FakeRuntime();
    const rawModes: boolean[] = [];
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (mode: boolean) => rawModes.push(mode) });
    const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
    let rendered = "";
    stdout.on("data", (chunk) => { rendered += chunk.toString("utf8"); });
    const controller = new TuiController({ runtime, workspace: ".", stdin, stdout, maxFps: 30 });
    const running = controller.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    stdin.write(Buffer.from("/qu"));
    stdin.write(Buffer.from("it\r"));
    await running;
    expect(rawModes).toEqual([true, false]);
    expect(rendered).toContain("\u001b[?1049h");
    expect(rendered).toContain("\u001b[?1049l");
    expect(rendered).toContain("\u001b[?2004h");
    expect(rendered).toContain("\u001b[?2004l");
  });

  it("queues an immediate submission until the initial session is ready", async () => {
    let releaseSession!: () => void;
    const sessionGate = new Promise<void>((resolve) => { releaseSession = resolve; });
    const runtime = new FakeRuntime([event(1, "session.created", {})], sessionGate);
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
    const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
    const controller = new TuiController({ runtime, workspace: ".", stdin, stdout });
    const running = controller.run();

    stdin.write("submitted before startup completes\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.commands).toEqual([]);
    releaseSession();
    for (let attempt = 0; attempt < 50 && runtime.commands.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runtime.commands).toContainEqual({
      type: "submit", sessionId: "session", text: "submitted before startup completes", mode: "change"
    });
    stdin.write("/quit\r");
    await running;
  });

  it("coalesces renders while terminal output is backpressured", async () => {
    const runtime = new FakeRuntime();
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
    const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
    const originalWrite = stdout.write.bind(stdout);
    let blockFrames = true;
    let frameWrites = 0;
    stdout.write = ((chunk: Uint8Array | string, ...args: unknown[]): boolean => {
      const value = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (value.includes("\u001b[2J")) {
        frameWrites += 1;
        if (blockFrames) return false;
      }
      return originalWrite(chunk, ...(args as Parameters<typeof originalWrite>));
    }) as typeof stdout.write;
    const controller = new TuiController({ runtime, workspace: ".", stdin, stdout, maxFps: 30 });
    const running = controller.run();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(frameWrites).toBe(1);

    for (let index = 0; index < 100; index += 1) stdin.write("x");
    stdout.emit("resize");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(frameWrites).toBe(1);

    blockFrames = false;
    stdout.emit("drain");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(frameWrites).toBe(2);
    stdin.write("\u0003\u0003");
    await running;
  });

  it("does not lose an early double interrupt while session creation is blocked", async () => {
    let releaseSession!: () => void;
    const sessionGate = new Promise<void>((resolve) => { releaseSession = resolve; });
    const runtime = new FakeRuntime([event(1, "session.created", {})], sessionGate);
    const rawModes: boolean[] = [];
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: (mode: boolean) => rawModes.push(mode)
    });
    const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
    const controller = new TuiController({ runtime, workspace: ".", stdin, stdout });
    const running = controller.run();

    stdin.write("\u0003\u0003");
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseSession();
    await running;
    expect(rawModes).toEqual([true, false]);
    expect(runtime.commands).toEqual([]);
  });

  it("routes resumed approvals without implicitly denying other input", async () => {
    const runtime = new FakeRuntime([
      event(1, "session.created", {}),
      event(2, "run.started", {}),
      event(3, "tool.approval_requested", { requestId: "approval", toolName: "write", reason: "filesystem.write" })
    ]);
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
    const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
    const controller = new TuiController({ runtime, workspace: ".", sessionId: "session", stdin, stdout });
    const running = controller.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    stdin.write("new context\r");
    stdin.write("/approve approval y\r");
    stdin.write("/quit\r");
    await running;
    expect(runtime.commands[0]).toEqual({ type: "resume", sessionId: "session" });
    expect(runtime.commands).toContainEqual({ type: "submit", sessionId: "session", text: "new context", mode: "change" });
    expect(runtime.commands).toContainEqual({ type: "approve", sessionId: "session", requestId: "approval", decision: "allow" });
  });

  it("handles paste, navigation, commands, replacement, and double interrupt", async () => {
    const runtime = new FakeRuntime([event(1, "session.created", {}), event(2, "run.started", {})]);
    const rawModes: boolean[] = [];
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (mode: boolean) => rawModes.push(mode) });
    const stdout = Object.assign(new PassThrough(), { columns: 60, rows: 12 });
    const controller = new TuiController({ runtime, workspace: ".", stdin, stdout, maxFps: 0 });
    const running = controller.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    stdin.write("\u001b[200~hello\n");
    stdin.write("world\u001b[201~\u001b[D\u001b[C\u001b[A\u001b[B\u001b[5~\u001b[6~\u007f!\r");
    stdin.write("/mode invalid\r/mode analyze\r/followup later\r/activity\r/new\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\u0003\u0003");
    await running;
    expect(runtime.commands).toContainEqual({ type: "follow_up", sessionId: "session", text: "later" });
    expect(runtime.commands).toContainEqual({ type: "cancel", sessionId: "session", reason: "Replaced by /new from TUI." });
    expect(runtime.commands.some((command) => command.type === "steer" && command.text.includes("hello"))).toBe(true);
    expect(runtime.released).toContain("session");
    expect(rawModes).toEqual([true, false]);
  });

  it("rejects non-TTY use and restores raw mode when terminal setup throws", async () => {
    const runtime = new FakeRuntime();
    const nonTty = Object.assign(new PassThrough(), { isTTY: false });
    const output = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
    await expect(new TuiController({ runtime, workspace: ".", stdin: nonTty, stdout: output }).run()).rejects.toThrow("interactive terminal");

    const rawModes: boolean[] = [];
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (mode: boolean) => rawModes.push(mode) });
    let writes = 0;
    const failingOutput = Object.assign(new PassThrough(), {
      columns: 80,
      rows: 24,
      write(chunk: unknown) {
        writes += 1;
        if (writes === 1) throw new Error("terminal setup failed");
        return PassThrough.prototype.write.call(this, chunk);
      }
    });
    await expect(new TuiController({ runtime, workspace: ".", stdin, stdout: failingOutput }).run()).rejects.toThrow("terminal setup failed");
    expect(rawModes).toEqual([true, false]);
  });
});
