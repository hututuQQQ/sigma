import { createHash } from "node:crypto";
import type { AgentMessage, ToolCall } from "agent-ai";
import type {
  AgentLoopDiagnostics,
  AgentLoopPhase,
  AgentLoopPhaseHistoryItem,
  AgentLoopPolicy,
  AgentLoopTransitionReason,
  AgentStepOutcomeKind,
  AgentStepOutcomeSummary,
  AgentTaskIntent,
  LoopGuardMode,
  MutationEvidenceRecord,
  ProtocolRepairRecord,
  ToolResult
} from "./types.js";
import { toolAllMetadata, toolModelContent } from "./types.js";
import { containsToolCallText, assessTerminalText } from "./controller/terminal-acceptance.js";

const DEFAULT_REPEATED_CALL_THRESHOLD = 3;
const MAX_SIGNATURE_PREVIEW_CHARS = 1200;

const READ_TOOLS = new Set(["read", "read_many", "grep", "glob", "repo_query", "symbol_search", "memory", "list"]);
const BROAD_READ_TOOLS = new Set(["glob", "read_many", "repo_query", "symbol_search", "memory", "list"]);
const MUTATION_TOOLS = new Set(["edit", "write", "apply_patch"]);
const EXEC_MUTATION_TOOLS = new Set(["bash", "shell_session", "service"]);
const VALIDATION_TOOLS = new Set(["validate"]);
const IMPLEMENT_DISABLED_TOOLS = new Set(["glob", "read_many", "repo_query", "symbol_search", "memory", "list"]);
const STRICT_IMPLEMENT_DISABLED_TOOLS = new Set([...IMPLEMENT_DISABLED_TOOLS, "read", "grep"]);

export type QueuedAgentMessage =
  | { role: "user" | "system"; content: string }
  | { role: "stop"; reason?: string };

export class AgentMessageQueue {
  private readonly queue: QueuedAgentMessage[] = [];

  push(message: QueuedAgentMessage): void {
    this.queue.push(message);
  }

  drain(): QueuedAgentMessage[] {
    return this.queue.splice(0, this.queue.length);
  }
}

export interface LoopGuardDecision {
  action: "none" | "nudge" | "stop";
  signature?: string;
  signaturePreview?: string;
  streak?: number;
  message?: string;
  skipToolCalls?: boolean;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function previewText(value: string): string {
  return value.length > MAX_SIGNATURE_PREVIEW_CHARS ? `${value.slice(0, MAX_SIGNATURE_PREVIEW_CHARS)}...` : value;
}

function callSignature(call: ToolCall): { key: string; preview: string } {
  const args = stableJson(call.function.arguments);
  return {
    key: `${call.function.name}:${hashText(args)}`,
    preview: `${call.function.name}:${previewText(args)}`
  };
}

function callsSignature(calls: ToolCall[]): { key: string; preview: string } {
  const signatures = calls.map(callSignature);
  return {
    key: signatures.map((item) => item.key).join("\n"),
    preview: signatures.map((item) => item.preview).join("\n")
  };
}

export class RepeatedToolCallGuard {
  private lastSignature = "";
  private streak = 0;
  private nudgedForSignature = new Set<string>();

  constructor(
    private readonly mode: LoopGuardMode = "stop",
    private readonly threshold = DEFAULT_REPEATED_CALL_THRESHOLD
  ) {}

