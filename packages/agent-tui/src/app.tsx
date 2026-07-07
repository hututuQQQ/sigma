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
  type PermissionDecision,
  type PermissionMode,
  type TokenTotals
} from "agent-core";
import { ApprovalPrompt } from "./components/approval-prompt.js";
import { COMMANDS, renderCommandPalette } from "./components/commands.js";
import { Composer } from "./components/composer.js";
import { DiffPanel, parseDiffMode, type DiffMode } from "./components/diff-panel.js";
import { eventUsage, formatUsage, oneLine, truncate } from "./components/formatting.js";
import { StatusBar, usageFromEvents } from "./components/status-bar.js";
import { Timeline } from "./components/timeline.js";
import { ToolPanel } from "./components/tool-panel.js";
import { TuiPermissionController } from "./permission.js";
import { runSession } from "./run-session.js";
import { box } from "./ui/box.js";
import { lineCount, renderMainArea } from "./ui/layout.js";
import { glyphs, supportsColor, truncateToWidth, wrapText } from "./ui/theme.js";

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

interface TestSnapshot {
  command: string;
  result: CommandResult;
}

type FocusMode = "status" | "tokens" | "context" | "tools" | "diff" | "test" | "help";

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

class TuiApp {
  private inputBuffer = "";
  private running = false;
  private exitAfterRun = false;
  private events: AgentEvent[] = [];
  private result: AgentRunResult | null = null;
  private message: string | null = null;
  private focusMode: FocusMode = "status";
  private diffMode: DiffMode = "stat";
  private diffText = "";
  private testSnapshot: TestSnapshot | null = null;
  private queuedInstruction: string | null = null;
  private readonly history: string[] = [];
  private historyCursor: number | null = null;
  private historyDraft = "";
  private readonly permissionController = new TuiPermissionController();
  private readonly colorEnabled: boolean;

  constructor(
    private readonly options: TuiAppOptions,
    private readonly stdin: NodeJS.ReadStream,
    private readonly stdout: NodeJS.WriteStream
  ) {
    this.colorEnabled = supportsColor(stdout);
  }

