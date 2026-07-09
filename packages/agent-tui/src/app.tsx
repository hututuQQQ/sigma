import { execFile } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline";
import path from "node:path";
import type { ProviderName } from "agent-ai";
import {
  defaultSessionRootDir,
  redactSecretText,
  type AgentEvent,
  type AgentFinalEvidenceMode,
  type AgentHarnessValidationMode,
  type AgentRunResult,
  type AgentSkillsMode,
  type CompactionFallbackMode,
  type CompactionMode,
  type ContextMode,
  type LoopGuardMode,
  type MemoryScope,
  type ModelContextLimits,
  type PermissionMode,
  type PermissionRequest,
  type PermissionRule,
  type SandboxConfig,
  type TokenTotals,
  buildResumeInstruction,
  listSessions,
  loadSessionMeta,
  loadSessionResumeContext,
  readSessionEventsText,
  searchSessions,
  truncateMiddle
} from "agent-core";
import { approvalPromptLines } from "./components/approval-prompt.js";
import { COMMANDS, commandSuggestions, resolveCommand } from "./components/commands.js";
import { parseDiffMode, renderDiffLines, type DiffMode } from "./components/diff-panel.js";
import {
  formatUsage,
  oneLine,
  toolArgsObject,
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
  insertFileMentions,
  listWorkspaceFiles,
  type FileMentionSuggestion
} from "./file-mentions.js";
import { mergeDisabledToolsForMode, type TuiRunMode } from "./mode.js";
import { TuiPermissionController } from "./permission.js";
import { renderCommandPaletteOverlay, renderFileMentionPalette, renderFocusOverlay } from "./render/palette.js";
import { renderScreen } from "./render/screen.js";
import { streamColorEnabled } from "./render/theme.js";
import { buildTuiRunState, type TuiRunState } from "./run-state.js";
import { sigmaTagline, sigmaWelcome } from "./ui/brand.js";
import { buildActivity, buildTranscript, type ActivityItem, type TranscriptEntry } from "./view-model.js";
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
export const ENTER_ALT_SCREEN = "\x1b[?1049h";
export const EXIT_ALT_SCREEN = "\x1b[?1049l";
export const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
export const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";
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
  sandbox?: SandboxConfig;
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
  permissionRules?: PermissionRule[];
  loopGuardMode?: LoopGuardMode;
  memoryScopes?: MemoryScope[];
  contextMode?: ContextMode;
  repoMapMaxChars?: number;
  modelContextLimits?: ModelContextLimits;
  maxMessageHistoryChars?: number;
  messageHistoryRetain?: number;
  compactionSummaryChars?: number;
  compactionMode?: CompactionMode;
  compactionModel?: string;
  compactionProvider?: ProviderName;
  compactionMaxInputChars?: number;
  compactionMaxOutputChars?: number;
  compactionTimeoutSec?: number;
  compactionFallback?: CompactionFallbackMode;
  finalEvidenceMode?: AgentFinalEvidenceMode;
  skillsMode?: AgentSkillsMode;
  skillsMaxChars?: number;
  subagentsEnabled?: boolean;
  subagentBackgroundEnabled?: boolean;
  subagentHeartbeatTimeoutSec?: number;
  subagentMaxTurns?: number;
  subagentMaxOutputChars?: number;
  reviewAntiGaming?: boolean;
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

type FocusMode =
  | "none"
  | "status"
  | "settings"
  | "permissions"
  | "jobs"
  | "artifacts"
  | "tokens"
  | "context"
  | "tools"
  | "diff"
  | "test"
  | "help";

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

function redactedField(label: string, value: string | number | undefined | null, width: number): string[] {
  return field(label, typeof value === "string" ? redactSecretText(value) : value, width);
}

function middleTruncateOneLine(value: string, maxChars: number): string {
  const text = oneLine(redactSecretText(value));
  if (text.length <= maxChars) return text;
  const marker = " ... ";
  if (maxChars <= marker.length + 2) return truncateToWidth(text, maxChars);
  const remaining = maxChars - marker.length;
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return `${text.slice(0, head)}${marker}${text.slice(Math.max(0, text.length - tail))}`;
}

