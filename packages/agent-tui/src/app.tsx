import { execFile } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline";
import type { ProviderName } from "agent-ai";
import {
  redactSecretText,
  type AgentEvent,
  type AgentFinalEvidenceMode,
  type AgentHarnessValidationMode,
  type AgentRunResult,
  type AgentSkillsMode,
  type ContextMode,
  type PermissionMode,
  type PermissionRequest,
  type TokenTotals
} from "agent-core";
import { approvalPromptLines } from "./components/approval-prompt.js";
import { COMMANDS, commandSuggestions, resolveCommand } from "./components/commands.js";
import { parseDiffMode, renderDiffLines, type DiffMode } from "./components/diff-panel.js";
import {
  formatUsage,
  oneLine,
  summarizeToolArguments,
  toolArgsFromEvent,
  toolArgsObject,
  toolNameFromEvent,
  truncate
} from "./components/formatting.js";
import { usageFromEvents } from "./components/status-bar.js";
import {
  clearComposer,
  createComposerState,
  deleteBackward,
  deleteForward,
  deletePreviousWord,
  insertText,
  killToEnd,
  killToStart,
  moveCursorEnd,
  moveCursorLeft,
  moveCursorRight,
  moveCursorStart,
  recallHistory,
  rememberInput,
  setComposerText,
  yank,
  type ComposerState
} from "./composer-state.js";
import {
  activeFileMention,
  fileMentionSuggestions,
  insertFileMention,
  listWorkspaceFiles,
  type FileMentionSuggestion
} from "./file-mentions.js";
import { mergeDisabledToolsForMode, type TuiRunMode } from "./mode.js";
import { TuiPermissionController } from "./permission.js";
import { renderCommandPaletteOverlay, renderFileMentionPalette, renderFocusOverlay } from "./render/palette.js";
import { renderScreen } from "./render/screen.js";
import { streamColorEnabled, streamGlyphs } from "./render/theme.js";
import { buildTranscript, type TranscriptEntry } from "./view-model.js";
import { runSession } from "./run-session.js";
import { truncateToWidth, wrapText } from "./ui/theme.js";
import {
  listWorkspaceEntries,
  resolveLocalTerminalInput,
  resolveLocalWorkspaceInput,
  resolveWorkspaceTarget,
  type LocalTerminalInputResult,
  type WorkspaceChangeResult
} from "./workspace-command.js";

export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";
export type TuiSessionRunner = typeof runSession;

const execFileAsync = promisify(execFile);

export interface TuiAppOptions {
  workspace: string;
  provider: ProviderName;
  model?: string;
  permissionMode: PermissionMode;
  maxTurns?: number;
  maxWallTimeSec?: number;
  commandTimeoutSec?: number;
  validationMode?: AgentHarnessValidationMode;
  validationCommands?: string[];
  validationRetryLimit?: number;
  validationTimeoutSec?: number;
  precheckCommand?: string;
  precheckTimeoutSec?: number;
  postRunCleanupGlobs?: string[];
  harnessTimeoutSec?: number;
  retryMinBudgetSec?: number;
  attemptsDir?: string;
  allowedTools?: string[];
  disabledTools?: string[];
  contextMode?: ContextMode;
  repoMapMaxChars?: number;
  finalEvidenceMode?: AgentFinalEvidenceMode;
  skillsMode?: AgentSkillsMode;
  skillsMaxChars?: number;
  enableMcp?: boolean;
  mcpConfig?: string;
  traceJsonl?: string;
  sessionJsonl?: string;
  summaryJson?: string;
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

interface LocalCommandSnapshot {
  kind: "test" | "shell";
  command: string;
  result: CommandResult;
}

type FocusMode = "none" | "status" | "tokens" | "context" | "tools" | "diff" | "test" | "help";

function nowIso(): string {
  return new Date().toISOString();
}

function shellCommand(command: string): { file: string; args: string[] } {
  return process.platform === "win32"
    ? { file: "cmd.exe", args: ["/d", "/s", "/c", command] }
    : { file: "bash", args: ["-lc", command] };
}

function blockTail(value: string, max = 4000): string {
  const redacted = redactSecretText(value);
  if (redacted.length <= max) return redacted;
  return `${redacted.slice(0, 1200)}\n... truncated ...\n${redacted.slice(-Math.max(0, max - 1220))}`;
}

function listValue(value: string[] | undefined, empty = "none"): string {
  return value && value.length > 0 ? value.map((item) => redactSecretText(item)).join(", ") : empty;
}

function field(label: string, value: string | number | undefined | null, width: number): string[] {
  return wrapText(`${label}: ${value ?? "default"}`, width);
}

function commandLineFromRequest(request: PermissionRequest): string | null {
  const args = toolArgsObject(request.arguments);
  if (!args) return null;
  const command = typeof args.command === "string" ? args.command : typeof args.input === "string" ? args.input : null;
  return command ? redactSecretText(command) : null;
}

function affectedPaths(request: PermissionRequest): string[] {
  const args = toolArgsObject(request.arguments);
  if (!args) return [];
  const values = [args.path, args.file, args.files, args.expectedFiles];
  const paths: string[] = [];
  for (const value of values) {
    if (typeof value === "string") paths.push(redactSecretText(value));
    if (Array.isArray(value)) {
      paths.push(...value.filter((item): item is string => typeof item === "string").map((item) => redactSecretText(item)));
    }
  }
  return paths;
}

function latestToolsAvailable(events: AgentEvent[]): string[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const tools = events[index].metadata?.toolsAvailable;
    if (Array.isArray(tools) && tools.every((tool): tool is string => typeof tool === "string")) return tools;
  }
  return [];
}