  observe(calls: ToolCall[]): LoopGuardDecision {
    if (this.mode === "off" || calls.length === 0) return { action: "none" };
    const signature = callsSignature(calls);
    if (signature.key === this.lastSignature) {
      this.streak += 1;
    } else {
      this.lastSignature = signature.key;
      this.streak = 1;
    }
    if (this.streak < this.threshold) {
      return { action: "none", signature: signature.key, signaturePreview: signature.preview, streak: this.streak };
    }

    const alreadyNudged = this.nudgedForSignature.has(signature.key);
    if (alreadyNudged && this.mode === "stop") {
      return {
        action: "stop",
        signature: signature.key,
        signaturePreview: signature.preview,
        streak: this.streak,
        message: "Sigma stopped because the model repeated the same tool call sequence after a recovery nudge."
      };
    }

    this.nudgedForSignature.add(signature.key);
    return {
      action: "nudge",
      signature: signature.key,
      signaturePreview: signature.preview,
      streak: this.streak,
      skipToolCalls: this.mode === "stop",
      message: [
        "Loop guard: you have repeated the same tool call sequence several times.",
        "Do not repeat that exact call again. Reassess the result, change the approach, or explain why no further tool use is useful."
      ].join("\n")
    };
  }
}

export class AgentLoopEngine {
  readonly queue = new AgentMessageQueue();
  readonly loopGuard: RepeatedToolCallGuard;

  constructor(options: { loopGuardMode?: LoopGuardMode } = {}) {
    this.loopGuard = new RepeatedToolCallGuard(options.loopGuardMode ?? "stop");
  }

  drainQueuedMessages(messages: AgentMessage[]): { stopReason?: string; appended: number } {
    let appended = 0;
    for (const item of this.queue.drain()) {
      if (item.role === "stop") return { stopReason: item.reason ?? "Stopped by queued control message.", appended };
      messages.push({ role: item.role, content: item.content });
      appended += 1;
    }
    return { appended };
  }
}

export interface StructuredLoopToolPolicy {
  phase: AgentLoopPhase;
  disabledTools: Set<string>;
  toolsDisabled: boolean;
  reason?: string;
}

export interface StructuredLoopDecision {
  action: "none" | "continue" | "stop";
  outcome: AgentStepOutcomeKind;
  phase: AgentLoopPhase;
  reason?: string;
  message?: string;
  finishReason?:
    | "completed_with_changes"
    | "completed_no_changes_allowed"
    | "blocked_no_feasible_edit"
    | "protocol_violation"
    | "loop_guard_repeated_tool"
    | "max_steps";
}

export interface ToolObservation {
  call: ToolCall;
  result: ToolResult;
}

export interface TurnObservation {
  turn: number;
  maxTurns: number;
  calls: ToolCall[];
  results: ToolResult[];
  changedFilesBefore: string[];
  changedFilesAfter: string[];
}

function timestamp(): string {
  return new Date().toISOString();
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

function resultChangedFiles(result: ToolResult): string[] {
  const metadata = toolAllMetadata(result);
  if (metadata.checkOnly === true) return [];
  const changedFiles = metadata.changedFiles;
  if (Array.isArray(changedFiles)) {
    return changedFiles.filter((file): file is string => typeof file === "string" && file.length > 0);
  }
  const relative = metadata.relativePath;
  return typeof relative === "string" && relative.length > 0 ? [relative] : [];
}

function compactToolSummary(result: ToolResult): string {
  return toolModelContent(result).replace(/\s+/g, " ").trim().slice(0, 240);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))].sort((a, b) => a.localeCompare(b, "en"));
}

export class MutationEvidenceLedger {
  private readonly records: MutationEvidenceRecord[] = [];

  add(record: Omit<MutationEvidenceRecord, "timestamp"> & { timestamp?: string }): void {
    const files = uniqueSorted(record.files);
    if (files.length === 0) return;
    const normalized: MutationEvidenceRecord = {
      ...record,
      files,
      timestamp: record.timestamp ?? timestamp()
    };
    const key = `${normalized.kind}:${normalized.toolCallId ?? ""}:${normalized.toolName ?? ""}:${normalized.files.join("|")}`;
    if (this.records.some((item) => `${item.kind}:${item.toolCallId ?? ""}:${item.toolName ?? ""}:${item.files.join("|")}` === key)) {
      return;
    }
    this.records.push(normalized);
  }

  observeTool(call: ToolCall, result: ToolResult): void {
    if (!result.ok) return;
    if (!MUTATION_TOOLS.has(call.function.name) && !EXEC_MUTATION_TOOLS.has(call.function.name)) return;
    const files = resultChangedFiles(result);
    if (files.length === 0) return;
    this.add({
      kind: "tool",
      files,
      toolName: call.function.name,
      toolCallId: call.id,
      summary: compactToolSummary(result)
    });
  }

