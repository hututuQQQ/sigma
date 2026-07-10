import { PassThrough } from "node:stream";
import { createTestRenderer } from "@opentui/core/testing";
import { describe, expect, it } from "vitest";
import type {
  AgentEventEnvelope, RunCommand, RunOutcome, RuntimeClient, SessionOverview, SessionRef, StartSession
} from "../packages/agent-protocol/src/index.js";
import { createPresentationState, projectEvent } from "../packages/agent-presentation/src/index.js";
import { TuiSessionController } from "../packages/agent-tui/src/components/controller.js";
import { sanitizeTerminalText } from "../packages/agent-tui/src/components/terminal-text.js";
import type { TuiSnapshot, TuiViewActions } from "../packages/agent-tui/src/components/types.js";
import { TuiView } from "../packages/agent-tui/src/components/view.js";
import { shouldShowWelcome } from "../packages/agent-tui/src/components/welcome.js";
import { configureWindowsConsoleUtf8 } from "../packages/agent-tui/src/components/windows-console.js";

function event(seq: number, type: AgentEventEnvelope["type"], payload: AgentEventEnvelope["payload"]): AgentEventEnvelope {
  return {
    schemaVersion: 2, seq, eventId: `e-${seq}`, sessionId: "session", runId: "run",
    occurredAt: new Date(seq).toISOString(), type, authority: "runtime", payload
  };
}

class FakeRuntime implements RuntimeClient {
  readonly commands: RunCommand[] = [];
  readonly released: string[] = [];
  private sessions = 0;

  constructor(readonly events: AgentEventEnvelope[] = [event(1, "session.created", {})]) {}

  async createSession(_input: StartSession): Promise<SessionRef> {
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

function snapshot(presentation = createPresentationState()): TuiSnapshot {
  return { workspace: "D:\\software\\sigma", sessionId: "session", mode: "change", presentation };
}

async function viewHarness(width = 80, height = 24) {
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true, exitOnCtrlC: false });
  const runtime = new FakeRuntime();
  const submissions: Array<{ text: string; kind: "default" | "follow_up" }> = [];
  const approvals: Array<{ requestId: string; decision: "allow" | "deny" | "always_allow" }> = [];
  let interrupts = 0;
  const actions: TuiViewActions = {
    submit: async (text, kind) => { submissions.push({ text, kind }); },
    approve: async (requestId, decision) => { approvals.push({ requestId, decision }); },
    interrupt: async () => { interrupts += 1; },
    newSession: async () => undefined,
    setMode: () => undefined,
    stop: () => undefined,
    userAction: () => undefined
  };
  const view = new TuiView(setup.renderer, { runtime, workspace: "D:\\software\\sigma" }, actions);
  await setup.flush();
  return { setup, view, submissions, approvals, interrupts: () => interrupts };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for TUI state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Sigma OpenTUI", () => {
  it("limits branded welcome art to roomy empty idle sessions", () => {
    const empty = createPresentationState();
    expect(shouldShowWelcome(empty, 80, 24)).toBe(true);
    expect(shouldShowWelcome(empty, 47, 24)).toBe(false);
    expect(shouldShowWelcome(empty, 80, 15)).toBe(false);
    expect(shouldShowWelcome({ ...empty, status: "running" }, 80, 24)).toBe(false);
    expect(shouldShowWelcome({ ...empty, transcript: [{
      id: "message", role: "user", text: "hi", streaming: false, occurredAt: "now"
    }] }, 80, 24)).toBe(false);
  });

  it("shows branded welcome art until the conversation starts", async () => {
    const empty = createPresentationState();
    const harness = await viewHarness();
    try {
      const initialFrame = harness.setup.captureCharFrame();
      const initialSpans = harness.setup.captureSpans().lines.flatMap((line) => line.spans);
      const colors = new Set(initialSpans.flatMap((span) => [span.fg, span.bg])
        .map((color) => color.toInts().slice(0, 3).join(",")));
      expect(initialFrame).toContain("█▀▀ █ █▀▀ █▀▄▀█ ▄▀█");
      expect(initialFrame).toContain("▄▄█ █ █▄█ █ ▀ █ █▀█");
      expect(initialFrame).toContain("What do you want to build?");
      expect(initialFrame).toContain("Type a task or / for commands");
      expect(colors.has("82,199,196")).toBe(true);
      expect(colors.has("255,122,131")).toBe(true);

      harness.setup.resize(52, 18);
      await harness.setup.flush();
      expect(harness.setup.captureCharFrame()).toContain(">_  Σ SIGMA");
      expect(harness.setup.captureCharFrame()).not.toContain("█▀▀ █ █▀▀");
      expect(harness.setup.captureCharFrame()).not.toContain("Type a task or / for commands");

      const active = projectEvent(empty, event(1, "user.message", { text: "Start working" }));
      harness.view.update(snapshot(active));
      await harness.setup.flush();
      expect(harness.setup.captureCharFrame()).not.toContain("What do you want to build?");
      expect(harness.setup.captureCharFrame()).toContain("Start working");
    } finally { harness.view.destroy(); }
  });

