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
import { Composer } from "./components/composer.js";
import { DiffPanel, parseDiffMode, type DiffMode } from "./components/diff-panel.js";
import { eventUsage, formatUsage, oneLine, truncate } from "./components/formatting.js";
import { StatusBar } from "./components/status-bar.js";
import { Timeline } from "./components/timeline.js";
import { ToolPanel } from "./components/tool-panel.js";
import { TuiPermissionController } from "./permission.js";
import { runSession } from "./run-session.js";

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

function shellCommand(command: string): { file: string; args: string[] } {
  return process.platform === "win32"
    ? { file: "cmd.exe", args: ["/d", "/s", "/c", command] }
    : { file: "bash", args: ["-lc", command] };
}

function blockTail(value: string, max = 4000): string {
  const redacted = redactSecretText(value);
  return redacted.length <= max ? redacted : `${redacted.slice(0, 1200)}\n... truncated ...\n${redacted.slice(-Math.max(0, max - 1220))}`;
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
  private infoText: string | null = null;
  private showTools = false;
  private showDiff = false;
  private diffMode: DiffMode = "stat";
  private diffText = "";
  private readonly permissionController = new TuiPermissionController();

  constructor(
    private readonly options: TuiAppOptions,
    private readonly stdin: NodeJS.ReadStream,
    private readonly stdout: NodeJS.WriteStream
  ) {}

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

    if (key.name === "return") {
      void this.submitInput();
      return;
    }
    if (key.name === "backspace") {
      this.inputBuffer = this.inputBuffer.slice(0, -1);
      this.render();
      return;
    }
    if (key.name === "escape") {
      this.inputBuffer = "";
      this.render();
      return;
    }
    if (text && !key.ctrl && !key.meta && text >= " ") {
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

  private async submitInput(): Promise<void> {
    const value = this.inputBuffer.trim();
    this.inputBuffer = "";
    if (!value) {
      this.render();
      return;
    }
    if (value.startsWith("/")) {
      await this.handleCommand(value);
      return;
    }
    if (this.running) {
      this.message = "A run is already active.";
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
      this.events = [];
      this.result = null;
      this.infoText = null;
      this.message = "Cleared.";
      this.render();
      return;
    }
    if (name === "/help") {
      this.infoText = this.helpText();
      this.message = "Help opened.";
      this.render();
      return;
    }
    if (name === "/status") {
      this.infoText = this.statusText();
      this.message = "Status opened.";
      this.render();
      return;
    }
    if (name === "/tokens") {
      this.infoText = this.tokensText();
      this.message = "Token usage opened.";
      this.render();
      return;
    }
    if (name === "/context") {
      this.infoText = this.contextText();
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
      this.showTools = !this.showTools;
      this.render();
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
      this.showDiff = value ? true : !this.showDiff;
      if (this.showDiff) await this.refreshDiff();
      this.render();
      return;
    }
    if (name === "/test") {
      await this.runTestCommand(value);
      return;
    }
    this.message = `Unknown command: ${name}`;
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
      if (this.showDiff) await this.refreshDiff();
    } catch (error) {
      this.message = `Run failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.running = false;
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
    const rows = this.stdout.rows ?? 30;
    const infoRows = this.infoText ? Math.min(10, this.infoText.split(/\r?\n/).length + 1) : 0;
    const reserved = 8 + infoRows + (this.showTools ? 8 : 0) + (this.showDiff ? 8 : 0);
    const timelineRows = Math.max(4, rows - reserved);
    const sections = [
      StatusBar({
        workspacePath: this.options.workspace,
        provider: this.options.provider,
        model: this.options.model,
        permissionMode: this.options.permissionMode,
        validationMode: this.options.validationMode,
        finalEvidenceMode: this.options.finalEvidenceMode,
        running: this.running,
        result: this.result,
        events: this.events,
        message: this.message
      }),
      "",
      ApprovalPrompt(this.permissionController.pending),
      this.infoText ?? "",
      Timeline(this.events, timelineRows),
      this.showTools ? ToolPanel(this.events, this.result) : "",
      this.showDiff ? DiffPanel(this.result, this.diffText, this.diffMode) : "",
      "",
      this.result ? this.resultSummary(this.result) : "",
      Composer({
        input: this.inputBuffer,
        running: this.running,
        approvalPending: Boolean(this.permissionController.pending),
        lastStatus: this.result?.status
      })
    ].filter((section) => section.length > 0);
    this.stdout.write(`\x1b[2J\x1b[H${sections.join("\n\n")}`);
  }

  private completionMessage(result: AgentRunResult): string {
    if (result.status === "completed") return "Run completed.";
    if (result.status === "stopped") return `Run stopped: ${result.finishReason}.`;
    return `Run failed: ${result.lastError ?? result.finishReason}.`;
  }

  private resultSummary(result: AgentRunResult): string {
    const lines = [
      "Summary",
      `  status: ${result.status}`,
      `  finish: ${result.finishReason}`,
      `  changed: ${(result.changedFiles ?? []).join(", ") || "none"}`,
      `  tools: ${result.toolCalls}`,
      `  tokens: ${formatUsage(result.usage)}`
    ];
    if (result.harness) {
      const failed = [...result.harness.validation_results, ...result.harness.precheck_results].filter((item) => item.exit_code !== 0);
      lines.push(`  harness: attempts=${result.harness.attempts.length} failed_checks=${failed.length}`);
    }
    if (result.finalGate) lines.push(`  final_gate: ${result.finalGate.status}`);
    if (result.evidenceRecords && result.evidenceRecords.length > 0) {
      lines.push(`  evidence: ${result.evidenceRecords.filter((item) => item.ok).length}/${result.evidenceRecords.length} ok`);
    }
    if (result.todoItems && result.todoItems.length > 0) {
      lines.push(`  todos: ${result.todoItems.map((item) => `${item.id}:${item.status}:${item.text}`).join(" | ")}`);
    }
    if (result.finalMessage) lines.push(`  final: ${truncate(oneLine(redactSecretText(result.finalMessage)), 180)}`);
    return lines.join("\n");
  }

  private helpText(): string {
    return [
      "Commands",
      "  /help                 Show commands",
      "  /status               Show run settings and latest result",
      "  /tokens               Show current or last token usage",
      "  /context              Show context, project instruction, and skill state",
      "  /test <command>       Run a local command in the workspace",
      "  /tools                Toggle tool panel",
      "  /diff                 Toggle git diff stat",
      "  /diff stat            Show git diff stat",
      "  /diff patch           Show truncated git patch",
      "  /model <name>         Set model",
      "  /provider <name>      Set provider",
      "  /permission <mode>    Set ask or yolo",
      "  /clear                Clear timeline and result",
      "  /exit                 Exit"
    ].join("\n");
  }

  private latestUsage(): Partial<TokenTotals> | null {
    if (this.result) return this.result.usage;
    const total: Partial<TokenTotals> = { inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalTokens: 0 };
    let seen = false;
    for (const event of this.events) {
      if (event.type !== "usage") continue;
      const usage = eventUsage(event);
      if (!usage) continue;
      seen = true;
      total.inputTokens = (total.inputTokens ?? 0) + (usage.inputTokens ?? 0);
      total.outputTokens = (total.outputTokens ?? 0) + (usage.outputTokens ?? 0);
      total.cacheTokens = (total.cacheTokens ?? 0) + (usage.cacheTokens ?? 0);
      total.totalTokens = (total.totalTokens ?? 0) + (usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
    }
    return seen ? total : null;
  }

  private statusText(): string {
    const result = this.result;
    return [
      "Status",
      `  state: ${this.running ? "running" : result?.status ?? "idle"}`,
      `  provider: ${this.options.provider}`,
      `  model: ${this.options.model ?? "default"}`,
      `  permission: ${this.options.permissionMode}`,
      `  workspace: ${this.options.workspace}`,
      `  max_turns: ${this.options.maxTurns ?? "default"}`,
      `  max_wall_time_sec: ${this.options.maxWallTimeSec ?? "default"}`,
      `  command_timeout_sec: ${this.options.commandTimeoutSec ?? "default"}`,
      `  validation: ${this.options.validationMode ?? "off"}`,
      `  final_evidence: ${this.options.finalEvidenceMode ?? "off"}`,
      `  mcp: ${this.options.enableMcp ? "enabled" : "off"}`,
      result ? `  last_result: ${result.status} ${result.finishReason}` : "  last_result: none"
    ].join("\n");
  }

  private tokensText(): string {
    const usage = this.latestUsage();
    return ["Tokens", `  ${usage ? formatUsage(usage) : "No usage yet."}`].join("\n");
  }

  private contextText(): string {
    const sources = this.result?.projectInstructionSources ?? [];
    const skills = this.result?.selectedSkills ?? [];
    return [
      "Context",
      `  mode: ${this.options.contextMode ?? this.result?.contextMode ?? "repo-map"}`,
      `  repo_map_max_chars: ${this.options.repoMapMaxChars ?? "default"}`,
      `  repo_map_chars: ${this.result?.repoMapChars ?? "unknown"}`,
      `  project_instructions: ${sources.length > 0 ? sources.join(", ") : "not loaded yet"}`,
      `  skills_mode: ${this.options.skillsMode ?? "auto"}`,
      `  selected_skills: ${skills.length > 0 ? skills.map((skill) => `${skill.name}:${skill.source}`).join(", ") : "none yet"}`
    ].join("\n");
  }

  private async runTestCommand(command: string): Promise<void> {
    if (!command) {
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

    this.message = "Running test command.";
    this.render();
    const result = await runLocalShellCommand(command, this.options.workspace, this.options.commandTimeoutSec ?? 60);
    this.infoText = [
      "Test",
      `  command: ${truncate(oneLine(redactSecretText(command)), 160)}`,
      `  exit: ${result.exitCode ?? "signal"}${result.timedOut ? " timed_out=true" : ""}`,
      `  duration_ms: ${result.durationMs}`,
      "  stdout:",
      ...blockTail(result.stdout || "(empty)", 2500).split(/\r?\n/).map((line) => `    ${line}`),
      "  stderr:",
      ...blockTail(result.stderr || "(empty)", 2500).split(/\r?\n/).map((line) => `    ${line}`)
    ].join("\n");
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