  observeWorkspaceDiff(files: string[], summary = "Workspace changed during tool execution."): void {
    this.add({ kind: "workspace_diff", files, summary });
  }

  all(): MutationEvidenceRecord[] {
    return [...this.records];
  }

  hasEvidence(): boolean {
    return this.records.length > 0;
  }
}

export class AgentStepProcessor {
  readonly mutationEvidence = new MutationEvidenceLedger();
  readonly phaseHistory: AgentLoopPhaseHistoryItem[] = [];
  readonly stepOutcomes: AgentStepOutcomeSummary[] = [];
  readonly transitionReasons: AgentLoopTransitionReason[] = [];
  readonly protocolRepairs: ProtocolRepairRecord[] = [];
  private phase: AgentLoopPhase;
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
  private lastReason: string | undefined;
  private lastOutcome: AgentStepOutcomeKind | undefined;
  private implementStartTurn: number | undefined;
  private implementNoMutationTurns = 0;
  private strictImplement = false;
  private plainNoEvidenceTerminalAttempts = 0;

  constructor(
    private readonly options: {
      intent: AgentTaskIntent;
      policy: AgentLoopPolicy;
    }
  ) {
    this.phase = options.intent === "mutation" ? "explore" : "explore";
    this.recordPhase(0, this.phase, "initial");
  }

  toolPolicy(): StructuredLoopToolPolicy {
    if (this.options.intent !== "mutation") {
      return { phase: this.phase, disabledTools: new Set(), toolsDisabled: false };
    }
    if (this.phase === "implement" || this.phase === "repair") {
      return {
        phase: this.phase,
        disabledTools: new Set(this.strictImplement ? STRICT_IMPLEMENT_DISABLED_TOOLS : IMPLEMENT_DISABLED_TOOLS),
        toolsDisabled: false,
        reason: this.lastReason ?? "Mutation evidence is required; prefer edit/write/apply_patch over more discovery."
      };
    }
    return { phase: this.phase, disabledTools: new Set(), toolsDisabled: false };
  }

  denyToolMessage(tool: string): string | null {
    const policy = this.toolPolicy();
    if (policy.disabledTools.has(tool)) {
      return [
        `Structured loop blocked ${tool}: phase=${policy.phase}.`,
        policy.reason ?? "Use edit/write/apply_patch, a targeted allowed read, or state a concrete blocker."
      ].join("\n");
    }
    return null;
  }

  observeProtocolText(content: string | undefined, turn: number): StructuredLoopDecision | null {
    if (!containsToolCallText(content)) return null;
    const message = [
      "Structured loop: assistant emitted text that looks like a tool call.",
      "Use the real tool channel for tool calls. Do not emit XML/DSML/JSON tool-call markup in assistant text.",
      "Continue with edit/write/apply_patch if an implementation is possible, or state a concrete blocker."
    ].join("\n");
    if (this.protocolRepairs.length >= 1) {
      this.transition(turn, "stopped", "protocol_violation", message);
      this.recordOutcome(turn, "protocol_error", "protocol_violation", message);
      return {
        action: "stop",
        outcome: "protocol_error",
        phase: this.phase,
        reason: "protocol_violation",
        message,
        finishReason: "protocol_violation"
      };
    }
    this.transition(turn, "repair", "protocol_repair", message);
    this.protocolRepairs.push({
      turn,
      phase: this.phase,
      reason: "tool_call_markup_in_text",
      message,
      attempt: this.protocolRepairs.length + 1,
      timestamp: timestamp()
    });
    this.recordOutcome(turn, "needs_follow_up", "protocol_repair", message);
    return {
      action: "continue",
      outcome: "needs_follow_up",
      phase: this.phase,
      reason: "protocol_repair",
      message
    };
  }