  it("uses UTF-8 while rendering on Windows and restores both console code pages", () => {
    let input = 936;
    let output = 437;
    let closes = 0;
    const restore = configureWindowsConsoleUtf8(true, "win32", () => ({
      functions: {
        GetConsoleCP: () => input,
        GetConsoleOutputCP: () => output,
        SetConsoleCP: (codePage) => { input = codePage; return 1; },
        SetConsoleOutputCP: (codePage) => { output = codePage; return 1; }
      },
      lib: { close: () => { closes += 1; } }
    }));
    expect([input, output]).toEqual([65001, 65001]);
    restore();
    restore();
    expect([input, output, closes]).toEqual([936, 437, 1]);
  });

  it("projects approvals, progress, workspace changes, compaction, and queued follow-ups", () => {
    let view = createPresentationState();
    view = projectEvent(view, event(1, "user.follow_up", { text: "later", queueId: "q1", status: "queued" }));
    view = projectEvent(view, event(2, "tool.approval_requested", {
      requestId: "a1", toolName: "write", reason: "Effects: filesystem.write",
      effects: ["filesystem.write"], arguments: { path: "a.txt", content: "hello" }
    }));
    view = projectEvent(view, event(3, "tool.progress", { callId: "call", name: "shell", message: "working", percent: 45 }));
    view = projectEvent(view, event(4, "tool.completed", {
      callId: "call", name: "shell", workspaceDelta: { added: ["a.txt"], modified: [], deleted: [] }
    }));
    view = projectEvent(view, event(5, "context.compacted", { omittedHistoryTurns: 12 }));
    view = projectEvent(view, event(6, "user.follow_up", { text: "later", queueId: "q1", status: "delivered" }));

    expect(view.queuedFollowUps).toEqual([]);
    expect(view.transcript).toMatchObject([{ id: "follow-up:q1", delivery: "follow_up", text: "later" }]);
    expect(view.approvals[0]).toMatchObject({
      effects: ["filesystem.write"], argumentPreview: expect.stringContaining('"path": "a.txt"'),
      argumentPreviewTruncated: false
    });
    expect(view.activity).toMatchObject([
      { id: "tool:call", detail: "added a.txt", status: "completed", progressPercent: 45 },
      { title: "context compacted", detail: "12 earlier history turns summarized" }
    ]);
  });

  it("bounds approval arguments and sanitizes terminal control input", () => {
    const large = "x".repeat(30_000);
    const view = projectEvent(createPresentationState(), event(1, "tool.approval_requested", {
      requestId: "a", toolName: "write", effects: [], arguments: { large }
    }));
    expect(view.approvals[0].argumentPreview.length).toBeLessThanOrEqual(16_384);
    expect(view.approvals[0].argumentPreviewTruncated).toBe(true);
    expect(sanitizeTerminalText("safe\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007\u001b[31mOWN\u0000")).toBe("safelinkOWN�");
  });

  it("renders Markdown, activity, queue state, and responsive compact layouts", async () => {
    const harness = await viewHarness();
    try {
      let presentation = createPresentationState();
      presentation = projectEvent(presentation, event(1, "user.message", { text: "Explain it" }));
      presentation = projectEvent(presentation, event(2, "model.delta", { turnId: 1, delta: "# Result\n\n- one\n- two\n\n```ts\nconst x = 1\n```" }));
      presentation = projectEvent(presentation, event(3, "tool.started", { callId: "c", name: "shell" }));
      presentation = projectEvent(presentation, event(4, "user.follow_up", { text: "check tests", queueId: "q", status: "queued" }));
      harness.view.update(snapshot(presentation));
      await harness.setup.flush();
      const frame = harness.setup.captureCharFrame();
      expect(frame).toContain("Result");
      expect(frame).toContain("const x = 1");
      expect(frame).toContain("queued follow-up");
      expect(frame).toContain("shell");

      for (const [width, height] of [[120, 40], [80, 24], [60, 12], [20, 5]] as const) {
        harness.setup.resize(width, height);
        await harness.setup.flush();
        const layout = harness.setup.captureSpans();
        const characters = harness.setup.captureCharFrame();
        expect(layout).toMatchObject({ cols: width, rows: height });
        expect(characters.split("\n")).toHaveLength(height + 1);
        expect(characters).toContain("Sigma");
        if (width >= 60) {
          const colors = new Set(layout.lines.flatMap((line) => line.spans).map((span) => span.fg.toString()));
          expect(colors.size).toBeGreaterThan(1);
        }
      }
    } finally { harness.view.destroy(); }
  });

