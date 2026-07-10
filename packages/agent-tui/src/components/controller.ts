import { createPresentationState, projectEvent } from "agent-presentation";
import type { AgentEventEnvelope, RunMode } from "agent-protocol";
import { parseTuiCommand } from "./commands.js";
import { TuiView } from "./view.js";
import type { SubmissionKind, TuiAppOptions, TuiSnapshot, TuiViewActions } from "./types.js";

interface ControllerView {
  update(snapshot: TuiSnapshot): void;
  showHelp(): void;
  toggleActivity(): void;
  destroy(): void;
}

type ViewFactory = (options: TuiAppOptions, actions: TuiViewActions) => Promise<ControllerView>;

function ffiReady(): boolean {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const supported = major > 26 || major === 26 && minor >= 4;
  return supported && (process.execArgv.includes("--experimental-ffi")
    || (process.env.NODE_OPTIONS ?? "").split(/\s+/u).includes("--experimental-ffi"));
}

export class TuiSessionController {
  private mode: RunMode;
  private presentation = createPresentationState();
  private sessionId?: string;
  private view?: ControllerView;
  private subscription?: AsyncIterator<AgentEventEnvelope>;
  private subscriptionAbort?: AbortController;
  private subscriptionEpoch = 0;
  private active = false;
  private exitResolve?: () => void;
  private lastInterruptAt = 0;
  private noticeTimer?: ReturnType<typeof setTimeout>;
  private noticeState?: { message: string; error: boolean };
  private sessionReady: Promise<void> = Promise.resolve();

  constructor(private readonly options: TuiAppOptions, private readonly viewFactory: ViewFactory = TuiView.create) {
    this.mode = options.mode ?? "change";
  }

  async run(): Promise<void> {
    if (!ffiReady()) throw new Error("Sigma TUI requires Node 26.4+ started with --experimental-ffi.");
    const input = this.options.stdin ?? process.stdin;
    const output = this.options.stdout ?? process.stdout;
    if (!input.isTTY || output.columns === undefined) throw new Error("The TUI requires an interactive terminal.");
    this.active = true;
    const exited = new Promise<void>((resolve) => { this.exitResolve = resolve; });
    try {
      this.view = await this.viewFactory(this.options, this.actions());
      this.refresh();
      const startup = this.beginSessionTransition(async () => {
        if (this.options.sessionId) await this.resume(this.options.sessionId);
        else await this.newSession();
      });
      await Promise.race([startup, exited]);
      if (this.active) await exited;
    } finally {
      await this.cleanup();
    }
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.exitResolve?.();
  }

  private actions(): TuiViewActions {
    return {
      submit: async (text, kind) => await this.protect(async () => await this.submit(text, kind)),
      approve: async (requestId, decision) => await this.protect(async () => {
        if (!this.sessionId) return;
        await this.options.runtime.command({ type: "approve", sessionId: this.sessionId, requestId, decision });
      }),
      interrupt: async () => await this.protect(async () => await this.interrupt()),
      newSession: async () => await this.protect(async () => await this.beginSessionTransition(async () => await this.newSession())),
      setMode: (mode) => { this.mode = mode; this.notice(`Mode changed to ${mode}.`); this.refresh(); },
      stop: () => this.stop(),
      userAction: () => { if (this.noticeState?.error) this.notice(); }
    };
  }

  private async protect(operation: () => Promise<void>): Promise<void> {
    try { await operation(); }
    catch (error) { this.notice(error instanceof Error ? error.message : String(error), true); }
  }

  private async submit(text: string, kind: SubmissionKind): Promise<void> {
    this.notice();
    await this.sessionReady;
    if (!this.active || !this.sessionId) return;
    if (await this.command(text)) return;
    if (kind === "follow_up") {
      await this.options.runtime.command({ type: "follow_up", sessionId: this.sessionId, text });
      this.notice("Follow-up queued.");
      return;
    }
    if (this.presentation.status === "running" || this.presentation.status === "needs_input") {
      await this.options.runtime.command({ type: "steer", sessionId: this.sessionId, text });
    } else {
      await this.options.runtime.command({ type: "submit", sessionId: this.sessionId, text, mode: this.mode });
    }
  }

  private async command(text: string): Promise<boolean> {
    if (!text.startsWith("/")) return false;
    const parsed = parseTuiCommand(text);
    if (!parsed) throw new Error(`Unknown command: ${text.split(/\s/u, 1)[0]}. Type /help for available commands.`);
    const { action } = parsed.command;
    const { argument } = parsed;
    if (action === "quit") { this.stop(); return true; }
    if (action === "new") {
      await this.beginSessionTransition(async () => await this.newSession());
      return true;
    }
    if (action === "help") { this.view?.showHelp(); return true; }
    if (action === "activity") { this.view?.toggleActivity(); return true; }
    if (action === "mode") {
      if (argument !== "analyze" && argument !== "change") throw new Error("Mode must be analyze or change.");
      this.mode = argument; this.notice(`Mode changed to ${argument}.`); this.refresh(); return true;
    }
    if (action === "followup") {
      if (!argument) throw new Error("/followup requires a message.");
      await this.options.runtime.command({ type: "follow_up", sessionId: this.sessionId!, text: argument });
      this.notice("Follow-up queued."); return true;
    }
    return false;
  }