async function runLocalShellCommand(command: string, cwd: string, timeoutSec: number): Promise<CommandResult> {
  const started = Date.now();
  const shell = shellCommand(command);
  try {
    const { stdout, stderr } = await execFileAsync(shell.file, shell.args, {
      cwd,
      timeout: timeoutSec * 1000,
      maxBuffer: 40000,
      windowsHide: true
    });
    return {
      exitCode: 0,
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      timedOut: false,
      durationMs: Date.now() - started
    };
  } catch (error) {
    const failure = error as { code?: number | string | null; signal?: string | null; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : null,
      stdout: failure.stdout ? failure.stdout.toString() : "",
      stderr: failure.stderr ? failure.stderr.toString() : error instanceof Error ? error.message : String(error),
      timedOut: failure.signal === "SIGTERM",
      durationMs: Date.now() - started
    };
  }
}

export class TuiApp {
  private readonly composer: ComposerState = createComposerState();
  private readonly permissionController = new TuiPermissionController();
  private readonly colorEnabled: boolean;
  private readonly localEntries: TranscriptEntry[] = [];
  private mode: TuiRunMode = "build";
  private running = false;
  private exitAfterRun = false;
  private events: AgentEvent[] = [];
  private result: AgentRunResult | null = null;
  private message: string | null = null;
  private focusMode: FocusMode = "none";
  private diffMode: DiffMode = "stat";
  private diffText = "";
  private localCommandSnapshot: LocalCommandSnapshot | null = null;
  private queuedInstruction: string | null = null;
  private filePaths: string[] = [];
  private paletteHidden = false;

  constructor(
    private readonly options: TuiAppOptions,
    private readonly stdin: NodeJS.ReadStream,
    private readonly stdout: NodeJS.WriteStream,
    private readonly sessionRunner: TuiSessionRunner = runSession
  ) {
    this.colorEnabled = streamColorEnabled(stdout);
  }

  async start(): Promise<void> {
    this.stdout.write(HIDE_CURSOR);
    try {
      this.filePaths = listWorkspaceFiles(this.options.workspace);
      readline.emitKeypressEvents(this.stdin);
      this.permissionController.onChange(() => this.render());
      if (this.stdin.isTTY) this.stdin.setRawMode(true);
      this.stdin.resume();
      this.stdin.on("keypress", this.handleKeypress);
      this.render();
      await new Promise<void>((resolve) => {
        this.resolveExit = resolve;
      });
    } catch (error) {
      this.stdout.write(SHOW_CURSOR);
      throw error;
    }
  }

  private resolveExit: (() => void) | null = null;

