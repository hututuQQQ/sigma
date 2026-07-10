import type { AgentEventEnvelope, RunMode, RuntimeClient } from "agent-protocol";
import { projectEvent } from "agent-presentation";
import { StringDecoder } from "node:string_decoder";
import { parseApprovalInput } from "./approval-input.js";
import { backspace, composerText, insertText, moveCursor } from "./composer.js";
import { renderFrame } from "./render.js";
import { createTuiState, pendingApproval, reduceTui, type TuiState } from "./state.js";
interface TtyInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
}

interface TtyOutput extends NodeJS.WritableStream {
  columns?: number;
  rows?: number;
}

export interface TuiControllerOptions {
  runtime: RuntimeClient;
  workspace: string;
  mode?: RunMode;
  sessionId?: string;
  stdin?: TtyInput;
  stdout?: TtyOutput;
  maxFps?: number;
}

export class TuiController {
  private state: TuiState;
  private readonly input: TtyInput;
  private readonly output: TtyOutput;
  private subscription?: AsyncIterator<AgentEventEnvelope>;
  private subscriptionAbort?: AbortController;
  private subscriptionEpoch = 0;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private exitResolve?: () => void;
  private lastInterruptAt = 0;
  private active = false;
  private readonly decoder = new StringDecoder("utf8");
  private inputBuffer = "";
  private inputTail = Promise.resolve();
  private sessionReady: Promise<void> = Promise.resolve();
  constructor(private readonly options: TuiControllerOptions) {
    this.state = createTuiState(options.mode ?? "change");
    this.input = options.stdin ?? process.stdin;
    this.output = options.stdout ?? process.stdout;
  }

  async run(): Promise<void> {
    if (!this.input.isTTY || this.output.columns === undefined) throw new Error("The TUI requires an interactive terminal.");
    this.active = true;
    const exited = new Promise<void>((resolve) => { this.exitResolve = resolve; });
    try {
      this.input.setRawMode?.(true);
      this.input.resume();
      this.input.on("data", this.onData);
      this.output.on("resize", this.onResize);
      this.output.write("\u001b[?25l\u001b[?1049h\u001b[?2004h");
      const requestedSessionId = this.options.sessionId;
      this.sessionReady = requestedSessionId ? (async () => {
        await this.options.runtime.command({ type: "resume", sessionId: requestedSessionId });
        await this.attach(requestedSessionId);
      })() : this.newSession();
      await this.sessionReady;
      if (!this.state.stopped) this.scheduleRender();
      await exited;
    } finally {
      await this.cleanup();
    }
  }

  stop(): void {
    if (!this.active) return;
    this.state = reduceTui(this.state, { type: "stop" });
    this.exitResolve?.();
  }
  private readonly onResize = (): void => this.scheduleRender();
  private readonly onData = (chunk: Buffer | string): void => {
    this.inputBuffer += Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : chunk;
    this.inputTail = this.inputTail.then(() => this.drainInput()).catch((error) => {
      this.notice(error instanceof Error ? error.message : String(error));
    });
  };
  private async drainInput(): Promise<void> {
    const sequences = ["\u001b[200~", "\u001b[201~", "\u001b[5~", "\u001b[6~", "\u001b[A", "\u001b[B", "\u001b[C", "\u001b[D"];
    while (this.inputBuffer) {
      if (this.inputBuffer.startsWith("\u001b[200~")) {
        const end = this.inputBuffer.indexOf("\u001b[201~", 6);
        if (end < 0) return;
        const pasted = this.inputBuffer.slice(6, end).replace(/\r?\n/g, " ");
        this.inputBuffer = this.inputBuffer.slice(end + 6);
        this.state = reduceTui(this.state, { type: "composer", composer: insertText(this.state.composer, pasted) });
        this.scheduleRender();
        continue;
      }
      const sequence = sequences.find((item) => this.inputBuffer.startsWith(item));
      if (sequence) {
        this.inputBuffer = this.inputBuffer.slice(sequence.length);
        if (sequence !== "\u001b[201~") await this.handleInput(sequence);
        continue;
      }
      if (this.inputBuffer.startsWith("\u001b") && sequences.some((item) => item.startsWith(this.inputBuffer))) return;
      const character = [...this.inputBuffer][0];
      this.inputBuffer = this.inputBuffer.slice(character.length);
      await this.handleInput(character);
    }
  }