function compactRedactedField(label: string, value: string | number | undefined | null, width: number): string[] {
  if (typeof value !== "string") return field(label, value, width);
  const prefix = `${label}: `;
  const available = Math.max(8, width - prefix.length);
  return [truncateToWidth(`${prefix}${middleTruncateOneLine(value, available)}`, width)];
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

function sessionArtifactPaths(workspacePath: string, result: AgentRunResult | null, options: TuiAppOptions): Record<string, string> {
  if (!result?.sessionId) {
    return {
      manifest: "after first run",
      meta: "after first run",
      summary: options.summaryJson ?? "workspace .agent/summary.json",
      events: "after first run",
      checkpoints: "after first run",
      trace: options.traceJsonl ?? "workspace .agent/trace.jsonl",
      sessionJsonl: options.sessionJsonl ?? "workspace .agent/session.jsonl",
      runSummary: options.summaryJson ?? "workspace .agent/summary.json",
      attempts: options.attemptsDir ?? "not configured"
    };
  }
  const sessionDir = path.join(defaultSessionRootDir(workspacePath), result.sessionId);
  return {
    manifest: path.join(sessionDir, "artifacts.json"),
    meta: path.join(sessionDir, "meta.json"),
    summary: path.join(sessionDir, "summary.json"),
    events: path.join(sessionDir, "events.jsonl"),
    checkpoints: path.join(sessionDir, "checkpoints"),
    trace: options.traceJsonl ?? path.join(workspacePath, ".agent", "trace.jsonl"),
    sessionJsonl: options.sessionJsonl ?? path.join(workspacePath, ".agent", "session.jsonl"),
    runSummary: options.summaryJson ?? path.join(workspacePath, ".agent", "summary.json"),
    attempts: options.attemptsDir ?? "not configured"
  };
}

function countFailedExit(results: Array<{ exit_code?: unknown }>): number {
  return results.filter((item) => item.exit_code !== 0).length;
}

function compactCheckSummary(total: number, failed: number): string {
  if (total === 0) return "none";
  return `${total - failed}/${total} passed${failed > 0 ? ` (${failed} failed)` : ""}`;
}

function validationSummary(result: AgentRunResult | null): string {
  const validation = result?.harness?.validation_results ?? [];
  return compactCheckSummary(validation.length, countFailedExit(validation));
}

function precheckSummary(result: AgentRunResult | null): string {
  const precheck = result?.harness?.precheck_results ?? [];
  return compactCheckSummary(precheck.length, countFailedExit(precheck));
}

function activityLine(item: ActivityItem, width: number): string {
  const duration = typeof item.durationMs === "number" ? `${item.durationMs}ms` : "";
  return truncateToWidth([
    item.kind,
    item.status,
    item.label,
    duration,
    item.detail
  ].filter(Boolean).join("  "), width);
}

function sandboxSummary(sandbox: SandboxConfig | undefined): string {
  if (!sandbox) return "default";
  const network = typeof sandbox.network === "string" ? sandbox.network : sandbox.network?.mode;
  const backend = sandbox.backend && sandbox.backend !== "auto" ? `/${sandbox.backend}` : "";
  const required = sandbox.required ? " required" : "";
  return `${sandbox.mode ?? "workspace-write"}${backend}${network ? `:${network}` : ""}${required}`;
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
  private cancelling = false;
  private abortController: AbortController | null = null;
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
  private selectedFileMentions = new Set<string>();
  private paletteHidden = false;
  private workbenchOpen = false;
  private changePromptDismissed = false;
  private transcriptScrollOffset = 0;
  private pasteMode = false;
  private pasteBuffer = "";

  constructor(
    private readonly options: TuiAppOptions,
    private readonly stdin: NodeJS.ReadStream,
    private readonly stdout: NodeJS.WriteStream,
    private readonly sessionRunner: TuiSessionRunner = runSession
  ) {
    this.colorEnabled = streamColorEnabled(stdout);
  }

  async start(): Promise<void> {
    this.stdout.write(`${ENTER_ALT_SCREEN}${ENABLE_BRACKETED_PASTE}${HIDE_CURSOR}`);
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
      this.stdout.write(`${SHOW_CURSOR}${DISABLE_BRACKETED_PASTE}${EXIT_ALT_SCREEN}`);
      throw error;
    }
  }

  private resolveExit: (() => void) | null = null;

  private readonly handleKeypress = (text: string, key: readline.Key): void => {
    if (this.handlePasteKeypress(text, key)) return;

    if (key.ctrl && key.name === "c") {
      if (this.running && !this.cancelling) {
        this.cancelling = true;
        this.abortController?.abort();
        this.message = "Cancelling active run.";
        this.render();
        return;
      }
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
    if (key.name === "enter") {
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
    if (key.name === "pageup") {
      this.adjustTranscriptScroll(Math.max(6, Math.floor((this.stdout.rows ?? 24) * 0.5)));
      return;
    }
    if (key.name === "pagedown") {
      this.adjustTranscriptScroll(-Math.max(6, Math.floor((this.stdout.rows ?? 24) * 0.5)));
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
      if (key.shift) {
        this.toggleMode();
        return;
      }
      void this.toggleWorkbench();
      return;
    }
    if (key.name === "return") {
      if (this.acceptFileMention()) return;
      if (this.handleChangePromptKey("return")) return;
      void this.submitInput();
      return;
    }
    if (key.name === "space" && this.toggleFileMentionSelection()) return;
    if (!key.ctrl && !key.meta && text.toLowerCase() === "d" && this.handleChangePromptKey("d")) return;
    if (text && !key.ctrl && !key.meta && text >= " ") {
      insertText(this.composer, text);
      this.afterComposerEdit();
    }
  };

  private handlePasteKeypress(text: string, key: readline.Key): boolean {
    if (key.name === "paste-start") {
      this.pasteMode = true;
      this.pasteBuffer = "";
      return true;
    }
    if (!this.pasteMode) return false;
    if (key.name === "paste-end") {
      const normalized = this.pasteBuffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      this.pasteMode = false;
      this.pasteBuffer = "";
      if (normalized.length > 0) {
        insertText(this.composer, normalized);
        this.afterComposerEdit();
      }
      return true;
    }
    if (typeof text === "string" && text.length > 0) {
      this.pasteBuffer += text;
    }
    return true;
  }

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
    const selected = [...this.selectedFileMentions];
    const next = selected.length > 0
      ? insertFileMentions(this.composer.text, mention, selected)
      : insertFileMention(this.composer.text, mention, first.path);
    this.selectedFileMentions.clear();
    setComposerText(this.composer, next.text, next.cursor);
    this.render();
    return true;
  }

  private toggleFileMentionSelection(): boolean {
    const { mention, suggestions } = this.currentFileSuggestions();
    const first = suggestions[0];
    if (!mention || !first) return false;
    if (this.selectedFileMentions.has(first.path)) {
      this.selectedFileMentions.delete(first.path);
      this.message = `Unselected ${first.path}.`;
    } else {
      this.selectedFileMentions.add(first.path);
      this.message = `Selected ${this.selectedFileMentions.size} file${this.selectedFileMentions.size === 1 ? "" : "s"}.`;
    }
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
    if (this.handleChangePromptKey("escape")) return;
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
    this.transcriptScrollOffset = 0;

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
    if (name === "/settings") {
      this.openFocus("settings", "Settings opened.");
      return;
    }
    if (name === "/permissions") {
      this.openFocus("permissions", "Permissions opened.");
      return;
    }
    if (name === "/jobs") {
      this.openFocus("jobs", "Jobs opened.");
      return;
    }
    if (name === "/artifacts") {
      this.openFocus("artifacts", "Artifacts opened.");
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
    if (name === "/files") {
      await this.openWorkbench("Workbench opened.");
      return;
    }
    if (name === "/sessions") {
      await this.showSessions();
      return;
    }
    if (name === "/session") {
      await this.showSession(value);
      return;
    }
    if (name === "/search") {
      this.searchTranscript(value);
      return;
    }
    if (name === "/history") {
      await this.searchHistory(value);
      return;
    }
    if (name === "/resume" || name === "/fork") {
      await this.resumeOrFork(value, name === "/fork" ? "fork" : "resume");
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

  private pushSystem(text: string, message: string): void {
    this.localEntries.push({ kind: "system", text, timestamp: nowIso() });
    this.message = message;
    this.render();
  }

  private async showSessions(): Promise<void> {
    const sessions = await listSessions({ workspacePath: this.options.workspace, limit: 12 });
    if (sessions.length === 0) {
      this.pushSystem("No sessions found.", "Sessions opened.");
      return;
    }
    this.pushSystem(
      sessions.map((session) =>
        `${session.sessionId}  ${session.status}${session.finishReason ? ` ${session.finishReason}` : ""}  ${truncateMiddle(session.title, 70).text}`
      ).join("\n"),
      "Sessions opened."
    );
  }

  private async showSession(sessionId: string): Promise<void> {
    if (!sessionId) {
      this.pushSystem("Usage: /session <id>", "Session command needs an id.");
      return;
    }
    const meta = await loadSessionMeta({ sessionId, workspacePath: this.options.workspace });
    if (!meta) {
      this.pushSystem(`Session not found: ${sessionId}`, "Session not found.");
      return;
    }
    const events = (await readSessionEventsText(meta.eventsPath)).trim().split(/\r?\n/).filter(Boolean);
    this.pushSystem(
      [
        meta.sessionId,
        `title: ${meta.title}`,
        `status: ${meta.status}${meta.finishReason ? ` ${meta.finishReason}` : ""}`,
        `model: ${meta.provider}/${meta.model}`,
        `events: ${events.length}`,
        meta.finalMessage ? `final: ${truncateMiddle(meta.finalMessage, 240).text}` : ""
      ].filter(Boolean).join("\n"),
      "Session opened."
    );
  }

  private searchTranscript(query: string): void {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      this.pushSystem("Usage: /search <query>", "Search command needs a query.");
      return;
    }
    const lines = buildTranscript({
      workspacePath: this.options.workspace,
      provider: this.options.provider,
      model: this.options.model ?? this.result?.model,
      events: this.events,
      result: this.result,
      localEntries: this.localEntries
    }).map((entry) => JSON.stringify(entry));
    const matches = lines.filter((line) => {
      const lower = line.toLowerCase();
      return tokens.every((token) => lower.includes(token));
    }).slice(0, 12);
    this.pushSystem(matches.length > 0 ? matches.join("\n") : "No transcript matches.", "Transcript search complete.");
  }

  private async searchHistory(query: string): Promise<void> {
    if (!query.trim()) {
      this.pushSystem("Usage: /history <query>", "History command needs a query.");
      return;
    }
    const results = await searchSessions({ query, workspacePath: this.options.workspace, limit: 10 });
    if (results.length === 0) {
      this.pushSystem("No matching sessions found.", "History search complete.");
      return;
    }
    this.pushSystem(
      results.map((result) => `${result.session.sessionId}  rank=${result.score}  ${truncateMiddle(result.session.title, 70).text}\n  ${result.matches.slice(0, 2).join("\n  ")}`).join("\n"),
      "History search complete."
    );
  }

  private async resumeOrFork(value: string, mode: "resume" | "fork"): Promise<void> {
    const [sessionId, ...instructionParts] = value.split(/\s+/);
    const instruction = instructionParts.join(" ").trim();
    if (!sessionId || !instruction) {
      this.pushSystem(`Usage: /${mode} <id> <instruction>`, `${mode} command needs an id and instruction.`);
      return;
    }
    if (this.running) {
      this.message = `Wait for the active run to finish before /${mode}.`;
      this.render();
      return;
    }
    const context = await loadSessionResumeContext({ sessionId, workspacePath: this.options.workspace });
    if (!context) {
      this.pushSystem(`Session not found: ${sessionId}`, "Session not found.");
      return;
    }
    const nextInstruction = buildResumeInstruction({ context, instruction, mode });
    this.localEntries.push({ kind: "user", text: `/${mode} ${sessionId} ${instruction}`, timestamp: nowIso() });
    await this.startRun(nextInstruction, {
      parentSessionId: context.session.sessionId,
      forkedFromSessionId: mode === "fork" ? context.session.sessionId : undefined
    });
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
    this.workbenchOpen = false;
    this.changePromptDismissed = false;
    this.transcriptScrollOffset = 0;
    this.message = message;
    this.render();
  }

  private adjustTranscriptScroll(delta: number): void {
    const next = Math.max(0, this.transcriptScrollOffset + delta);
    if (next === this.transcriptScrollOffset) {
      this.message = next === 0 ? "Transcript is at the latest output." : "Transcript scroll limit reached.";
      this.render();
      return;
    }
    this.transcriptScrollOffset = next;
    this.message = next === 0
      ? "Transcript returned to latest output."
      : `Transcript scrolled back ${next} line${next === 1 ? "" : "s"}.`;
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

  private async openWorkbench(message: string): Promise<void> {
    this.workbenchOpen = true;
    this.message = message;
    await this.refreshDiff();
    this.render();
  }

  private async toggleWorkbench(): Promise<void> {
    if (this.workbenchOpen) {
      this.workbenchOpen = false;
      this.message = "Workbench closed.";
      this.render();
      return;
    }
    await this.openWorkbench("Workbench opened.");
  }

  private changePromptActive(): boolean {
    return !this.currentRunState().active
      && !this.changePromptDismissed
      && this.composer.text.length === 0
      && (this.result?.changedFiles?.length ?? 0) > 0;
  }

  private handleChangePromptKey(key: "return" | "escape" | "d"): boolean {
    if (!this.changePromptActive()) return false;
    if (key === "escape") {
      this.changePromptDismissed = true;
      this.message = "Test prompt skipped.";
      this.render();
      return true;
    }
    if (key === "d") {
      void this.toggleDiffDetail();
      return true;
    }

    this.changePromptDismissed = true;
    const command = this.options.validationCommands?.[0];
    if (!command) {
      this.message = "No validation command configured. Use /test <command>.";
      this.render();
      return true;
    }
    void this.runLocalCommand(command, "test");
    return true;
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

  private async startRun(instruction: string, links: { parentSessionId?: string; forkedFromSessionId?: string } = {}): Promise<void> {
    this.running = true;
    this.cancelling = false;
    this.abortController = new AbortController();
    this.result = null;
    this.focusMode = "none";
    this.changePromptDismissed = false;
    this.transcriptScrollOffset = 0;
    this.message = "Run started.";
    this.render();
    try {
      const result = await this.sessionRunner({
        instruction,
        workspacePath: this.options.workspace,
        provider: this.options.provider,
        model: this.options.model,
        permissionMode: this.options.permissionMode,
        sandbox: this.options.sandbox,
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
        permissionRules: this.options.permissionRules,
        loopGuardMode: this.options.loopGuardMode,
        memoryScopes: this.options.memoryScopes,
        contextMode: this.options.contextMode,
        repoMapMaxChars: this.options.repoMapMaxChars,
        modelContextLimits: this.options.modelContextLimits,
        maxMessageHistoryChars: this.options.maxMessageHistoryChars,
        messageHistoryRetain: this.options.messageHistoryRetain,
        compactionSummaryChars: this.options.compactionSummaryChars,
        compactionMode: this.options.compactionMode,
        compactionModel: this.options.compactionModel,
        compactionProvider: this.options.compactionProvider,
        compactionMaxInputChars: this.options.compactionMaxInputChars,
        compactionMaxOutputChars: this.options.compactionMaxOutputChars,
        compactionTimeoutSec: this.options.compactionTimeoutSec,
        compactionFallback: this.options.compactionFallback,
        finalEvidenceMode: this.options.finalEvidenceMode,
        skillsMode: this.options.skillsMode,
        skillsMaxChars: this.options.skillsMaxChars,
        subagentsEnabled: this.options.subagentsEnabled,
        subagentBackgroundEnabled: this.options.subagentBackgroundEnabled,
        subagentHeartbeatTimeoutSec: this.options.subagentHeartbeatTimeoutSec,
        subagentMaxTurns: this.options.subagentMaxTurns,
        subagentMaxOutputChars: this.options.subagentMaxOutputChars,
        reviewAntiGaming: this.options.reviewAntiGaming,
        enableMcp: this.options.enableMcp,
        mcpConfig: this.options.mcpConfig,
        traceJsonlPath: this.options.traceJsonl,
        sessionJsonlPath: this.options.sessionJsonl,
        summaryJsonPath: this.options.summaryJson,
        parentSessionId: links.parentSessionId,
        forkedFromSessionId: links.forkedFromSessionId,
        abortSignal: this.abortController.signal,
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
      this.cancelling = false;
      this.abortController = null;
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

  private currentRunState(): TuiRunState {
    return buildTuiRunState({
      running: this.running,
      cancelling: this.cancelling,
      result: this.result,
      queuedInstruction: this.queuedInstruction,
      pendingApproval: this.permissionController.pending
    });
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
      return renderFileMentionPalette(
        mention.prefix,
        suggestions,
        width,
        Math.min(8, rows),
        this.colorEnabled,
        this.selectedFileMentions
      );
    }
    return undefined;
  }

  private render(): void {
    const width = Math.max(40, this.stdout.columns ?? 100);
    const rows = Math.max(12, this.stdout.rows ?? 32);
    const entries = buildTranscript({
      workspacePath: this.options.workspace,
      provider: this.options.provider,
      model: this.options.model ?? this.result?.model,
      events: this.events,
      result: this.result,
      localEntries: this.localEntries,
      pendingApproval: this.permissionController.pending
    });
    const activityItems = buildActivity({
      events: this.events,
      result: this.result,
      pendingApproval: this.permissionController.pending
    });
    const runState = this.currentRunState();
    const overlay = this.overlay(width, Math.floor(rows * 0.4));
    const palette = this.palette(width, Math.floor(rows * 0.35));
    const screen = renderScreen({
      workspacePath: this.options.workspace,
      provider: this.options.provider,
      model: this.options.model,
      permissionMode: this.options.permissionMode,
      sandbox: this.options.sandbox,
      validationMode: this.options.validationMode,
      finalEvidenceMode: this.options.finalEvidenceMode,
      maxTurns: this.options.maxTurns,
      mode: this.mode,
      running: this.running,
      result: this.result,
      runState,
      events: this.events,
      message: this.message,
      queuedInstruction: runState.queuedInstruction,
      composer: this.composer,
      entries,
      activityItems,
      workbenchOpen: this.workbenchOpen,
      filePaths: this.filePaths,
      diffText: this.diffText,
      overlay,
      palette,
      transcriptScrollOffset: this.transcriptScrollOffset,
      width,
      height: rows,
      color: this.colorEnabled
    });
    this.stdout.write(`${HIDE_CURSOR}\x1b[2J\x1b[H${screen}`);
  }

  private focusTitle(): string {
    if (this.focusMode === "help") return "help";
    if (this.focusMode === "settings") return "settings";
    if (this.focusMode === "permissions") return "permissions";
    if (this.focusMode === "jobs") return "jobs";
    if (this.focusMode === "artifacts") return "artifacts";
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
    if (this.focusMode === "settings") return this.settingsLines(innerWidth);
    if (this.focusMode === "permissions") return this.permissionsLines(innerWidth);
    if (this.focusMode === "jobs") return this.jobsLines(innerWidth);
    if (this.focusMode === "artifacts") return this.artifactsLines(innerWidth);
    if (this.focusMode === "tokens") return this.tokensLines(innerWidth);
    if (this.focusMode === "context") return this.contextLines(innerWidth);
    if (this.focusMode === "tools") return this.toolsLines(innerWidth);
    if (this.focusMode === "diff") return renderDiffLines(this.result, this.diffText, this.diffMode, innerWidth, 10, this.colorEnabled);
    if (this.focusMode === "test") return this.localCommandLines(innerWidth);
    return this.statusLines(innerWidth);
  }

  private statusLines(width: number): string[] {
    const result = this.result;
    const runState = this.currentRunState();
    const validationFailed = result?.harness
      ? [...result.harness.validation_results, ...result.harness.precheck_results].some((item) => item.exit_code !== 0)
      : false;
    const validation = result?.harness ? (validationFailed ? "failed" : "ok") : this.options.validationMode ?? "off";
    return [
      ...field("state", runState.label, width),
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
      ...field("queued", runState.queuedInstruction ? truncate(oneLine(redactSecretText(runState.queuedInstruction)), 120) : "none", width),
      ...field("input mode", runState.composerPrompt, width),
      ...field("last result", runState.lastResult ?? "none", width)
    ];
  }

  private settingsLines(width: number): string[] {
    return [
      ...field("workspace", redactSecretText(this.options.workspace), width),
      ...field("provider/model", `${this.options.provider}/${this.options.model ?? this.result?.model ?? "default"}`, width),
      ...field("mode", this.mode, width),
      ...field("permission", this.options.permissionMode, width),
      ...field("sandbox", sandboxSummary(this.options.sandbox), width),
      ...field("validation", this.options.validationMode ?? "off", width),
      ...field("final evidence", this.options.finalEvidenceMode ?? "off", width),
      ...field("context mode", this.options.contextMode ?? this.result?.contextMode ?? "repo-map", width),
      ...field("skills mode", this.options.skillsMode ?? "auto", width),
      ...field("mcp", this.options.enableMcp ? this.options.mcpConfig ? `enabled ${this.options.mcpConfig}` : "enabled" : "off", width)
    ];
  }

  private permissionsLines(width: number): string[] {
    const pending = this.permissionController.pending;
    const rules = this.options.permissionRules ?? [];
    return [
      ...field("permission mode", this.options.permissionMode, width),
      ...field("sandbox", sandboxSummary(this.options.sandbox), width),
      ...field("allowed tools", listValue(this.options.allowedTools), width),
      ...field("disabled tools", listValue(mergeDisabledToolsForMode(this.mode, this.options.disabledTools)), width),
      ...field("rules", rules.length > 0 ? `${rules.length}` : "none", width),
      ...field("pending approval", pending ? `${pending.toolName} ${pending.risk}` : "none", width),
      ...(pending ? field("pending reason", pending.reason, width) : []),
      ...(rules.length > 0 ? ["", "rules", ...rules.slice(0, 6).map((rule, index) => truncateToWidth(`  ${index + 1}. ${redactSecretText(JSON.stringify(rule))}`, width))] : [])
    ];
  }

  private jobsLines(width: number): string[] {
    const runState = this.currentRunState();
    const activity = buildActivity({
      events: this.events,
      result: this.result,
      pendingApproval: this.permissionController.pending
    });
    const active = activity.filter((item) => item.status === "queued" || item.status === "running" || item.status === "waiting");
    const paths = sessionArtifactPaths(this.options.workspace, this.result, this.options);
    const lines = [
      ...field("run state", runState.label, width),
      ...field("session id", this.result?.sessionId ?? "not started", width),
      ...compactRedactedField("manifest", paths.manifest, width),
      ...field("queued input", runState.queuedInstruction ? truncate(oneLine(redactSecretText(runState.queuedInstruction)), 120) : "none", width),
      ...field("validation", validationSummary(this.result), width),
      ...field("precheck", precheckSummary(this.result), width),
      ...field("active items", active.length, width),
      ""
    ];
    if (active.length === 0) lines.push("No active jobs.");
    for (const item of active.slice(-10)) {
      lines.push(activityLine(item, width));
    }
    if (activity.length > active.length) {
      lines.push("");
      lines.push("recent completed");
      for (const item of activity.filter((candidate) => candidate.status !== "queued" && candidate.status !== "running" && candidate.status !== "waiting").slice(-5)) {
        lines.push(activityLine(item, width));
      }
    }
    return lines;
  }

  private artifactsLines(width: number): string[] {
    const result = this.result;
    const changed = result?.changedFiles ?? [];
    const paths = sessionArtifactPaths(this.options.workspace, result, this.options);
    return [
      ...field("session id", result?.sessionId ?? "not started", width),
      ...compactRedactedField("manifest", paths.manifest, width),
      ...field("changed files", changed.length, width),
      ...field("validation", validationSummary(result), width),
      ...field("precheck", precheckSummary(result), width),
      ...field("evidence records", result?.evidenceRecords?.length ?? 0, width),
      ...field("final gate", result?.finalGate?.status ?? "not run", width),
      ...compactRedactedField("cli inspect", result?.sessionId ? `agent inspect ${result.sessionId} --workspace ${this.options.workspace}` : "agent inspect --workspace <workspace>", width),
      ...compactRedactedField("cli artifacts", result?.sessionId ? `agent artifacts ${result.sessionId} --workspace ${this.options.workspace} --json` : "agent artifacts --workspace <workspace> --json", width),
      "",
      ...compactRedactedField("meta json", paths.meta, width),
      ...compactRedactedField("summary json", paths.summary, width),
      ...compactRedactedField("events jsonl", paths.events, width),
      ...compactRedactedField("checkpoints", paths.checkpoints, width),
      ...compactRedactedField("trace jsonl", paths.trace, width),
      ...compactRedactedField("session jsonl", paths.sessionJsonl, width),
      ...compactRedactedField("run summary", paths.runSummary, width),
      ...compactRedactedField("attempts dir", paths.attempts, width),
      ...(changed.length > 0 ? ["", ...changed.slice(0, 8).map((file) => truncateToWidth(`  ${redactSecretText(file)}`, width))] : []),
      ...(this.diffText.trim() ? ["", "diff preview", ...this.diffText.split(/\r?\n/).slice(0, 4).map((line) => truncateToWidth(`  ${redactSecretText(line)}`, width))] : [])
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
    const available = this.result?.toolsAvailable ?? latestToolsAvailable(this.events);
    const activity = buildActivity({
      events: this.events,
      result: this.result,
      pendingApproval: this.permissionController.pending
    }).filter((item) => item.kind === "tool" || item.kind === "check" || item.kind === "approval" || item.kind === "subagent" || item.kind === "review");
    const lines = [
      `available: ${available.length > 0 ? available.join(", ") : "after first run"}`,
      "",
      "recent activity"
    ];
    if (activity.length === 0) lines.push("No activity yet.");
    for (const item of activity.slice(-10)) {
      lines.push(activityLine(item, width));
    }
    return lines;
  }

  private helpLines(width: number): string[] {
    const commandLines = COMMANDS.map((command) => {
      const aliases = command.aliases.length > 0 ? ` ${command.aliases.join(", ")}` : "";
      return truncateToWidth(`${command.usage.padEnd(20)}${aliases.padEnd(10)}${command.description}`, width);
    });
    return [
      ...sigmaWelcome({
        provider: this.options.provider,
        model: this.options.model ?? this.result?.model,
        workspacePath: redactSecretText(this.options.workspace)
      }),
      `  ${sigmaTagline()}`,
      "",
      "Shortcuts",
      "Enter send   Ctrl+J newline   Tab workbench   Shift+Tab plan/build   Esc close/clear",
      "Left/Right move cursor   Ctrl+A/E start/end   Ctrl+U/K kill   Ctrl+W delete word   Ctrl+Y yank",
      "Ctrl+D diff   Ctrl+T tools   F1 help   /files workbench   @ file mention   !command shell",
      "PageUp/PageDown scroll transcript",
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
    this.pasteMode = false;
    this.pasteBuffer = "";
    this.stdout.write(`${SHOW_CURSOR}${DISABLE_BRACKETED_PASTE}\x1b[2J\x1b[H${EXIT_ALT_SCREEN}`);
    this.resolveExit?.();
  }
}

export async function runTuiApp(options: TuiAppOptions): Promise<void> {
  const app = new TuiApp(options, process.stdin, process.stdout);
  try {
    await app.start();
  } finally {
    process.stdout.write(`${SHOW_CURSOR}${DISABLE_BRACKETED_PASTE}${EXIT_ALT_SCREEN}`);
  }
}