  async start(): Promise<void> {
    readline.emitKeypressEvents(this.stdin);
    this.permissionController.onChange(() => this.render());
    if (this.stdin.isTTY) this.stdin.setRawMode(true);
    this.stdin.resume();
    this.stdin.on("keypress", this.handleKeypress);
    this.stdout.write("\x1b[?25h");
    this.render();
    await new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  private resolveExit: (() => void) | null = null;

  private readonly handleKeypress = (text: string, key: readline.Key): void => {
    if (key.ctrl && key.name === "c") {
      this.stop();
      return;
    }

    const pending = this.permissionController.pending;
    if (pending) {
      const decision = this.permissionDecisionForKey(text);
      if (decision) this.permissionController.respond(decision);
      else {
        this.message = "Approval waiting: press y to allow, n to deny, or a to always allow.";
        this.render();
      }
      return;
    }

    if (key.name === "backspace") {
      this.resetHistoryCursor();
      this.inputBuffer = this.inputBuffer.slice(0, -1);
      this.render();
      return;
    }
    if (key.ctrl && key.name === "j") {
      this.resetHistoryCursor();
      this.inputBuffer += "\n";
      this.render();
      return;
    }
    if (key.ctrl && key.name === "l") {
      this.clearTimeline("Cleared.");
      return;
    }
    if (key.ctrl && key.name === "d") {
      void this.toggleDiffPanel();
      return;
    }
    if (key.ctrl && key.name === "t") {
      this.toggleToolsPanel();
      return;
    }
    if (key.name === "f1" || (key.ctrl && key.name === "h")) {
      this.focusMode = "help";
      this.message = "Help opened.";
      this.render();
      return;
    }
    if (key.name === "escape") {
      this.handleEscape();
      return;
    }
    if (key.name === "up") {
      this.recallHistory("up");
      return;
    }
    if (key.name === "down") {
      this.recallHistory("down");
      return;
    }
    if (key.name === "return") {
      void this.submitInput();
      return;
    }
    if (text && !key.ctrl && !key.meta && text >= " ") {
      this.resetHistoryCursor();
      this.inputBuffer += text;
      this.render();
    }
  };

  private permissionDecisionForKey(text: string): PermissionDecision | null {
    const normalized = text.trim().toLowerCase();
    if (normalized === "y") return "allow";
    if (normalized === "n") return "deny";
    if (normalized === "a") return "always_allow";
    return null;
  }

  private resetHistoryCursor(): void {
    this.historyCursor = null;
    this.historyDraft = "";
  }

  private recallHistory(direction: "up" | "down"): void {
    if (this.history.length === 0) return;
    if (this.historyCursor === null) {
      this.historyCursor = this.history.length;
      this.historyDraft = this.inputBuffer;
    }
    if (direction === "up") this.historyCursor = Math.max(0, this.historyCursor - 1);
    else this.historyCursor = Math.min(this.history.length, this.historyCursor + 1);

    if (this.historyCursor === this.history.length) {
      this.inputBuffer = this.historyDraft;
      this.resetHistoryCursor();
    } else {
      this.inputBuffer = this.history[this.historyCursor] ?? "";
    }
    this.render();
  }

  private rememberInput(value: string): void {
    if (!value) return;
    if (this.history[this.history.length - 1] !== value) this.history.push(value);
    if (this.history.length > 100) this.history.shift();
    this.resetHistoryCursor();
  }

  private handleEscape(): void {
    if (this.inputBuffer.length > 0) {
      this.inputBuffer = "";
      this.resetHistoryCursor();
      this.message = "Input cleared.";
    } else if (this.focusMode !== "status") {
      this.focusMode = "status";
      this.message = "Focus closed.";
    } else {
      this.message = null;
    }
    this.render();
  }

  private async submitInput(): Promise<void> {
    const value = this.inputBuffer.trim();
    if (!value) {
      this.inputBuffer = "";
      this.render();
      return;
    }
    this.rememberInput(value);
    this.inputBuffer = "";
    if (value.startsWith("/")) {
      await this.handleCommand(value);
      return;
    }
    if (this.running) {
      this.queuedInstruction = value;
      this.message = "Queued one follow-up task for the next run.";
      this.render();
      return;
    }
    await this.startRun(value);
  }

  private async handleCommand(command: string): Promise<void> {
    const [name, ...rest] = command.split(/\s+/);
    const value = rest.join(" ").trim();
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
      this.clearTimeline("Cleared.");
      return;
    }
    if (name === "/help") {
      this.focusMode = "help";
      this.message = "Help opened.";
      this.render();
      return;
    }
    if (name === "/status") {
      this.focusMode = "status";
      this.message = "Status opened.";
      this.render();
      return;
    }
    if (name === "/tokens") {
      this.focusMode = "tokens";
      this.message = "Token usage opened.";
      this.render();
      return;
    }
    if (name === "/context") {
      this.focusMode = "context";
      this.message = "Context opened.";
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
    if (name === "/tools") {
      this.toggleToolsPanel();
      return;
    }
    if (name === "/diff") {
      const requestedMode = parseDiffMode(value);
      if (!requestedMode) {
        this.message = "Diff mode must be stat or patch.";
        this.render();
        return;
      }
      this.diffMode = requestedMode;
      if (value || this.focusMode !== "diff") {
        this.focusMode = "diff";
        await this.refreshDiff();
      } else {
        this.focusMode = "status";
      }
      this.render();
      return;
    }
    if (name === "/test") {
      await this.runTestCommand(value);
      return;
    }
    this.focusMode = "help";
    this.message = `Unknown command: ${name}`;
    this.render();
  }

  private clearTimeline(message: string): void {
    this.events = [];
    this.result = null;
    this.testSnapshot = null;
    this.message = message;
    this.render();
  }

  private toggleToolsPanel(): void {
    this.focusMode = this.focusMode === "tools" ? "status" : "tools";
    this.message = this.focusMode === "tools" ? "Tools opened." : "Tools closed.";
    this.render();
  }

  private async toggleDiffPanel(): Promise<void> {
    if (this.focusMode === "diff") {
      this.focusMode = "status";
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
    this.message = "Run started.";
    this.render();
    try {
      const result = await runSession({
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
        disabledTools: this.options.disabledTools,
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
      this.focusMode = "status";
    } catch (error) {
      this.message = `Run failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.running = false;
      const next = this.queuedInstruction;
      if (next && !this.exitAfterRun) {
        this.queuedInstruction = null;
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

  private render(): void {
    const width = Math.max(60, this.stdout.columns ?? 100);
    const rows = Math.max(20, this.stdout.rows ?? 32);
    const masthead = StatusBar({
      workspacePath: this.options.workspace,
      provider: this.options.provider,
      model: this.options.model,
      permissionMode: this.options.permissionMode,
      validationMode: this.options.validationMode,
      finalEvidenceMode: this.options.finalEvidenceMode,
      running: this.running,
      result: this.result,
      events: this.events,
      message: this.message,
      maxTurns: this.options.maxTurns,
      enableMcp: this.options.enableMcp,
      queuedInstruction: this.queuedInstruction,
      width,
      color: this.colorEnabled
    });
    const composer = Composer({
      input: this.inputBuffer,
      running: this.running,
      approvalPending: Boolean(this.permissionController.pending),
      lastStatus: this.result?.status,
      queuedInstruction: this.queuedInstruction,
      width,
      color: this.colorEnabled
    });
    const fixedRows = lineCount(masthead) + lineCount(composer) + 2;
    const mainHeight = Math.max(8, rows - fixedRows);
    const main = this.renderMain(width, mainHeight);
    this.stdout.write(`\x1b[2J\x1b[H${masthead}\n${main}\n${composer}`);
  }

  private renderMain(width: number, height: number): string {
    if (width >= 100) {
      const timelineWidth = Math.max(44, Math.floor(width * 0.58));
      const focusWidth = Math.max(40, width - timelineWidth - 2);
      const timeline = Timeline(this.events, Math.max(2, height - 2), timelineWidth, height, this.colorEnabled);
      const focus = this.renderFocus(focusWidth, height);
      return renderMainArea({ timeline, focus, width, height });
    }

    const timelineHeight = Math.max(5, Math.floor(height * 0.48));
    const focusHeight = Math.max(5, height - timelineHeight);
    const timeline = Timeline(this.events, Math.max(2, timelineHeight - 2), width, timelineHeight, this.colorEnabled);
    const focus = this.renderFocus(width, focusHeight);
    return `${timeline}\n${focus}`;
  }

  private renderFocus(width: number, height: number): string {
    const pending = this.permissionController.pending;
    if (pending) return ApprovalPrompt(pending, { width, height, color: this.colorEnabled });
    if (this.inputBuffer.trimStart().startsWith("/")) {
      return box({
        title: `${glyphs().sigma} Help`,
        width,
        height,
        variant: "accent",
        color: this.colorEnabled,
        lines: renderCommandPalette(this.inputBuffer, Math.max(20, width - 4), Math.max(4, height - 5))
      });
    }

    if (this.focusMode === "tools") return ToolPanel(this.events, this.result, width, height, this.colorEnabled);
    if (this.focusMode === "diff") return DiffPanel(this.result, this.diffText, this.diffMode, width, height, this.colorEnabled);

    const g = glyphs();
    const lines = this.focusMode === "help"
      ? this.helpLines(width)
      : this.focusMode === "tokens"
        ? this.tokensLines(width)
        : this.focusMode === "context"
          ? this.contextLines(width)
          : this.focusMode === "test"
            ? this.testLines(width)
            : this.statusLines(width);
    const title = this.focusMode === "help"
      ? `${g.sigma} Help`
      : this.focusMode === "tokens"
        ? `${g.sigma} Tokens`
        : this.focusMode === "context"
          ? `${g.sigma} Context`
          : this.focusMode === "test"
            ? `${g.sigma} Test`
            : this.result
              ? `${g.sigma} Summary`
              : `${g.sigma} Status`;
    return box({
      title,
      width,
      height,
      color: this.colorEnabled,
      lines
    });
  }

  private completionMessage(result: AgentRunResult): string {
    if (result.status === "completed") return "Run completed.";
    if (result.status === "stopped") return `Run stopped: ${result.finishReason}.`;
    return `Run failed: ${result.lastError ?? result.finishReason}.`;
  }

  private summaryLines(result: AgentRunResult, width: number): string[] {
    const g = glyphs();
    const evidenceTotal = result.evidenceRecords?.length ?? 0;
    const evidenceOk = result.evidenceRecords?.filter((item) => item.ok).length ?? 0;
    const validationFailed = result.harness
      ? [...result.harness.validation_results, ...result.harness.precheck_results].some((item) => item.exit_code !== 0)
      : false;
    const validation = result.harness ? (validationFailed ? "failed" : "ok") : this.options.validationMode ?? "off";
    const lines = [
      `${g.sigma} Summary`,
      `result: ${result.status} ${g.separator} ${result.finishReason}`,
      `changed: ${(result.changedFiles ?? []).length} files`,
      `evidence: ${evidenceTotal > 0 ? `${evidenceOk}/${evidenceTotal} ok` : "none"}`,
      `validation: ${validation}`,
      `tokens: ${formatUsage(result.usage)}`
    ];
    if (result.finalMessage) {
      lines.push(`final: ${truncateToWidth(oneLine(redactSecretText(result.finalMessage)), Math.max(20, width - 8))}`);
    }
    return lines;
  }

  private statusLines(width: number): string[] {
    const innerWidth = Math.max(20, width - 4);
    const result = this.result;
    const lines = result ? [...this.summaryLines(result, innerWidth), ""] : [];
    lines.push(
      ...field("state", this.running ? "running" : result?.status ?? "idle", innerWidth),
      ...field("workspace", redactSecretText(this.options.workspace), innerWidth),
      ...field("provider/model", `${this.options.provider}/${this.options.model ?? result?.model ?? "default"}`, innerWidth),
      ...field("permission", this.options.permissionMode, innerWidth),
      ...field("validation", this.options.validationMode ?? "off", innerWidth),
      ...field("final evidence", this.options.finalEvidenceMode ?? "off", innerWidth),
      ...field("mcp", this.options.enableMcp ? "enabled" : "off", innerWidth),
      ...field("max turns", this.options.maxTurns, innerWidth),
      ...field("max wall time sec", this.options.maxWallTimeSec, innerWidth),
      ...field("command timeout sec", this.options.commandTimeoutSec, innerWidth),
      ...field("validation commands", listValue(this.options.validationCommands), innerWidth),
      ...field("allowed tools", listValue(this.options.allowedTools), innerWidth),
      ...field("disabled tools", listValue(this.options.disabledTools), innerWidth),
      ...field("queued", this.queuedInstruction ? truncate(oneLine(redactSecretText(this.queuedInstruction)), 120) : "none", innerWidth),
      ...field("last result", result ? `${result.status} ${result.finishReason}` : "none", innerWidth)
    );
    return lines;
  }

  private latestUsage(): Partial<TokenTotals> | null {
    if (this.result) return this.result.usage;
    return usageFromEvents(this.events) ?? null;
  }

  private tokensLines(width: number): string[] {
    const usage = this.latestUsage();
    const innerWidth = Math.max(20, width - 4);
    if (!usage) return ["No usage yet.", "Usage appears after the first model turn."];
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const cache = usage.cacheTokens ?? 0;
    const total = usage.totalTokens ?? input + output;
    return [
      ...field("input", input, innerWidth),
      ...field("output", output, innerWidth),
      ...field("cache", cache, innerWidth),
      ...field("total", total, innerWidth)
    ];
  }

  private contextLines(width: number): string[] {
    const innerWidth = Math.max(20, width - 4);
    const sources = this.result?.projectInstructionSources ?? [];
    const skills = this.result?.selectedSkills ?? [];
    const mcpServers = this.result?.mcpServers ?? [];
    return [
      ...field("context mode", this.options.contextMode ?? this.result?.contextMode ?? "repo-map", innerWidth),
      ...field("repo map max chars", this.options.repoMapMaxChars, innerWidth),
      ...field("repo map chars", this.result?.repoMapChars ?? "unknown", innerWidth),
      ...field("project instructions", sources.length > 0 ? sources.map((source) => redactSecretText(source)).join(", ") : "not loaded yet", innerWidth),
      ...field("skills mode", this.options.skillsMode ?? "auto", innerWidth),
      ...field("selected skills", skills.length > 0 ? skills.map((skill) => `${skill.name}:${skill.source}`).join(", ") : "none yet", innerWidth),
      ...field("mcp", mcpServers.length > 0 ? mcpServers.map((server) => `${server.name}:${server.enabled ? "on" : "off"}:${server.tools_loaded}`).join(", ") : this.options.enableMcp ? "enabled, not loaded yet" : "off", innerWidth)
    ];
  }

  private helpLines(width: number): string[] {
    const g = glyphs();
    const innerWidth = Math.max(20, width - 4);
    return [
      ...renderCommandPalette("/", innerWidth, COMMANDS.length),
      "",
      "Shortcuts",
      `Ctrl+C exit ${g.separator} Esc clear input/close focus ${g.separator} Ctrl+L clear`,
      `Ctrl+D diff ${g.separator} Ctrl+T tools ${g.separator} F1 help ${g.separator} Ctrl+J newline`,
      "Up/Down cycles prompt history. Ctrl+H opens help where the terminal reports it distinctly from Backspace."
    ];
  }

  private testLines(width: number): string[] {
    const innerWidth = Math.max(20, width - 4);
    if (!this.testSnapshot) return ["No /test command has been run yet.", "Use /test <command> to run a local validation command."];
    const { command, result } = this.testSnapshot;
    const stdout = blockTail(result.stdout || "(empty)", 1400).split(/\r?\n/);
    const stderr = blockTail(result.stderr || "(empty)", 1400).split(/\r?\n/);
    return [
      ...field("command", truncate(oneLine(redactSecretText(command)), 160), innerWidth),
      ...field("exit", `${result.exitCode ?? "signal"}${result.timedOut ? " timed out" : ""}`, innerWidth),
      ...field("duration", `${result.durationMs}ms`, innerWidth),
      "",
      "stdout",
      ...stdout.map((line) => truncateToWidth(`  ${line}`, innerWidth)),
      "",
      "stderr",
      ...stderr.map((line) => truncateToWidth(`  ${line}`, innerWidth))
    ];
  }

  private async runTestCommand(command: string): Promise<void> {
    if (!command) {
      this.focusMode = "help";
      this.message = "Usage: /test <command>";
      this.render();
      return;
    }
    if (this.running) {
      this.message = "Wait for the active run to finish before /test.";
      this.render();
      return;
    }

    if (this.options.permissionMode === "ask") {
      const decision = await this.permissionController.decide({
        toolName: "bash",
        arguments: { command },
        risk: "execute",
        reason: "Run local /test command",
        workspacePath: this.options.workspace
      });
      if (decision === "deny") {
        this.message = "Test command denied.";
        this.render();
        return;
      }
    }

    this.focusMode = "test";
    this.message = "Running test command.";
    this.render();
    const result = await runLocalShellCommand(command, this.options.workspace, this.options.commandTimeoutSec ?? 60);
    this.testSnapshot = { command, result };
    this.message = result.exitCode === 0 && !result.timedOut ? "Test command passed." : "Test command finished with issues.";
    this.render();
  }

  private stop(): void {
    this.stdin.off("keypress", this.handleKeypress);
    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdout.write("\x1b[?25h\x1b[2J\x1b[H");
    this.resolveExit?.();
  }
}

export async function runTuiApp(options: TuiAppOptions): Promise<void> {
  const app = new TuiApp(options, process.stdin, process.stdout);
  await app.start();
}