  private async interrupt(): Promise<void> {
    const now = Date.now();
    if (now - this.lastInterruptAt <= 1_500) { this.stop(); return; }
    this.lastInterruptAt = now;
    if (this.sessionId && ["running", "needs_input"].includes(this.presentation.status)) {
      await this.options.runtime.command({ type: "cancel", sessionId: this.sessionId, reason: "Cancelled from TUI." });
    }
    this.notice("Cancelled. Press Ctrl+C again within 1.5s to exit.");
  }

  private async newSession(): Promise<void> {
    if (!this.active) return;
    if (this.sessionId && ["running", "needs_input"].includes(this.presentation.status)) {
      await this.options.runtime.command({ type: "cancel", sessionId: this.sessionId, reason: "Replaced by /new from TUI." });
    }
    const session = await this.options.runtime.createSession({ workspacePath: this.options.workspace, mode: this.mode });
    if (!this.active) {
      await this.release(session.sessionId);
      return;
    }
    await this.attach(session.sessionId);
    if (this.active) this.notice("New session. Type a request and press Enter.");
  }

  private async resume(sessionId: string): Promise<void> {
    if (!this.active) return;
    await this.options.runtime.command({ type: "resume", sessionId });
    if (!this.active) {
      await this.release(sessionId);
      return;
    }
    await this.attach(sessionId);
  }

  private beginSessionTransition(operation: () => Promise<void>): Promise<void> {
    const transition = this.sessionReady.catch(() => undefined).then(operation);
    this.sessionReady = transition;
    return transition;
  }

  private async release(sessionId: string): Promise<void> {
    try { await this.options.runtime.releaseSession?.(sessionId); } catch { /* cleanup is best effort */ }
  }

  private async attach(sessionId: string): Promise<void> {
    const previous = this.sessionId;
    this.subscriptionEpoch += 1;
    this.subscriptionAbort?.abort();
    await this.subscription?.return?.();
    if (!this.active) {
      if (previous !== sessionId) await this.release(sessionId);
      return;
    }
    if (previous && previous !== sessionId) await this.options.runtime.releaseSession?.(previous);
    this.sessionId = sessionId;
    this.presentation = createPresentationState();
    this.subscriptionAbort = new AbortController();
    const epoch = this.subscriptionEpoch;
    this.subscription = this.options.runtime.subscribe(sessionId, this.subscriptionAbort.signal)[Symbol.asyncIterator]();
    this.refresh();
    void this.consume(this.subscription, epoch);
  }

  private async consume(iterator: AsyncIterator<AgentEventEnvelope>, epoch: number): Promise<void> {
    try {
      while (this.active && epoch === this.subscriptionEpoch) {
        const next = await iterator.next();
        if (next.done || epoch !== this.subscriptionEpoch) return;
        this.presentation = projectEvent(this.presentation, next.value);
        this.refresh();
      }
    } catch (error) {
      if (this.active && epoch === this.subscriptionEpoch) this.notice(error instanceof Error ? error.message : String(error), true);
    }
  }

  private notice(message?: string, error = false): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = undefined;
    this.noticeState = message ? { message, error } : undefined;
    if (message && !error) this.noticeTimer = setTimeout(() => { this.noticeState = undefined; this.refresh(); }, 3_000);
    this.refresh();
  }

  private refresh(): void {
    this.view?.update({
      workspace: this.options.workspace, sessionId: this.sessionId, mode: this.mode,
      presentation: this.presentation, ...(this.noticeState ? { notice: this.noticeState } : {})
    });
  }

  private async cleanup(): Promise<void> {
    const sessionId = this.sessionId;
    this.active = false; this.subscriptionEpoch += 1; this.subscriptionAbort?.abort();
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    const settle = async (operation: (() => Promise<unknown>) | undefined): Promise<void> => {
      if (!operation) return;
      try { await operation(); } catch { /* terminal restoration must continue */ }
    };
    try {
      await settle(this.subscription?.return ? async () => await this.subscription!.return!() : undefined);
      if (sessionId && ["running", "needs_input"].includes(this.presentation.status)) {
        await settle(async () => await this.options.runtime.command({ type: "cancel", sessionId, reason: "TUI closed." }));
      }
      if (sessionId && this.options.runtime.releaseSession) {
        await settle(async () => await this.options.runtime.releaseSession!(sessionId));
      }
    } finally {
      this.view?.destroy();
    }
  }
}