  private async handleInput(value: string): Promise<void> {
    if (value === "\u0003") {
      const now = Date.now();
      if (now - this.lastInterruptAt <= 1_500) {
        this.stop();
        return;
      }
      this.lastInterruptAt = now;
      if (this.state.sessionId) await this.options.runtime.command({ type: "cancel", sessionId: this.state.sessionId, reason: "Cancelled from TUI." });
      this.notice("Cancelled. Press Ctrl+C again within 1.5s to exit.");
      return;
    }
    if (value === "\r" || value === "\n") {
      await this.submitComposer();
      return;
    }
    if (value === "\u007f" || value === "\b") {
      this.state = reduceTui(this.state, { type: "composer", composer: backspace(this.state.composer) });
    } else if (value === "\u001b[D") {
      this.state = reduceTui(this.state, { type: "composer", composer: moveCursor(this.state.composer, -1) });
    } else if (value === "\u001b[C") {
      this.state = reduceTui(this.state, { type: "composer", composer: moveCursor(this.state.composer, 1) });
    } else if (value === "\u001b[A" || value === "\u001b[5~") {
      this.state = reduceTui(this.state, { type: "scroll", delta: 5, maximum: this.state.view.transcript.length * 10 });
    } else if (value === "\u001b[B" || value === "\u001b[6~") {
      this.state = reduceTui(this.state, { type: "scroll", delta: -5, maximum: this.state.view.transcript.length * 10 });
    } else if (!value.startsWith("\u001b")) {
      this.state = reduceTui(this.state, { type: "composer", composer: insertText(this.state.composer, value) });
    }
    this.scheduleRender();
  }

  private async submitComposer(): Promise<void> {
    const text = composerText(this.state.composer).trim();
    if (!text) return;
    if (!this.state.sessionId) await this.sessionReady;
    const sessionId = this.state.sessionId;
    if (!sessionId) return;
    this.state = reduceTui(this.state, { type: "submitted" });
    const approval = pendingApproval(this.state);
    const approvalDecision = approval ? parseApprovalInput(text, approval.requestId) : null;
    if (approvalDecision) {
      const { requestId, decision } = approvalDecision;
      await this.options.runtime.command({ type: "approve", sessionId, requestId, decision });
      this.scheduleRender();
      return;
    }
    if (await this.handleCommand(text)) return;
    const type = this.state.view.status === "running" || this.state.view.status === "needs_input" ? "steer" : "submit";
    await this.options.runtime.command(type === "steer"
      ? { type, sessionId, text }
      : { type, sessionId, text, mode: this.state.mode });
    this.scheduleRender();
  }

  private async handleCommand(text: string): Promise<boolean> {
    if (text === "/quit" || text === "/exit") {
      this.stop();
      return true;
    }
    if (text === "/new") {
      if (this.state.sessionId && (this.state.view.status === "running" || this.state.view.status === "needs_input")) {
        await this.options.runtime.command({ type: "cancel", sessionId: this.state.sessionId, reason: "Replaced by /new from TUI." });
      }
      await this.newSession();
      return true;
    }
    if (text.startsWith("/mode ")) {
      const mode = text.slice(6).trim();
      if (mode !== "analyze" && mode !== "change") throw new Error("Mode must be analyze or change.");
      this.state = reduceTui(this.state, { type: "mode", mode });
      this.notice(`Mode changed to ${mode}.`);
      return true;
    }
    if (text.startsWith("/followup ")) {
      await this.options.runtime.command({ type: "follow_up", sessionId: this.state.sessionId!, text: text.slice(10).trim() });
      return true;
    }
    if (text === "/activity") {
      this.state = reduceTui(this.state, { type: "toggle_activity" });
      return true;
    }
    return false;
  }

  private async newSession(): Promise<void> {
    const session = await this.options.runtime.createSession({ workspacePath: this.options.workspace, mode: this.state.mode });
    await this.attach(session.sessionId);
    this.notice("New session. Type a request and press Enter.");
  }

  private async attach(sessionId: string): Promise<void> {
    this.subscriptionEpoch += 1;
    this.subscriptionAbort?.abort();
    await this.subscription?.return?.();
    this.state = reduceTui(this.state, { type: "session", sessionId });
    const epoch = this.subscriptionEpoch;
    this.subscriptionAbort = new AbortController();
    this.subscription = this.options.runtime.subscribe(sessionId, this.subscriptionAbort.signal)[Symbol.asyncIterator]();
    void this.consume(this.subscription, epoch);
  }

  private async consume(iterator: AsyncIterator<AgentEventEnvelope>, epoch: number): Promise<void> {
    try {
      while (this.active && epoch === this.subscriptionEpoch) {
        const next = await iterator.next();
        if (next.done || epoch !== this.subscriptionEpoch) return;
        this.state = reduceTui(this.state, { type: "view", view: projectEvent(this.state.view, next.value) });
        this.scheduleRender();
      }
    } catch (error) {
      if (this.active && epoch === this.subscriptionEpoch) this.notice(error instanceof Error ? error.message : String(error));
    }
  }

  private notice(message?: string): void {
    this.state = reduceTui(this.state, { type: "notice", message });
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (!this.active || this.renderTimer) return;
    const fps = Math.max(1, Math.min(30, this.options.maxFps ?? 30));
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.output.write(renderFrame(this.state, { width: this.output.columns ?? 80, height: this.output.rows ?? 24 }));
    }, Math.ceil(1_000 / fps));
  }

  private async cleanup(): Promise<void> {
    this.active = false;
    this.subscriptionEpoch += 1;
    this.subscriptionAbort?.abort();
    if (this.renderTimer) clearTimeout(this.renderTimer);
    await this.subscription?.return?.();
    this.input.off("data", this.onData);
    this.output.off("resize", this.onResize);
    this.input.setRawMode?.(false);
    this.input.pause();
    this.output.write("\u001b[?2004l\u001b[?1049l\u001b[?25h\u001b[0m");
  }
}
