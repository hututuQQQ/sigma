import type { ToolCall } from "agent-ai";
import type {
  AgentLoopControlMode,
  AgentLoopDiagnostics,
  AgentLoopPolicy,
  AgentTaskIntent,
  ToolResult
} from "../types.js";
import { toolModelContent } from "../types.js";
import { assessTerminalText } from "./terminal-acceptance.js";

export const DEFAULT_AGENT_LOOP_POLICY: AgentLoopPolicy = {
  maxProviderTurns: 80,
  broadExploreLimit: 4,
  readOnlyTurnLimit: 8,
  noChangeTurnLimit: 12,
  implementationReserveTurns: 6,
  repeatedReadIntentLimit: 2
};

const MUTATION_INTENT_PATTERN =
  /\b(fix|repair|implement|refactor|change|modify|update|add|create|write|remove|delete|migrate|split|extract|tighten|harden|address|ship|patch|pr)\b|修复|实现|修改|改动|更改|更新|新增|添加|创建|写入|删除|移除|重构|拆分|抽取|收紧|加固|提交|合并|大改|根治|执行/i;
const ANSWER_INTENT_PATTERN =
  /\b(explain|summarize|inspect|review|analyze|look|read|understand|why|what|how)\b|解释|总结|分析|查看|看看|阅读|理解|为什么|怎么|原因/i;

const MUTATION_TOOLS = new Set(["edit", "write", "apply_patch"]);
const VALIDATION_TOOLS = new Set(["validate"]);
const READ_TOOLS = new Set(["read", "read_many", "grep", "glob", "repo_query", "symbol_search", "memory"]);
const BROAD_READ_TOOLS = new Set(["glob", "read_many", "repo_query", "symbol_search", "memory"]);
const NARROW_DISABLED_TOOLS = new Set(["glob", "read_many", "symbol_search"]);
const FORCE_IMPLEMENT_DISABLED_TOOLS = new Set(["glob", "read_many", "repo_query", "symbol_search", "memory"]);

export interface LoopControllerDecision {
  action: "none" | "steer" | "force_final_text" | "stop";
  mode: AgentLoopControlMode;
  reason?: string;
  message?: string;
}

export interface LoopToolPolicy {
  mode: AgentLoopControlMode;
  disabledTools: Set<string>;
  toolsDisabled: boolean;
  reason?: string;
}

export interface LoopTurnObservation {
  turn: number;
  maxTurns: number;
  calls: ToolCall[];
  results: ToolResult[];
  changedFilesBefore: string[];
  changedFilesAfter: string[];
}

export interface LoopTerminalCandidate {
  content?: string;
  changedFiles: string[];
}

export function resolveAgentLoopPolicy(options: {
  maxTurns?: number;
  override?: Partial<AgentLoopPolicy>;
} = {}): AgentLoopPolicy {
  const maxProviderTurns = Math.max(1, Math.floor(options.maxTurns ?? options.override?.maxProviderTurns ?? DEFAULT_AGENT_LOOP_POLICY.maxProviderTurns));
  return {
    maxProviderTurns,
    broadExploreLimit: Math.max(1, Math.floor(options.override?.broadExploreLimit ?? DEFAULT_AGENT_LOOP_POLICY.broadExploreLimit)),
    readOnlyTurnLimit: Math.max(1, Math.floor(options.override?.readOnlyTurnLimit ?? DEFAULT_AGENT_LOOP_POLICY.readOnlyTurnLimit)),
    noChangeTurnLimit: Math.max(1, Math.floor(options.override?.noChangeTurnLimit ?? DEFAULT_AGENT_LOOP_POLICY.noChangeTurnLimit)),
    implementationReserveTurns: Math.max(1, Math.floor(options.override?.implementationReserveTurns ?? DEFAULT_AGENT_LOOP_POLICY.implementationReserveTurns)),
    repeatedReadIntentLimit: Math.max(1, Math.floor(options.override?.repeatedReadIntentLimit ?? DEFAULT_AGENT_LOOP_POLICY.repeatedReadIntentLimit))
  };
}

export function classifyTaskIntent(instruction: string): AgentTaskIntent {
  if (MUTATION_INTENT_PATTERN.test(instruction)) return "mutation";
  if (ANSWER_INTENT_PATTERN.test(instruction)) return "answer";
  return "inspect";
}

function toolName(call: ToolCall): string {
  return call.function.name;
}