  private readonly handleKeypress = (text: string, key: readline.Key): void => {
    if (key.ctrl && key.name === "c") {
      this.stop();
      return;
    }

    const pending = this.permissionController.pending;
    if (pending) {
      this.handleApprovalKey(text, key, pending);
      return;
    }

    if (key.ctrl && key.name === "l") {
      this.clearTranscript("Cleared.");
      return;
    }
    if (key.ctrl && key.name === "d") {
      void this.toggleDiffDetail();
      return;
    }
    if (key.ctrl && key.name === "t") {
      this.toggleFocus("tools");
      return;
    }
    if (key.name === "f1" || (key.ctrl && key.name === "h")) {
      this.openFocus("help", "Help opened.");
      return;
    }
    if (key.ctrl && key.name === "a") {
      moveCursorStart(this.composer);
      this.render();
      return;
    }
    if (key.ctrl && key.name === "e") {
      moveCursorEnd(this.composer);
      this.render();
      return;
    }
    if (key.ctrl && key.name === "u") {
      killToStart(this.composer);
      this.afterComposerEdit();
      return;
    }
    if (key.ctrl && key.name === "k") {
      killToEnd(this.composer);
      this.afterComposerEdit();
      return;
    }
    if (key.ctrl && key.name === "w") {
      deletePreviousWord(this.composer);
      this.afterComposerEdit();
      return;
    }
    if (key.ctrl && key.name === "y") {
      yank(this.composer);
      this.afterComposerEdit();
      return;
    }
    if (key.ctrl && key.name === "j") {
      insertText(this.composer, "\n");
      this.afterComposerEdit();
      return;
    }
    if (key.name === "escape") {
      this.handleEscape();
      return;
    }
    if (key.name === "backspace") {
      deleteBackward(this.composer);
      this.afterComposerEdit();
      return;
    }
    if (key.name === "delete") {
      deleteForward(this.composer);
      this.afterComposerEdit();
      return;
    }
    if (key.name === "left") {
      moveCursorLeft(this.composer);
      this.render();
      return;
    }
    if (key.name === "right") {
      moveCursorRight(this.composer);
      this.render();
      return;
    }
    if (key.name === "up") {
      recallHistory(this.composer, "up");
      this.paletteHidden = false;
      this.render();
      return;
    }
    if (key.name === "down") {
      recallHistory(this.composer, "down");
      this.paletteHidden = false;
      this.render();
      return;
    }
    if (key.name === "tab") {
      if (!key.shift && this.acceptPaletteSuggestion()) return;
      this.toggleMode();
      return;
    }
    if (key.name === "return") {
      if (this.acceptFileMention()) return;
      void this.submitInput();
      return;
    }
    if (text && !key.ctrl && !key.meta && text >= " ") {
      insertText(this.composer, text);
      this.afterComposerEdit();
    }
  };

  private handleApprovalKey(text: string, key: readline.Key, pending: PermissionRequest): void {
    const normalized = key.name === "escape" ? "escape" : text.trim().toLowerCase();
    if (normalized === "y") {
      this.permissionController.respond("allow");
      return;
    }
    if (normalized === "n" || normalized === "escape") {
      this.permissionController.respond("deny");
      this.message = "Approval denied.";
      this.render();
      return;
    }
    if (normalized === "a") {
      this.permissionController.respond("always_allow");
      return;
    }
    if (normalized === "e") {
      const command = commandLineFromRequest(pending);
      this.permissionController.respond("deny");
      if (command) {
        setComposerText(this.composer, pending.toolName === "bash" ? `!${command}` : command);
        this.message = "Approval denied; command moved to the composer for editing.";
      } else {
        this.message = "Approval denied; this request has no editable command.";
      }
      this.render();
      return;
    }
    this.message = "Approval waiting: y allow, n deny, a always allow, e edit.";
    this.render();
  }

  private afterComposerEdit(): void {
    this.paletteHidden = false;
    this.render();
  }

  private activeCommandPalette(): boolean {
    return !this.paletteHidden && this.composer.text.trimStart().startsWith("/");
  }

  private currentFileSuggestions(): { mention: ReturnType<typeof activeFileMention>; suggestions: FileMentionSuggestion[] } {
    if (this.paletteHidden || this.activeCommandPalette()) return { mention: null, suggestions: [] };
    const mention = activeFileMention(this.composer.text, this.composer.cursor);
    if (!mention) return { mention: null, suggestions: [] };
    return {
      mention,
      suggestions: fileMentionSuggestions(this.filePaths, mention.prefix)
    };
  }

  private acceptPaletteSuggestion(): boolean {
    if (this.activeCommandPalette()) {
      const suggestion = commandSuggestions(this.composer.text)[0];
      if (!suggestion) return false;
      const next = suggestion.takesValue ? `${suggestion.name} ` : suggestion.name;
      setComposerText(this.composer, next);
      this.render();
      return true;
    }
    return this.acceptFileMention();
  }

  private acceptFileMention(): boolean {
    const { mention, suggestions } = this.currentFileSuggestions();
    const first = suggestions[0];
    if (!mention || !first) return false;
    const next = insertFileMention(this.composer.text, mention, first.path);
    setComposerText(this.composer, next.text, next.cursor);
    this.render();
    return true;
  }