  observeTerminalCandidate(options: {
    turn: number;
    content?: string;
    changedFiles: string[];
  }): StructuredLoopDecision {
    const protocol = this.observeProtocolText(options.content, options.turn);
    if (protocol) return protocol;

    const changed = options.changedFiles.length > 0 || this.mutationEvidence.hasEvidence();
    if (this.options.intent !== "mutation") {
      this.recordOutcome(options.turn, "terminal", "completed_no_changes_allowed", undefined, options.changedFiles);
      return {
        action: "stop",
        outcome: "terminal",
        phase: this.phase,
        reason: "completed_no_changes_allowed",
        finishReason: "completed_no_changes_allowed"
      };
    }
    if (changed) {
      this.recordOutcome(options.turn, "terminal", "completed_with_changes", undefined, options.changedFiles);
      return {
        action: "stop",
        outcome: "terminal",
        phase: this.phase,
        reason: "completed_with_changes",
        finishReason: "completed_with_changes"
      };
    }

    const text = assessTerminalText(options.content);
    if (text.kind === "blocker") {
      const message = "Structured loop stopped: mutation task produced no file changes and the assistant reported a blocker.";
      this.transition(options.turn, "stopped", "blocked_no_feasible_edit", message);
      this.recordOutcome(options.turn, "blocked", "blocked_no_feasible_edit", message);
      return {
        action: "stop",
        outcome: "blocked",
        phase: this.phase,
        reason: "blocked_no_feasible_edit",
        message,
        finishReason: "blocked_no_feasible_edit"
      };
    }

    this.plainNoEvidenceTerminalAttempts += 1;
    if (this.plainNoEvidenceTerminalAttempts >= 2) {
      const message = [
        "Structured loop stopped: mutation task ended without file changes or a concrete blocker.",
        "Sigma will not mark a no-change mutation run as completed."
      ].join("\n");
      this.transition(options.turn, "stopped", "blocked_no_feasible_edit", message);
      this.recordOutcome(options.turn, "blocked", "mutation_unresolved_without_changes", message);
      return {
        action: "stop",
        outcome: "blocked",
        phase: this.phase,
        reason: "mutation_unresolved_without_changes",
        message,
        finishReason: "blocked_no_feasible_edit"
      };
    }

    const message = [
      "Structured loop: this is a mutation task, but no mutation evidence exists.",
      "Do not finish yet. Use edit/write/apply_patch now, or state the concrete blocker that makes an edit impossible."
    ].join("\n");
    this.strictImplement = true;
    this.transition(options.turn, "implement", "assistant_stopped_without_mutation", message);
    this.recordOutcome(options.turn, "needs_follow_up", "assistant_stopped_without_mutation", message);
    return {
      action: "continue",
      outcome: "needs_follow_up",
      phase: this.phase,
      reason: "assistant_stopped_without_mutation",
      message
    };
  }