  it("supports multiline input, follow-ups, history, and command completion", async () => {
    const harness = await viewHarness();
    try {
      await harness.setup.mockInput.typeText("first");
      harness.setup.mockInput.pressKey("j", { ctrl: true });
      await harness.setup.mockInput.typeText("second");
      harness.setup.mockInput.pressEnter();
      await harness.setup.flush();
      expect(harness.submissions).toContainEqual({ text: "first\nsecond", kind: "default" });

      harness.setup.mockInput.pressArrow("up");
      await harness.setup.flush();
      expect(harness.setup.captureCharFrame()).toContain("first");
      harness.setup.mockInput.pressEnter({ meta: true });
      expect(harness.submissions.at(-1)).toEqual({ text: "first\nsecond", kind: "follow_up" });

      await harness.setup.mockInput.pasteBracketedText("中文 🚀 e\u0301\nsecond line");
      harness.setup.mockInput.pressEnter();
      expect(harness.submissions.at(-1)).toEqual({ text: "中文 🚀 e\u0301\nsecond line", kind: "default" });

      await harness.setup.mockInput.typeText("/a");
      await harness.setup.flush();
      expect(harness.setup.captureCharFrame()).toContain("/activity");
      harness.setup.mockInput.pressTab();
      harness.setup.mockInput.pressEnter();
      expect(harness.submissions.at(-1)).toEqual({ text: "/activity", kind: "default" });
    } finally { harness.view.destroy(); }
  });

  it("shows contextual help and routes approval choices without editing the composer", async () => {
    const harness = await viewHarness();
    try {
      await harness.setup.mockInput.typeText("?");
      await harness.setup.flush();
      expect(harness.setup.captureCharFrame()).toContain("Sigma shortcuts");
      await harness.setup.mockInput.typeText("must-not-leak");
      harness.setup.mockInput.pressEscape();
      await harness.setup.flush();
      expect(harness.setup.captureCharFrame()).not.toContain("must-not-leak");

      const presentation = projectEvent(createPresentationState(), event(1, "tool.approval_requested", {
        requestId: "approval", toolName: "shell", reason: "process.spawn", effects: ["process.spawn"],
        arguments: { command: "pnpm test" }
      }));
      harness.view.update(snapshot(presentation));
      await harness.setup.mockInput.typeText("x");
      harness.setup.mockInput.pressKey("a");
      await harness.setup.flush();
      expect(harness.approvals).toEqual([{ requestId: "approval", decision: "always_allow" }]);
      expect(harness.setup.captureCharFrame()).toContain("pnpm test");
    } finally { harness.view.destroy(); }
  });