  private handleEscape(): void {
    if ((this.activeCommandPalette() || this.currentFileSuggestions().mention) && !this.paletteHidden) {
      this.paletteHidden = true;
      this.message = "Palette closed.";
      this.render();
      return;
    }
    if (this.focusMode !== "none") {
      this.focusMode = "none";
      this.message = "Detail closed.";
      this.render();
      return;
    }
    if (this.composer.text.length > 0) {
      clearComposer(this.composer);
      this.paletteHidden = false;
      this.message = "Draft cleared.";
      this.render();
      return;
    }
    this.message = null;
    this.render();
  }

  private async submitInput(): Promise<void> {
    const value = this.composer.text.trim();
    if (!value) {
      clearComposer(this.composer);
      this.render();
      return;
    }
    rememberInput(this.composer, value);
    clearComposer(this.composer);
    this.paletteHidden = false;

    if (value.startsWith("/") || value.startsWith("!")) {
      await this.handleCommand(value);
      return;
    }
    const workspaceInput = resolveLocalWorkspaceInput(value, this.options.workspace);
    if (workspaceInput.handled) {
      this.applyWorkspaceChange(workspaceInput);
      return;
    }
    const terminalInput = resolveLocalTerminalInput(value);
    if (terminalInput.handled) {
      this.applyLocalTerminalInput(terminalInput);
      return;
    }
    if (this.running) {
      this.queuedInstruction = value;
      this.message = "Queued one follow-up task for the next run.";
      this.render();
      return;
    }
    this.localEntries.push({ kind: "user", text: value, timestamp: nowIso() });
    await this.startRun(value);
  }

  private async handleCommand(command: string): Promise<void> {
    const resolved = resolveCommand(command);
    if (!resolved) {
      this.openFocus("help", `Unknown command: ${command.split(/\s+/)[0] ?? command}`);
      return;
    }

    const name = resolved.spec.name;
    const value = resolved.value;
    if (name === "/exit") {
      if (this.running) {
        this.exitAfterRun = true;
        this.message = "Will exit after the active run finishes.";
        this.render();
      } else {
        this.stop();
      }
      return;
    }
    if (name === "/clear") {
      this.clearTranscript("Cleared.");
      return;
    }
    if (name === "/help") {
      this.openFocus("help", "Help opened.");
      return;
    }
    if (name === "/status") {
      this.openFocus("status", "Status opened.");
      return;
    }
    if (name === "/tokens") {
      this.openFocus("tokens", "Token usage opened.");
      return;
    }
    if (name === "/context") {
      this.openFocus("context", "Context opened.");
      return;
    }
    if (name === "/tools") {
      this.toggleFocus("tools");
      return;
    }
    if (name === "/mode plan" || name === "/mode build") {
      this.mode = name === "/mode plan" ? "plan" : "build";
      this.message = `Mode set to ${this.mode}.`;
      this.render();
      return;
    }
    if (name === "/model") {
      this.options.model = value || undefined;
      this.message = `Model set to ${this.options.model ?? "default"}.`;
      this.render();
      return;
    }
    if (name === "/provider") {
      if (value !== "deepseek" && value !== "glm") {
        this.message = "Provider must be deepseek or glm.";
      } else {
        this.options.provider = value;
        this.message = `Provider set to ${value}.`;
      }
      this.render();
      return;
    }
    if (name === "/permission") {
      if (value !== "ask" && value !== "yolo") {
        this.message = "Permission mode must be ask or yolo.";
      } else {
        this.options.permissionMode = value;
        this.message = `Permission mode set to ${value}.`;
      }
      this.render();
      return;
    }
    if (name === "/workspace") {
      this.applyWorkspaceChange(resolveWorkspaceTarget(this.options.workspace, value));
      return;
    }
    if (name === "/diff" || name === "/diff stat" || name === "/diff patch") {
      const requested = name === "/diff patch" ? "patch" : name === "/diff stat" ? "stat" : parseDiffMode(value);
      if (!requested) {
        this.message = "Diff mode must be stat or patch.";
        this.render();
        return;
      }
      this.diffMode = requested;
      if (name === "/diff" && !value && this.focusMode === "diff") {
        this.focusMode = "none";
        this.message = "Diff closed.";
        this.render();
        return;
      }
      this.focusMode = "diff";
      this.message = `Diff ${this.diffMode} opened.`;
      await this.refreshDiff();
      this.render();
      return;
    }
    if (name === "/test") {
      await this.runLocalCommand(value, "test");
      return;
    }
    if (name === "/shell") {
      await this.runLocalCommand(value, "shell");
      return;
    }
  }

