import {
  BoxRenderable, CliRenderEvents, type CliRenderer, createCliRenderer, ScrollBoxRenderable, TextareaRenderable,
  TextRenderable, type KeyEvent
} from "@opentui/core";
import { createPresentationState } from "agent-presentation";
import { activityText, footerText, headerText, queuedText } from "./chrome.js";
import { matchingCommands, type TuiCommandDefinition } from "./commands.js";
import { PromptHistory } from "./history.js";
import { routeKey, type KeyRouterHost } from "./key-router.js";
import { approvalChoice, OverlayView } from "./overlay.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import { createTuiTheme, type TuiTheme } from "./theme.js";
import { TranscriptView } from "./transcript.js";
import type { SubmissionKind, TuiAppOptions, TuiSnapshot, TuiViewActions } from "./types.js";
import { WelcomeView } from "./welcome.js";
import { configureWindowsConsoleUtf8 } from "./windows-console.js";
export class TuiView implements KeyRouterHost {
  private readonly theme: TuiTheme;
  private readonly main: BoxRenderable;
  private readonly transcript: TranscriptView;
  private readonly welcome: WelcomeView;
  private readonly header: TextRenderable;
  private readonly activity: TextRenderable;
  private readonly queued: TextRenderable;
  private readonly notice: TextRenderable;
  private readonly composerBox: BoxRenderable;
  private readonly composer: TextareaRenderable;
  private readonly footer: TextRenderable;
  private readonly overlay: OverlayView;
  private readonly historyStore = new PromptHistory();
  private snapshot: TuiSnapshot;
  private commands: TuiCommandDefinition[] = [];
  private commandIndex = 0;
  private approvalIndex = 0;
  private approvalRequestId?: string;
  private approvalSubmitting = false;
  private activityExpanded = false;
  private scrolled = false;
  private readonly output?: NodeJS.WriteStream;
  private restoreConsole: () => void = () => undefined;

  static async create(options: TuiAppOptions, actions: TuiViewActions): Promise<TuiView> {
    const restoreConsole = configureWindowsConsoleUtf8(!options.stdin && !options.stdout && Boolean(process.stdout.isTTY));
    try {
      const renderer = await createCliRenderer({
        stdin: options.stdin ?? process.stdin,
        stdout: options.stdout ?? process.stdout,
        remote: Boolean(options.stdin || options.stdout),
        exitOnCtrlC: false,
        exitSignals: [],
        screenMode: "alternate-screen",
        consoleMode: "disabled",
        useMouse: true,
        targetFps: Math.max(1, Math.min(30, options.maxFps ?? 30)),
        maxFps: Math.max(1, Math.min(30, options.maxFps ?? 30))
      });
      const view = new TuiView(renderer, options, actions);
      view.restoreConsole = restoreConsole;
      return view;
    } catch (error) {
      restoreConsole();
      throw error;
    }
  }

  constructor(readonly renderer: CliRenderer, options: TuiAppOptions, private readonly actions: TuiViewActions) {
    this.output = options.stdout;
    this.snapshot = {
      workspace: options.workspace, mode: options.mode ?? "change", presentation: createPresentationState()
    };
    this.theme = createTuiTheme(Boolean(process.env.NO_COLOR || process.env.SIGMA_NO_COLOR));
    renderer.root.flexDirection = "column";
    this.main = new BoxRenderable(renderer, { id: "main", width: "100%", height: "100%", flexDirection: "column" });
    this.header = new TextRenderable(renderer, { id: "header", width: "100%", height: 1, truncate: true });
    const content = new BoxRenderable(renderer, {
      id: "content", width: "100%", flexGrow: 1, minHeight: 0
    });
    const scroll = new ScrollBoxRenderable(renderer, {
      id: "conversation", width: "100%", flexGrow: 1, minHeight: 0, scrollY: true,
      stickyScroll: true, stickyStart: "bottom", viewportCulling: true
    });
    this.transcript = new TranscriptView(renderer, scroll.content, this.theme);
    this.welcome = new WelcomeView(renderer, this.theme);
    content.add(scroll);
    content.add(this.welcome.box);
    this.activity = this.chromeText("activity", this.theme.warning);
    this.queued = this.chromeText("queued", this.theme.muted);
    this.notice = this.chromeText("notice", this.theme.warning);
    this.composerBox = new BoxRenderable(renderer, {
      id: "composer-box", width: "100%", height: 3, border: true, borderStyle: "rounded",
      paddingX: 1, ...(this.theme.accent ? { borderColor: this.theme.accent } : {})
    });
    this.composer = new TextareaRenderable(renderer, {
      id: "composer", width: "100%", height: 1, wrapMode: "word", placeholder: "Ask Sigma to do anything",
      ...(this.theme.accent ? { cursorColor: this.theme.accent } : {}),
      onContentChange: () => this.refreshComposer()
    });
    this.footer = this.chromeText("footer", this.theme.muted);
    this.composerBox.add(this.composer);
    for (const child of [this.header, content, this.activity, this.queued, this.notice, this.composerBox, this.footer]) this.main.add(child);
    this.overlay = new OverlayView(renderer, this.theme);
    renderer.root.add(this.main); renderer.root.add(this.overlay.box);
    renderer.keyInput.on("keypress", this.onKey);
    renderer.on(CliRenderEvents.RESIZE, this.onResize);
    this.output?.on("resize", this.onOutputResize);
    scroll.onMouseScroll = () => queueMicrotask(() => {
      this.scrolled = scroll.scrollTop + scroll.height < scroll.scrollHeight - 1;
      this.refreshFooter();
    });
    this.conversation = scroll;
    this.composer.focus();
    this.update(this.snapshot);
  }

