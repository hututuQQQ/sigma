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

class FakeRuntime implements RuntimeClient {
  readonly commands: RunCommand[] = [];
  private sessions = 0;

  constructor(private readonly events: AgentEventEnvelope[] = [event(1, "session.created", {})]) {}

  async createSession(_input: StartSession): Promise<SessionRef> {
    this.sessions += 1;
    return { sessionId: this.sessions === 1 ? "session" : `session-${this.sessions}`, runId: "run" };
  }
  async command(command: RunCommand): Promise<void> { this.commands.push(command); }
  async *subscribe(): AsyncIterable<AgentEventEnvelope> { for (const item of this.events) yield item; }
  async waitForOutcome(): Promise<RunOutcome> { return { kind: "completed", message: "ok", evidence: [] }; }
  async listSessions(): Promise<SessionOverview[]> { return []; }
  async *sessionEvents(): AsyncIterable<AgentEventEnvelope> { /* no persisted events */ }
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
    expect(runtime.commands).toContainEqual({ type: "steer", sessionId: "session", text: "new context" });
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