  private applyWorkspaceChange(result: WorkspaceChangeResult): void {
    if (!result.handled) return;
    if (this.running) {
      const message = "Wait for the active run to finish before switching workspace.";
      this.localEntries.push({ kind: "system", text: message, timestamp: nowIso() });
      this.message = message;
      this.render();
      return;
    }
    if (!result.ok) {
      this.localEntries.push({ kind: "system", text: result.message, timestamp: nowIso() });
      this.message = result.message;
      this.render();
      return;
    }
    this.options.workspace = result.workspace;
    this.filePaths = listWorkspaceFiles(this.options.workspace);
    this.diffText = "";
    this.localCommandSnapshot = null;
    this.result = null;
    this.message = result.message;
    this.localEntries.push({ kind: "system", text: result.message, timestamp: nowIso() });
    this.render();
  }

  private applyLocalTerminalInput(result: LocalTerminalInputResult): void {
    if (!result.handled) return;
    if (result.action === "clear") {
      this.clearTranscript("Cleared.");
      return;
    }
    const timestamp = nowIso();
    if (result.action === "pwd") {
      const text = `workspace: ${this.options.workspace}`;
      this.localEntries.push({ kind: "system", text, timestamp });
      this.message = "Workspace printed.";
      this.render();
      return;
    }
    if (result.action === "list") {
      const listing = listWorkspaceEntries(this.options.workspace, 80);
      this.localEntries.push({ kind: "system", text: listing.join("\n"), timestamp });
      this.message = "Workspace entries listed.";
      this.render();
      return;
    }
    this.localEntries.push({ kind: "system", text: result.message, timestamp });
    this.message = result.message;
    this.render();
  }

  private clearTranscript(message: string): void {
    this.events = [];
    this.result = null;
    this.localEntries.length = 0;
    this.localCommandSnapshot = null;
    this.focusMode = "none";
    this.message = message;
    this.render();
  }

  private toggleMode(): void {
    this.mode = this.mode === "build" ? "plan" : "build";
    this.message = `Mode set to ${this.mode}.`;
    this.render();
  }

  private openFocus(mode: Exclude<FocusMode, "none">, message: string): void {
    this.focusMode = mode;
    this.message = message;
    this.render();
  }

  private toggleFocus(mode: Exclude<FocusMode, "none">): void {
    this.focusMode = this.focusMode === mode ? "none" : mode;
    this.message = this.focusMode === mode ? `${mode} opened.` : `${mode} closed.`;
    this.render();
  }

  private async toggleDiffDetail(): Promise<void> {
    if (this.focusMode === "diff") {
      this.focusMode = "none";
      this.message = "Diff closed.";
      this.render();
      return;
    }
    this.focusMode = "diff";
    this.message = "Diff opened.";
    await this.refreshDiff();
    this.render();
  }