  private readonly conversation: ScrollBoxRenderable;

  update(snapshot: TuiSnapshot): void {
    this.snapshot = snapshot;
    this.transcript.sync(snapshot.presentation);
    this.header.content = headerText(snapshot, this.renderer.width);
    this.welcome.update(snapshot.presentation, this.renderer.width, this.renderer.height);
    const activity = activityText(snapshot.presentation, this.activityExpanded);
    this.setChrome(this.activity, activity, this.activityExpanded ? 6 : 1, this.renderer.height >= 8);
    this.setChrome(this.queued, queuedText(snapshot.presentation), 3, this.renderer.height >= 8);
    this.setChrome(this.notice, snapshot.notice?.message ?? "", 1, this.renderer.height >= 6);
    const approvals = snapshot.presentation.approvals.filter((item) => item.status === "pending");
    if (approvals.length > 0) {
      if (this.approvalRequestId !== approvals[0].requestId) {
        this.approvalRequestId = approvals[0].requestId;
        this.approvalIndex = 0; this.approvalSubmitting = false;
      }
      this.overlay.showApproval(approvals[0], 0, approvals.length, this.approvalIndex);
      this.composer.blur();
    } else if (this.overlay.mode === "approval") {
      this.approvalSubmitting = false; this.approvalIndex = 0; this.approvalRequestId = undefined;
      this.overlay.hide(); this.composer.focus();
    }
    this.main.visible = !["approval", "help"].includes(this.overlay.mode);
    this.refreshComposer();
    this.refreshFooter();
    this.renderer.requestRender();
  }

  toggleActivity(): void {
    this.activityExpanded = !this.activityExpanded;
    this.update(this.snapshot);
  }

  destroy(): void {
    this.renderer.keyInput.off("keypress", this.onKey);
    this.renderer.off(CliRenderEvents.RESIZE, this.onResize);
    this.output?.off("resize", this.onOutputResize);
    this.theme.syntax.destroy();
    this.renderer.destroy();
    setImmediate(this.restoreConsole);
  }

  overlayMode = () => this.overlay.mode;
  composerText = () => this.composer.plainText;
  composerLine = () => ({ row: this.composer.logicalCursor.row, lines: this.composer.lineCount });
  interrupt = () => { void this.actions.interrupt(); };
  closeOverlay = () => { this.overlay.hide(); this.main.visible = true; this.composer.focus(); };
  showHelp = () => { this.overlay.showHelp(); this.main.visible = false; this.composer.blur(); };
  newline = () => this.composer.newLine();
  submit = (kind: SubmissionKind) => this.submitComposer(kind);
  scroll = (delta: number) => this.scrollContent(delta);

  history(direction: -1 | 1): void {
    const value = direction < 0 ? this.historyStore.previous(this.composer.plainText) : this.historyStore.next();
    if (value === undefined) return;
    this.composer.setText(value); this.composer.gotoBufferEnd();
  }