  observeTurn(observation: TurnObservation): StructuredLoopDecision {
    this.providerTurns = observation.turn;
    const toolNames = observation.calls.map(toolName);
    const beforeCount = observation.changedFilesBefore.length;
    const afterCount = observation.changedFilesAfter.length;
    const changed = afterCount > beforeCount || this.mutationEvidence.hasEvidence();
    const hasMutationTool = observation.calls.some((call, index) => MUTATION_TOOLS.has(toolName(call)) && resultOk(observation.results[index]));
    const hasValidationTool = observation.calls.some((call, index) => VALIDATION_TOOLS.has(toolName(call)) && resultOk(observation.results[index]));
    const hasReadTool = observation.calls.some((call) => READ_TOOLS.has(toolName(call)));
    const hasBroadReadTool = observation.calls.some((call) => BROAD_READ_TOOLS.has(toolName(call)));

    if (changed || hasMutationTool) {
      this.mutationCount += 1;
      this.noChangeTurns = 0;
      this.readOnlyTurns = 0;
      this.implementNoMutationTurns = 0;
      this.strictImplement = false;
      if (this.options.intent === "mutation") this.transition(observation.turn, "verify", "mutation_evidence_recorded");
    } else if (observation.calls.length > 0) {
      this.noChangeTurns += 1;
      if (!hasMutationTool && hasReadTool) this.readOnlyTurns += 1;
      if (hasBroadReadTool) this.broadReadTurns += 1;
      if (this.phase === "implement" && !hasMutationTool) this.implementNoMutationTurns += 1;
    }
    if (hasValidationTool) this.validationCount += 1;

    for (const call of observation.calls) {
      const key = readIntentKey(call);
      if (!key) continue;
      if (key === this.lastReadIntent) this.lastReadIntentStreak += 1;
      else {
        this.lastReadIntent = key;
        this.lastReadIntentStreak = 1;
      }
      if (this.lastReadIntentStreak > this.options.policy.repeatedReadIntentLimit) {
        this.repeatedReadIntents += 1;
      }
    }

    if (this.options.intent !== "mutation") {
      this.recordOutcome(observation.turn, "continue", "non_mutation_follow_up", undefined, observation.changedFilesAfter, toolNames);
      return { action: "none", outcome: "continue", phase: this.phase };
    }

    if (changed) {
      this.recordOutcome(observation.turn, "continue", "mutation_evidence_recorded", undefined, observation.changedFilesAfter, toolNames);
      return { action: "none", outcome: "continue", phase: this.phase };
    }

    const remainingTurns = Math.max(0, observation.maxTurns - observation.turn);
    if (remainingTurns <= 0) {
      const message = "Structured loop stopped: max step budget reached before mutation evidence was produced.";
      this.transition(observation.turn, "stopped", "max_steps", message);
      this.recordOutcome(observation.turn, "max_steps", "max_steps", message, observation.changedFilesAfter, toolNames);
      return { action: "stop", outcome: "max_steps", phase: this.phase, reason: "max_steps", message, finishReason: "max_steps" };
    }

    if (
      this.readOnlyTurns >= this.options.policy.readOnlyTurnLimit ||
      this.noChangeTurns >= this.options.policy.noChangeTurnLimit ||
      this.broadReadTurns >= this.options.policy.broadExploreLimit ||
      this.repeatedReadIntents > 0 ||
      remainingTurns <= this.options.policy.implementationReserveTurns ||
      (this.phase === "implement" && this.implementNoMutationTurns >= 2)
    ) {
      const reason = this.phase === "implement" && this.implementNoMutationTurns >= 2
        ? "implement_without_mutation"
        : this.broadReadTurns >= this.options.policy.broadExploreLimit || this.repeatedReadIntents > 0
          ? "broad_or_repeated_reads"
          : "mutation_no_change_budget";
      if (this.phase === "implement" && this.implementNoMutationTurns >= 2) this.strictImplement = true;
      const message = [
        "Structured loop: this mutation task has no file changes yet.",
        this.strictImplement
          ? "Next action must be edit/write/apply_patch, or a concrete blocker. Further read/search calls are blocked."
          : "Move from exploration to implementation. Prefer edit/write/apply_patch; use only narrow reads if absolutely necessary.",
        `Recent tools: ${toolNames.join(", ") || "none"}.`
      ].join("\n");
      if (this.implementStartTurn === undefined) this.implementStartTurn = observation.turn;
      this.transition(observation.turn, "implement", reason, message);
      this.recordOutcome(observation.turn, "needs_follow_up", reason, message, observation.changedFilesAfter, toolNames);
      return { action: "continue", outcome: "needs_follow_up", phase: this.phase, reason, message };
    }

    this.recordOutcome(observation.turn, "continue", "explore_follow_up", undefined, observation.changedFilesAfter, toolNames);
    return { action: "none", outcome: "continue", phase: this.phase };
  }

  observeMutationEvidence(observations: ToolObservation[], workspaceDiffFiles: string[]): void {
    for (const observation of observations) {
      this.mutationEvidence.observeTool(observation.call, observation.result);
    }
    if (workspaceDiffFiles.length > 0) {
      this.mutationEvidence.observeWorkspaceDiff(workspaceDiffFiles);
    }
  }