  private async startRun(instruction: string): Promise<void> {
    this.running = true;
    this.result = null;
    this.focusMode = "none";
    this.message = "Run started.";
    this.render();
    try {
      const result = await this.sessionRunner({
        instruction,
        workspacePath: this.options.workspace,
        provider: this.options.provider,
        model: this.options.model,
        permissionMode: this.options.permissionMode,
        maxTurns: this.options.maxTurns,
        maxWallTimeSec: this.options.maxWallTimeSec,
        commandTimeoutSec: this.options.commandTimeoutSec,
        validationMode: this.options.validationMode,
        validationCommands: this.options.validationCommands,
        validationRetryLimit: this.options.validationRetryLimit,
        validationTimeoutSec: this.options.validationTimeoutSec,
        precheckCommand: this.options.precheckCommand,
        precheckTimeoutSec: this.options.precheckTimeoutSec,
        postRunCleanupGlobs: this.options.postRunCleanupGlobs,
        harnessTimeoutSec: this.options.harnessTimeoutSec,
        retryMinBudgetSec: this.options.retryMinBudgetSec,
        attemptsDir: this.options.attemptsDir,
        allowedTools: this.options.allowedTools,
        disabledTools: mergeDisabledToolsForMode(this.mode, this.options.disabledTools),
        contextMode: this.options.contextMode,
        repoMapMaxChars: this.options.repoMapMaxChars,
        finalEvidenceMode: this.options.finalEvidenceMode,
        skillsMode: this.options.skillsMode,
        skillsMaxChars: this.options.skillsMaxChars,
        enableMcp: this.options.enableMcp,
        mcpConfig: this.options.mcpConfig,
        traceJsonlPath: this.options.traceJsonl,
        sessionJsonlPath: this.options.sessionJsonl,
        summaryJsonPath: this.options.summaryJson,
        permissionController: this.permissionController,
        onEvent: (event) => {
          this.events.push(event);
          this.render();
        }
      });
      this.result = result;
      this.message = this.completionMessage(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.localEntries.push({ kind: "summary", status: "error", text: message, timestamp: nowIso() });
      this.message = `Run failed: ${message}`;
    } finally {
      this.running = false;
      const next = this.queuedInstruction;
      if (next && !this.exitAfterRun) {
        this.queuedInstruction = null;
        this.localEntries.push({ kind: "user", text: next, timestamp: nowIso() });
        this.message = "Starting queued task.";
        this.render();
        await this.startRun(next);
        return;
      }
      this.render();
      if (this.exitAfterRun) this.stop();
    }
  }

  private async refreshDiff(): Promise<void> {
    try {
      await execFileAsync("git", ["-C", this.options.workspace, "rev-parse", "--is-inside-work-tree"], {
        timeout: 3000,
        maxBuffer: 2000
      });
      const diffArgs = this.diffMode === "patch"
        ? ["-C", this.options.workspace, "diff", "--no-ext-diff", "--"]
        : ["-C", this.options.workspace, "diff", "--stat", "--"];
      const { stdout, stderr } = await execFileAsync("git", diffArgs, {
        timeout: 5000,
        maxBuffer: 64000
      });
      this.diffText = blockTail(stdout.toString() || stderr.toString(), 12000);
    } catch (error) {
      this.diffText = `Not a git repository or diff unavailable: ${redactSecretText(error instanceof Error ? error.message : String(error))}`;
    }
  }

  private completionMessage(result: AgentRunResult): string {
    if (result.status === "completed") return "Run completed.";
    if (result.status === "stopped") return `Run stopped: ${result.finishReason}.`;
    return `Run failed: ${result.lastError ?? result.finishReason}.`;
  }

  private latestUsage(): Partial<TokenTotals> | null {
    if (this.result) return this.result.usage;
    return usageFromEvents(this.events) ?? null;
  }

  private overlay(width: number, rows: number): string | undefined {
    const pending = this.permissionController.pending;
    if (pending) {
      const paths = affectedPaths(pending);
      const title = `approval required  ${pending.toolName}  ${pending.risk}`;
      const lines = [
        ...approvalPromptLines(pending, width),
        ...(paths.length > 0 ? [`affected: ${truncateToWidth(paths.join(", "), Math.max(10, width - 10))}`] : [])
      ];
      return renderFocusOverlay(title, lines, width, Math.min(10, rows), this.colorEnabled);
    }
    if (this.focusMode === "none") return undefined;
    return renderFocusOverlay(this.focusTitle(), this.focusLines(width), width, Math.min(12, rows), this.colorEnabled);
  }

  private palette(width: number, rows: number): string | undefined {
    if (this.activeCommandPalette()) {
      return renderCommandPaletteOverlay(this.composer.text, width, Math.min(10, rows), this.colorEnabled);
    }
    const { mention, suggestions } = this.currentFileSuggestions();
    if (mention) {
      return renderFileMentionPalette(mention.prefix, suggestions, width, Math.min(8, rows), this.colorEnabled);
    }
    return undefined;
  }

  private render(): void {
    const width = Math.max(40, this.stdout.columns ?? 100);
    const rows = Math.max(12, this.stdout.rows ?? 32);
    const entries = buildTranscript({
      workspacePath: this.options.workspace,
      events: this.events,
      result: this.result,
      localEntries: this.localEntries,
      pendingApproval: this.permissionController.pending
    });
    const overlay = this.overlay(width, Math.floor(rows * 0.4));
    const palette = this.palette(width, Math.floor(rows * 0.35));
    const screen = renderScreen({
      workspacePath: this.options.workspace,
      provider: this.options.provider,
      model: this.options.model,
      permissionMode: this.options.permissionMode,
      mode: this.mode,
      running: this.running,
      result: this.result,
      events: this.events,
      message: this.message,
      queuedInstruction: this.queuedInstruction,
      composer: this.composer,
      entries,
      overlay,
      palette,
      width,
      height: rows,
      color: this.colorEnabled
    });
    this.stdout.write(`${HIDE_CURSOR}\x1b[2J\x1b[H${screen}`);
  }

  private focusTitle(): string {
    if (this.focusMode === "help") return "help";
    if (this.focusMode === "tokens") return "tokens";
    if (this.focusMode === "context") return "context";
    if (this.focusMode === "tools") return "tools";
    if (this.focusMode === "diff") return `diff ${this.diffMode}`;
    if (this.focusMode === "test") return this.localCommandSnapshot?.kind ?? "test";
    return "status";
  }

  private focusLines(width: number): string[] {
    const innerWidth = Math.max(20, width - 2);
    if (this.focusMode === "help") return this.helpLines(innerWidth);
    if (this.focusMode === "tokens") return this.tokensLines(innerWidth);
    if (this.focusMode === "context") return this.contextLines(innerWidth);
    if (this.focusMode === "tools") return this.toolsLines(innerWidth);
    if (this.focusMode === "diff") return renderDiffLines(this.result, this.diffText, this.diffMode, innerWidth, 10, this.colorEnabled);
    if (this.focusMode === "test") return this.localCommandLines(innerWidth);
    return this.statusLines(innerWidth);
  }

  private statusLines(width: number): string[] {
    const result = this.result;
    const validationFailed = result?.harness
      ? [...result.harness.validation_results, ...result.harness.precheck_results].some((item) => item.exit_code !== 0)
      : false;
    const validation = result?.harness ? (validationFailed ? "failed" : "ok") : this.options.validationMode ?? "off";
    return [
      ...field("state", this.running ? "running" : result?.status ?? "idle", width),
      ...field("workspace", redactSecretText(this.options.workspace), width),
      ...field("provider/model", `${this.options.provider}/${this.options.model ?? result?.model ?? "default"}`, width),
      ...field("permission", this.options.permissionMode, width),
      ...field("mode", this.mode, width),
      ...field("plan disables", this.mode === "plan" ? "write, edit, apply_patch, bash, shell_session, service" : "off", width),
      ...field("validation", validation, width),
      ...field("final evidence", result?.finalGate?.status ?? this.options.finalEvidenceMode ?? "off", width),
      ...field("mcp", result?.mcpServers ? `${result.mcpServers.reduce((sum, server) => sum + server.tools_loaded, 0)} tools` : this.options.enableMcp ? "enabled" : "off", width),
      ...field("allowed tools", listValue(this.options.allowedTools), width),
      ...field("disabled tools", listValue(mergeDisabledToolsForMode(this.mode, this.options.disabledTools)), width),
      ...field("queued", this.queuedInstruction ? truncate(oneLine(redactSecretText(this.queuedInstruction)), 120) : "none", width),
      ...field("last result", result ? `${result.status} ${result.finishReason}` : "none", width)
    ];
  }

  private tokensLines(width: number): string[] {
    const usage = this.latestUsage();
    if (!usage) return ["No usage yet.", "Usage appears after the first model turn."];
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const cache = usage.cacheTokens ?? 0;
    const total = usage.totalTokens ?? input + output;
    return [
      ...field("input", input, width),
      ...field("output", output, width),
      ...field("cache", cache, width),
      ...field("total", total, width),
      `compact: ${formatUsage(usage)}`
    ];
  }

  private contextLines(width: number): string[] {
    const sources = this.result?.projectInstructionSources ?? [];
    const skills = this.result?.selectedSkills ?? [];
    const mcpServers = this.result?.mcpServers ?? [];
    return [
      ...field("context mode", this.options.contextMode ?? this.result?.contextMode ?? "repo-map", width),
      ...field("repo map max chars", this.options.repoMapMaxChars, width),
      ...field("repo map chars", this.result?.repoMapChars ?? "unknown", width),
      ...field("project instructions", sources.length > 0 ? sources.map((source) => redactSecretText(source)).join(", ") : "not loaded yet", width),
      ...field("skills mode", this.options.skillsMode ?? "auto", width),
      ...field("selected skills", skills.length > 0 ? skills.map((skill) => `${skill.name}:${skill.source}`).join(", ") : "none yet", width),
      ...field("mcp", mcpServers.length > 0 ? mcpServers.map((server) => `${server.name}:${server.enabled ? "on" : "off"}:${server.tools_loaded}`).join(", ") : this.options.enableMcp ? "enabled, not loaded yet" : "off", width)
    ];
  }

  private toolsLines(width: number): string[] {
    const toolEnds = this.events.filter((event) => event.type === "tool_end").slice(-8);
    const startsById = new Map(this.events.filter((event) => event.type === "tool_start").map((event) => [event.id, event]));
    const available = this.result?.toolsAvailable ?? latestToolsAvailable(this.events);
    const lines = [
      `available: ${available.length > 0 ? available.join(", ") : "after first run"}`,
      "",
      "recent calls"
    ];
    if (toolEnds.length === 0) lines.push("No tool calls yet.");
    for (const event of toolEnds) {
      const result = event.metadata?.result as { ok?: boolean; content?: string; metadata?: Record<string, unknown> } | undefined;
      const start = event.parentId ? startsById.get(event.parentId) : undefined;
      const name = typeof event.metadata?.toolName === "string" ? event.metadata.toolName : toolNameFromEvent(start ?? event);
      const detail = start ? summarizeToolArguments(name, toolArgsFromEvent(start)) : "";
      const duration = typeof result?.metadata?.durationMs === "number" ? `${result.metadata.durationMs}ms` : "";
      const tail = result?.content ? truncate(oneLine(redactSecretText(result.content)), 70) : "";
      lines.push(truncateToWidth(`${name} ${result?.ok ? "ok" : "failed"}  ${[duration, detail, tail].filter(Boolean).join("  ")}`, width));
    }
    return lines;
  }

  private helpLines(width: number): string[] {
    const g = streamGlyphs();
    const commandLines = COMMANDS.map((command) => {
      const aliases = command.aliases.length > 0 ? ` ${command.aliases.join(", ")}` : "";
      return truncateToWidth(`${command.usage.padEnd(20)}${aliases.padEnd(10)}${command.description}`, width);
    });
    return [
      `${g.sigma} Sigma`,
      `  sum the repo ${g.separator} ship the patch`,
      "",
      "Shortcuts",
      "Enter send   Ctrl+J newline   Tab plan/build   Esc close/clear   Ctrl+L redraw/clear",
      "Left/Right move cursor   Ctrl+A/E start/end   Ctrl+U/K kill   Ctrl+W delete word   Ctrl+Y yank",
      "Ctrl+D diff   Ctrl+T tools   F1 help   @ file mention   !command shell",
      "Local: cd <path>, pwd, ls/dir, clear/cls",
      "",
      "Commands",
      ...commandLines
    ];
  }

  private localCommandLines(width: number): string[] {
    if (!this.localCommandSnapshot) return ["No local command has been run yet.", "Use /test <command> or !<command>."];
    const { command, result, kind } = this.localCommandSnapshot;
    const stdout = blockTail(result.stdout || "(empty)", 1400).split(/\r?\n/);
    const stderr = blockTail(result.stderr || "(empty)", 1400).split(/\r?\n/);
    return [
      ...field("kind", kind, width),
      ...field("command", truncate(oneLine(redactSecretText(command)), 160), width),
      ...field("exit", `${result.exitCode ?? "signal"}${result.timedOut ? " timed out" : ""}`, width),
      ...field("duration", `${result.durationMs}ms`, width),
      "",
      "stdout",
      ...stdout.map((line) => truncateToWidth(`  ${line}`, width)),
      "",
      "stderr",
      ...stderr.map((line) => truncateToWidth(`  ${line}`, width))
    ];
  }

  private async runLocalCommand(command: string, kind: "test" | "shell"): Promise<void> {
    if (!command) {
      this.openFocus("help", `Usage: /${kind} <command>`);
      return;
    }
    if (this.running) {
      this.message = `Wait for the active run to finish before /${kind}.`;
      this.render();
      return;
    }

    if (this.options.permissionMode === "ask") {
      const decision = await this.permissionController.decide({
        toolName: "bash",
        arguments: { command },
        risk: "execute",
        reason: kind === "test" ? "Run local validation command" : "Run local shell command",
        workspacePath: this.options.workspace
      });
      if (decision === "deny") {
        this.message = `${kind} command denied.`;
        this.render();
        return;
      }
    }

    const entry: TranscriptEntry = {
      kind: "test",
      command,
      status: "running",
      summary: kind,
      timestamp: nowIso()
    };
    this.localEntries.push(entry);
    this.focusMode = "test";
    this.message = `Running ${kind} command.`;
    this.render();
    const result = await runLocalShellCommand(command, this.options.workspace, this.options.commandTimeoutSec ?? 60);
    this.localCommandSnapshot = { kind, command, result };
    entry.status = result.exitCode === 0 && !result.timedOut ? "ok" : "failed";
    entry.summary = `${kind} exit ${result.exitCode ?? "signal"}`;
    entry.durationMs = result.durationMs;
    this.message = entry.status === "ok" ? `${kind} command passed.` : `${kind} command finished with issues.`;
    this.render();
  }

  private stop(): void {
    this.stdin.off("keypress", this.handleKeypress);
    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdout.write(`${SHOW_CURSOR}\x1b[2J\x1b[H`);
    this.resolveExit?.();
  }
}

export async function runTuiApp(options: TuiAppOptions): Promise<void> {
  const app = new TuiApp(options, process.stdin, process.stdout);
  try {
    await app.start();
  } finally {
    process.stdout.write(SHOW_CURSOR);
  }
}