  approvalKey(key: KeyEvent): boolean {
    if (key.name === "up" || key.name === "down") {
      this.approvalIndex = (this.approvalIndex + (key.name === "up" ? 2 : 1)) % 3;
      this.overlay.selectApproval(this.approvalIndex); return true;
    }
    const direct = key.repeated ? undefined : approvalChoice(key);
    if (direct !== undefined) { this.approvalIndex = direct; this.confirmApproval(); return true; }
    if (!key.repeated && (key.name === "return" || key.name === "enter")) { this.confirmApproval(); return true; }
    if (key.name === "pageup" || key.name === "pagedown") { this.overlay.scrollBy(key.name === "pageup" ? -8 : 8); return true; }
    return false;
  }

  commandKey(key: KeyEvent): boolean {
    if (key.name === "escape") { this.closeOverlay(); return true; }
    if (key.name === "up" || key.name === "down") {
      this.commandIndex = (this.commandIndex + (key.name === "up" ? this.commands.length - 1 : 1)) % this.commands.length;
      this.overlay.showCommands(this.commands, this.commandIndex); return true;
    }
    if (key.name !== "tab" && key.name !== "return" && key.name !== "enter") return false;
    const selected = this.commands[this.commandIndex];
    if (!selected) return true;
    this.composer.setText(`${selected.name}${selected.acceptsArguments ? " " : ""}`); this.composer.gotoBufferEnd();
    if (!selected.acceptsArguments && key.name !== "tab") this.submitComposer("default"); else this.closeOverlay();
    return true;
  }

  private readonly onKey = (key: KeyEvent): void => { this.actions.userAction(); routeKey(this, key); };
  private readonly onResize = (): void => { this.refreshComposer(); this.update(this.snapshot); this.overlay.resize(); };
  private readonly onOutputResize = (): void => {
    const output = this.output as (NodeJS.WriteStream & { columns?: number; rows?: number }) | undefined;
    if (output?.columns && output.rows) this.renderer.resize(output.columns, output.rows);
  };

  private chromeText(id: string, color?: string): TextRenderable {
    return new TextRenderable(this.renderer, { id, width: "100%", height: 0, visible: false, truncate: true, ...(color ? { fg: color } : {}) });
  }

  private setChrome(node: TextRenderable, content: string, maximum: number, allowed: boolean): void {
    node.content = sanitizeTerminalText(content); node.visible = Boolean(content) && allowed;
    node.height = node.visible ? Math.min(maximum, content.split("\n").length) : 0;
  }

  private refreshComposer(): void {
    const maximum = this.renderer.height < 12 ? 1 : Math.max(1, Math.min(6, Math.floor(this.renderer.height / 3)));
    const height = Math.max(1, Math.min(maximum, this.composer.lineCount));
    this.composer.height = height; this.composerBox.height = height + 2;
    this.commands = matchingCommands(this.composer.plainText);
    this.commandIndex = Math.min(this.commandIndex, Math.max(0, this.commands.length - 1));
    if (this.commands.length > 0 && !["approval", "help"].includes(this.overlay.mode)) this.overlay.showCommands(this.commands, this.commandIndex);
    else if (this.overlay.mode === "commands") this.overlay.hide();
  }

  private refreshFooter(): void { this.footer.content = footerText(this.snapshot, this.scrolled); this.footer.visible = true; this.footer.height = 1; }

  private submitComposer(kind: SubmissionKind): void {
    const text = sanitizeTerminalText(this.composer.plainText).trim(); if (!text) return;
    this.historyStore.add(text); this.composer.clear(); this.closeOverlay(); this.actions.userAction();
    void this.actions.submit(text, kind);
  }

  private confirmApproval(): void {
    if (this.approvalSubmitting) return;
    const approval = this.snapshot.presentation.approvals.find((item) => item.status === "pending"); if (!approval) return;
    const decision = (["allow", "always_allow", "deny"] as const)[this.approvalIndex];
    this.approvalSubmitting = true;
    void this.actions.approve(approval.requestId, decision).finally(() => { this.approvalSubmitting = false; });
  }

  private scrollContent(delta: number): void {
    if (this.overlay.mode === "help" || this.overlay.mode === "approval") this.overlay.scrollBy(delta);
    else if (this.conversation.scrollHeight > this.conversation.height) {
      this.conversation.scrollBy(delta, "step");
      this.scrolled = delta < 0 || this.conversation.scrollTop + this.conversation.height < this.conversation.scrollHeight - 1;
    } else this.scrolled = false;
    this.refreshFooter();
  }
}