  it("honors NO_COLOR in character and style output", async () => {
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    const harness = await viewHarness();
    try {
      const welcomeSpans = harness.setup.captureSpans().lines.flatMap((line) => line.spans)
        .filter((span) => span.text.trim().length > 0);
      const sigmaColors = new Set(["95,215,255", "135,215,135", "255,215,95", "255,95,95", "138,138,138"]);
      expect(harness.setup.captureCharFrame()).toMatch(/[▀▄█]/u);
      expect(welcomeSpans.some((span) => sigmaColors.has(span.fg.toInts().slice(0, 3).join(",")))).toBe(false);

      let presentation = projectEvent(createPresentationState(), event(1, "user.message", { text: "plain user" }));
      presentation = projectEvent(presentation, event(2, "model.delta", { turnId: 1, delta: "# Plain assistant" }));
      harness.view.update(snapshot(presentation));
      await harness.setup.renderOnce();
      const visibleSpans = harness.setup.captureSpans().lines.flatMap((line) => line.spans)
        .filter((span) => span.text.trim().length > 0);
      expect(visibleSpans.some((span) => sigmaColors.has(span.fg.toInts().slice(0, 3).join(",")))).toBe(false);
      expect(harness.setup.captureCharFrame()).toContain("Plain assistant");
    } finally {
      harness.view.destroy();
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
  });

  it("routes scroll, activity, and interrupt shortcuts", async () => {
    const harness = await viewHarness();
    try {
      let presentation = createPresentationState();
      for (let index = 1; index <= 40; index += 1) {
        presentation = projectEvent(presentation, event(index, "user.message", { text: `message ${index}` }));
      }
      harness.view.update(snapshot(presentation));
      await harness.setup.flush();
      harness.setup.mockInput.pressKey("o", { ctrl: true });
      harness.setup.mockInput.pressKey("u", { ctrl: true });
      await harness.setup.mockMouse.scroll(10, 5, "up");
      harness.setup.mockInput.pressCtrlC();
      await harness.setup.flush();
      expect(harness.interrupts()).toBe(1);
      expect(harness.setup.captureCharFrame()).toContain("PgDn newest");
    } finally { harness.view.destroy(); }
  });

  it("drives runtime commands, mode changes, new sessions, and cleanup through the controller", async () => {
    const runtime = new FakeRuntime([event(1, "session.created", {}), event(2, "run.started", {})]);
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined }) as unknown as NodeJS.ReadStream;
    const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 }) as unknown as NodeJS.WriteStream;
    const snapshots: TuiSnapshot[] = [];
    let actions!: TuiViewActions;
    let activityToggles = 0;
    const controller = new TuiSessionController({ runtime, workspace: ".", stdin, stdout }, async (_options, nextActions) => {
      actions = nextActions;
      return {
        update: (next) => snapshots.push(next), showHelp: () => undefined,
        toggleActivity: () => { activityToggles += 1; }, destroy: () => undefined
      };
    });
    const running = controller.run();
    await waitUntil(() => Boolean(actions) && snapshots.some((item) => item.sessionId === "session"));
    await actions.submit("/mode analyze", "default");
    await actions.submit("inspect", "default");
    await actions.submit("later", "follow_up");
    await actions.submit("/activity", "default");
    await actions.newSession();
    await actions.interrupt();
    await actions.interrupt();
    await running;

    expect(runtime.commands).toContainEqual({ type: "steer", sessionId: "session", text: "inspect" });
    expect(runtime.commands).toContainEqual({ type: "follow_up", sessionId: "session", text: "later" });
    expect(runtime.commands).toContainEqual({ type: "cancel", sessionId: "session", reason: "Replaced by /new from TUI." });
    expect(runtime.released).toContain("session");
    expect(activityToggles).toBe(1);
  });

  it("keeps long transcripts incremental within the renderer budgets", async () => {
    const heapBefore = process.memoryUsage().heapUsed;
    let presentation = createPresentationState();
    for (let index = 1; index <= 10_000; index += 1) {
      presentation = projectEvent(presentation, event(index, "user.message", { text: `消息 ${index} 🚀` }));
    }
    expect(presentation.transcript).toHaveLength(2_000);
    const harness = await viewHarness(120, 40);
    try {
      const initialStarted = performance.now();
      harness.view.update(snapshot(presentation));
      expect(performance.now() - initialStarted).toBeLessThan(100);
      await harness.setup.flush();
      expect(harness.setup.captureCharFrame()).toContain("消息 10000");

      const next = projectEvent(presentation, event(10_001, "user.message", { text: "incremental tail" }));
      const incrementalStarted = performance.now();
      harness.view.update(snapshot(next));
      expect(performance.now() - incrementalStarted).toBeLessThan(100);
      expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(150 * 1024 * 1024);
    } finally { harness.view.destroy(); }
  });

  it("renders a bounded long streaming Markdown answer within 150 ms", async () => {
    const harness = await viewHarness(120, 40);
    try {
      const presentation = projectEvent(createPresentationState(), event(1, "model.delta", {
        turnId: 1, delta: "流式回答".repeat(40_000)
      }));
      const updateStarted = performance.now();
      harness.view.update(snapshot(presentation));
      expect(performance.now() - updateStarted).toBeLessThan(150);
      const renderStarted = performance.now();
      await harness.setup.renderOnce();
      expect(performance.now() - renderStarted).toBeLessThan(150);
      expect(harness.setup.captureCharFrame()).toContain("流式回答");
    } finally { harness.view.destroy(); }
  });
});