  observeCompaction(turn: number, nextActions: string[]): StructuredLoopDecision {
    if (nextActions.length === 0) {
      return { action: "none", outcome: "continue", phase: this.phase };
    }
    const message = [
      "Structured loop: continue from the compaction checkpoint.",
      ...nextActions.slice(0, 3).map((item) => `Next action: ${item}`),
      this.options.intent === "mutation"
        ? "Do not restart broad exploration; continue from the current phase and produce mutation evidence or a concrete blocker."
        : "Continue from the retained context."
    ].join("\n");
    this.recordOutcome(turn, "continue", "post_compaction_continuation", message);
    return {
      action: "continue",
      outcome: "continue",
      phase: this.phase,
      reason: "post_compaction_continuation",
      message
    };
  }

  observeLoopGuard(turn: number, message: string | undefined, stop: boolean): StructuredLoopDecision {
    const reason = "loop_guard_repeated_tool";
    const finalMessage = message ?? "Structured loop stopped because the model repeated the same tool call.";
    if (stop) {
      this.transition(turn, "stopped", reason, finalMessage);
      this.recordOutcome(turn, "loop_guard", reason, finalMessage);
      return {
        action: "stop",
        outcome: "loop_guard",
        phase: this.phase,
        reason,
        message: finalMessage,
        finishReason: "loop_guard_repeated_tool"
      };
    }
    this.transition(turn, "repair", reason, finalMessage);
    this.recordOutcome(turn, "needs_follow_up", reason, finalMessage);
    return { action: "continue", outcome: "needs_follow_up", phase: this.phase, reason, message: finalMessage };
  }

  diagnostics(): AgentLoopDiagnostics {
    return {
      intent: this.options.intent,
      mode: this.legacyMode(),
      phase: this.phase,
      ...(this.lastOutcome ? { stepOutcome: this.lastOutcome } : {}),
      providerTurns: this.providerTurns,
      readOnlyTurns: this.readOnlyTurns,
      noChangeTurns: this.noChangeTurns,
      broadReadTurns: this.broadReadTurns,
      repeatedReadIntents: this.repeatedReadIntents,
      mutationCount: this.mutationCount,
      validationCount: this.validationCount,
      forcedActions: [...this.forcedActions],
      ...(this.lastReason ? { lastControllerReason: this.lastReason } : {})
    };
  }

  markFinal(turn: number, reason: string): void {
    this.transition(turn, "final", reason);
  }

  private legacyMode(): AgentLoopDiagnostics["mode"] {
    if (this.phase === "implement") return "force_implement";
    if (this.phase === "repair") return "narrow_explore";
    return "normal";
  }

  private transition(turn: number, next: AgentLoopPhase, reason: string, message?: string): void {
    const previous = this.phase;
    this.lastReason = reason;
    if (!this.forcedActions.includes(reason)) this.forcedActions.push(reason);
    if (previous === next) return;
    this.phase = next;
    const at = timestamp();
    this.transitionReasons.push({ turn, from: previous, to: next, reason, ...(message ? { message } : {}), timestamp: at });
    this.recordPhase(turn, next, reason, previous, at);
  }

  private recordPhase(turn: number, phase: AgentLoopPhase, reason: string, previousPhase?: AgentLoopPhase, at = timestamp()): void {
    this.phaseHistory.push({
      turn,
      phase,
      reason,
      ...(previousPhase ? { previousPhase } : {}),
      timestamp: at
    });
  }

  private recordOutcome(
    turn: number,
    outcome: AgentStepOutcomeKind,
    reason?: string,
    message?: string,
    changedFiles?: string[],
    toolNames?: string[]
  ): void {
    this.lastOutcome = outcome;
    this.stepOutcomes.push({
      turn,
      phase: this.phase,
      outcome,
      ...(reason ? { reason } : {}),
      ...(message ? { message } : {}),
      ...(toolNames && toolNames.length > 0 ? { toolNames } : {}),
      ...(changedFiles && changedFiles.length > 0 ? { changedFiles } : {}),
      timestamp: timestamp()
    });
  }
}