function toolArgs(call: ToolCall): Record<string, unknown> {
  const args = call.function.arguments;
  return args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

function readIntentKey(call: ToolCall): string | null {
  const name = toolName(call);
  if (!READ_TOOLS.has(name)) return null;
  const args = toolArgs(call);
  const path = typeof args.path === "string" ? args.path : typeof args.cwd === "string" ? args.cwd : "";
  const pattern = typeof args.pattern === "string" ? args.pattern : typeof args.query === "string" ? args.query : "";
  return `${name}:${path}:${pattern}`.slice(0, 300);
}

function resultOk(result: ToolResult | undefined): boolean {
  return result?.ok === true;
}

function resultSummary(result: ToolResult | undefined): string {
  if (!result) return "";
  return toolModelContent(result).replace(/\s+/g, " ").trim().slice(0, 240);
}

export class AgentLoopController {
  readonly intent: AgentTaskIntent;
  readonly policy: AgentLoopPolicy;
  private mode: AgentLoopControlMode = "normal";
  private providerTurns = 0;
  private readOnlyTurns = 0;
  private noChangeTurns = 0;
  private broadReadTurns = 0;
  private repeatedReadIntents = 0;
  private mutationCount = 0;
  private validationCount = 0;
  private lastReadIntent = "";
  private lastReadIntentStreak = 0;
  private forcedActions: string[] = [];
  private lastControllerReason: string | undefined;
  private forcedImplementTurn: number | undefined;
  private textToolAttemptCount = 0;

  constructor(options: { instruction: string; policy?: AgentLoopPolicy }) {
    this.intent = classifyTaskIntent(options.instruction);
    this.policy = options.policy ?? DEFAULT_AGENT_LOOP_POLICY;
  }

  toolPolicy(): LoopToolPolicy {
    if (this.mode === "force_final_text") {
      return {
        mode: this.mode,
        disabledTools: new Set(),
        toolsDisabled: true,
        reason: this.lastControllerReason ?? "Controller requires a text-only blocker or completion summary."
      };
    }
    if (this.mode === "force_implement") {
      return {
        mode: this.mode,
        disabledTools: new Set(FORCE_IMPLEMENT_DISABLED_TOOLS),
        toolsDisabled: false,
        reason: this.lastControllerReason
      };
    }
    if (this.mode === "narrow_explore") {
      return {
        mode: this.mode,
        disabledTools: new Set(NARROW_DISABLED_TOOLS),
        toolsDisabled: false,
        reason: this.lastControllerReason
      };
    }
    return { mode: this.mode, disabledTools: new Set(), toolsDisabled: false };
  }

  denyToolMessage(tool: string): string | null {
    const policy = this.toolPolicy();
    if (policy.toolsDisabled) {
      return [
        `Loop controller blocked ${tool}: tools are disabled for this final recovery turn.`,
        "Respond with text only. Summarize what is complete, what remains blocked, and the smallest next action."
      ].join("\n");
    }
    if (policy.disabledTools.has(tool)) {
      return [
        `Loop controller blocked ${tool}: ${policy.mode} is active.`,
        policy.reason ?? "Use a more direct implementation, validation, or exact line-range read instead."
      ].join("\n");
    }
    return null;
  }

  observeTurn(observation: LoopTurnObservation): LoopControllerDecision {
    this.providerTurns = observation.turn;
    const beforeCount = observation.changedFilesBefore.length;
    const afterCount = observation.changedFilesAfter.length;
    const changed = afterCount > beforeCount;
    const toolNames = observation.calls.map(toolName);
    const hasMutationTool = observation.calls.some((call, index) => MUTATION_TOOLS.has(toolName(call)) && resultOk(observation.results[index]));
    const hasValidationTool = observation.calls.some((call, index) => VALIDATION_TOOLS.has(toolName(call)) && resultOk(observation.results[index]));
    const hasReadTool = observation.calls.some((call) => READ_TOOLS.has(toolName(call)));
    const hasBroadReadTool = observation.calls.some((call) => BROAD_READ_TOOLS.has(toolName(call)));

    if (hasMutationTool || changed) this.mutationCount += 1;
    if (hasValidationTool) this.validationCount += 1;

    if (changed) {
      this.noChangeTurns = 0;
      this.readOnlyTurns = 0;
      if (this.mode !== "force_final_text") this.mode = "normal";
    } else if (observation.calls.length > 0) {
      this.noChangeTurns += 1;
      if (!hasMutationTool && hasReadTool) this.readOnlyTurns += 1;
      if (hasBroadReadTool) this.broadReadTurns += 1;
    }

    for (const call of observation.calls) {
      const key = readIntentKey(call);
      if (!key) continue;
      if (key === this.lastReadIntent) {
        this.lastReadIntentStreak += 1;
      } else {
        this.lastReadIntent = key;
        this.lastReadIntentStreak = 1;
      }
      if (this.lastReadIntentStreak > this.policy.repeatedReadIntentLimit) {
        this.repeatedReadIntents += 1;
      }
    }

    if (this.intent !== "mutation") return { action: "none", mode: this.mode };

    if (afterCount > 0) {
      return { action: "none", mode: this.mode };
    }

    if (
      this.mode === "force_implement" &&
      this.forcedImplementTurn !== undefined &&
      observation.turn > this.forcedImplementTurn
    ) {
      return this.setMode("force_final_text", "no_change_after_force_implement", [
        "Loop controller: you already received an implementation checkpoint, but no files have changed.",
        "Do not call tools now. Reply with a concise blocker summary and the smallest concrete edit that should be made next."
      ].join("\n"));
    }

    const remainingTurns = Math.max(0, observation.maxTurns - observation.turn);
    if (
      this.readOnlyTurns >= this.policy.readOnlyTurnLimit ||
      this.noChangeTurns >= this.policy.noChangeTurnLimit ||
      remainingTurns <= this.policy.implementationReserveTurns
    ) {
      const resultTail = observation.results.map(resultSummary).filter(Boolean).slice(-2).join(" | ");
      const message = [
        "Loop controller: this is a mutation task and no files have changed after repeated exploration.",
        "Stop broad discovery. Make the smallest safe edit now, or state the concrete blocker if an edit is impossible.",
        `Recent tools: ${toolNames.join(", ") || "none"}.`,
        resultTail ? `Recent result summary: ${resultTail}` : ""
      ].filter(Boolean).join("\n");
      const decision = this.setMode("force_implement", "mutation_no_change_budget", message);
      this.forcedImplementTurn = observation.turn;
      return decision;
    }

    if (this.broadReadTurns >= this.policy.broadExploreLimit || this.repeatedReadIntents > 0) {
      return this.setMode("narrow_explore", "broad_or_repeated_reads", [
        "Loop controller: exploration is getting broad or repetitive.",
        "Use exact line-range reads, grep for a specific symbol/string, or move to an edit. Do not continue broad file discovery."
      ].join("\n"));
    }

    return { action: "none", mode: this.mode };
  }

  observeTerminalCandidate(candidate: LoopTerminalCandidate): LoopControllerDecision {
    const text = assessTerminalText(candidate.content);
    if (text.kind === "tool_call_text") return this.observeTextToolAttempt();

    if (this.intent !== "mutation" || candidate.changedFiles.length > 0) {
      return { action: "none", mode: this.mode };
    }

    if (this.mode !== "force_final_text") {
      return this.setMode("force_final_text", "assistant_stopped_without_mutation", [
        "Loop controller: this task appears to require code changes, but no files changed.",
        "Do not call tools. Explain the blocker or identify the exact smallest edit still needed."
      ].join("\n"));
    }

    if (text.kind === "blocker") {
      return this.stop("mutation_blocked_without_changes", [
        "Loop controller stopped after a text-only blocker response because this mutation task produced no file changes.",
        "The run is not marked completed; inspect the final message for the blocker and next edit."
      ].join("\n"));
    }

    return this.stop("mutation_unresolved_without_changes", [
      "Loop controller stopped because this mutation task produced no file changes and the final response did not state a concrete blocker.",
      "Sigma will not mark a no-change mutation run as completed."
    ].join("\n"));
  }

  observeCompaction(nextActions: string[]): LoopControllerDecision {
    if (this.mode === "force_final_text") {
      return { action: "none", mode: this.mode };
    }
    if (nextActions.length === 0) return { action: "none", mode: this.mode };
    return {
      action: "steer",
      mode: this.mode,
      reason: "post_compaction_continuation",
      message: [
        "Loop controller: continue from the compaction checkpoint.",
        ...nextActions.slice(0, 3).map((item) => `Next action: ${item}`),
        "Do not restart broad exploration unless the next action is impossible."
      ].join("\n")
    };
  }

  observeTextToolAttempt(): LoopControllerDecision {
    this.textToolAttemptCount += 1;
    this.mode = "force_final_text";
    this.lastControllerReason = "tool_call_text_while_tools_disabled";
    if (!this.forcedActions.includes(this.lastControllerReason)) {
      this.forcedActions.push(this.lastControllerReason);
    }
    const message = [
      "Loop controller: tools are disabled, but the assistant emitted text that looks like a tool call.",
      "Do not emit XML/DSML/JSON tool-call markup. Reply in plain text with the blocker, completed work, and smallest next edit."
    ].join("\n");
    if (this.textToolAttemptCount >= 2) {
      return {
        action: "stop",
        mode: this.mode,
        reason: this.lastControllerReason,
        message
      };
    }
    return {
      action: "force_final_text",
      mode: this.mode,
      reason: this.lastControllerReason,
      message
    };
  }

  diagnostics(): AgentLoopDiagnostics {
    return {
      intent: this.intent,
      mode: this.mode,
      providerTurns: this.providerTurns,
      readOnlyTurns: this.readOnlyTurns,
      noChangeTurns: this.noChangeTurns,
      broadReadTurns: this.broadReadTurns,
      repeatedReadIntents: this.repeatedReadIntents,
      mutationCount: this.mutationCount,
      validationCount: this.validationCount,
      forcedActions: [...this.forcedActions],
      ...(this.lastControllerReason ? { lastControllerReason: this.lastControllerReason } : {})
    };
  }

  private setMode(mode: AgentLoopControlMode, reason: string, message: string): LoopControllerDecision {
    const changed = this.mode !== mode;
    this.mode = mode;
    this.lastControllerReason = reason;
    if (changed || !this.forcedActions.includes(reason)) this.forcedActions.push(reason);
    return {
      action: mode === "force_final_text" ? "force_final_text" : "steer",
      mode,
      reason,
      message
    };
  }

  private stop(reason: string, message: string): LoopControllerDecision {
    this.lastControllerReason = reason;
    if (!this.forcedActions.includes(reason)) this.forcedActions.push(reason);
    return {
      action: "stop",
      mode: this.mode,
      reason,
      message
    };
  }
}
