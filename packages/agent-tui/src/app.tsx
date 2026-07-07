import { execFile } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline";
import type { ProviderName } from "agent-ai";
import type { AgentEvent, AgentRunResult, PermissionDecision, PermissionMode } from "agent-core";
import { ApprovalPrompt } from "./components/approval-prompt.js";
import { Composer } from "./components/composer.js";
import { DiffPanel } from "./components/diff-panel.js";
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
}

class TuiApp {
  private inputBuffer = "";
  private running = false;
  private exitAfterRun = false;
  private events: AgentEvent[] = [];
  private result: AgentRunResult | null = null;
  private message: string | null = null;
  private showTools = false;
  private showDiff = false;
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
      this.message = "Cleared.";
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
      this.showDiff = !this.showDiff;
      if (this.showDiff) await this.refreshDiff();
      this.render();
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
      const { stdout } = await execFileAsync("git", ["-C", this.options.workspace, "diff", "--stat"], {
        timeout: 5000,
        maxBuffer: 20000
      });
      this.diffText = stdout.toString();
    } catch (error) {
      this.diffText = error instanceof Error ? error.message : String(error);
    }
  }

  private render(): void {
    const rows = this.stdout.rows ?? 30;
    const reserved = 8 + (this.showTools ? 8 : 0) + (this.showDiff ? 8 : 0);
    const timelineRows = Math.max(4, rows - reserved);
    const sections = [
      StatusBar({
        workspacePath: this.options.workspace,
        provider: this.options.provider,
        model: this.options.model,
        permissionMode: this.options.permissionMode,
        running: this.running,
        result: this.result,
        message: this.message
      }),
      "",
      ApprovalPrompt(this.permissionController.pending),
      Timeline(this.events, timelineRows),
      this.showTools ? ToolPanel(this.events, this.result) : "",
      this.showDiff ? DiffPanel(this.result, this.diffText) : "",
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
      `  changed: ${(result.changedFiles ?? []).join(", ") || "none"}`
    ];
    if (result.todoItems && result.todoItems.length > 0) {
      lines.push(`  todos: ${result.todoItems.map((item) => `${item.id}:${item.status}:${item.text}`).join(" | ")}`);
    }
    if (result.finalMessage) lines.push(`  final: ${result.finalMessage}`);
    return lines.join("\n");
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
