import type { AgentMessage } from "agent-ai";
import { truncateMiddle } from "../compaction.js";
import { redactSecretText } from "../redaction.js";
import type {
  AgentLoopDiagnostics,
  CompactionFallbackMode,
  CompactionMode,
  EvidenceRecord,
  MutationEvidenceRecord,
  TodoItem,
  WorkflowStateSummary
} from "../types.js";

export const DEFAULT_MESSAGE_HISTORY_RETAIN = 24;
export const DEFAULT_COMPACTION_SUMMARY_CHARS = 30000;
export const COMPACTION_MARKER = "Previous agent conversation compacted by the run controller.";

export type CompactionStrategyName = CompactionMode;

export interface CompactionArtifact {
  objective: string;
  task_intent?: string;
  phase?: string;
  current_plan: string[];
  changed_files: string[];
  files_read?: string[];
  read_ranges?: string[];
  loop_counters?: Record<string, unknown>;
  mutation_evidence?: string[];
  forbidden_repeats?: string[];
  key_decisions: string[];
  failed_attempts: string[];
  validation_evidence: string[];
  unresolved_questions: string[];
  next_actions: string[];
}

export interface CompactionRequest {
  messages: AgentMessage[];
  maxMessageHistoryChars?: number;
  messageHistoryRetain?: number;
  compactionSummaryChars?: number;
  objective?: string;
  workflow?: WorkflowStateSummary;
  evidenceRecords?: EvidenceRecord[];
  changedFiles?: string[];
  todos?: TodoItem[];
  loopDiagnostics?: AgentLoopDiagnostics;
  mutationEvidence?: MutationEvidenceRecord[];
  traceTail?: string;
}

export interface ModelCompactionRequest extends CompactionRequest {
  protectedMessages: AgentMessage[];
  compactedMessages: AgentMessage[];
  tailMessages: AgentMessage[];
  fallbackArtifact: CompactionArtifact;
}

export interface ModelCompactionProvider {
  compact(request: ModelCompactionRequest): Promise<CompactionArtifact>;
}

export interface CompactionResult {
  messages: AgentMessage[];
  compacted: boolean;
  strategy: CompactionStrategyName;
  artifact: CompactionArtifact | null;
  fallbackUsed?: boolean;
  error?: string;
}

export interface CompactionStrategy {
  readonly name: CompactionStrategyName;
  compact(request: CompactionRequest): Promise<CompactionResult> | CompactionResult;
}

interface CompactionWindow {
  shouldCompact: boolean;
  protectedMessages: AgentMessage[];
  compactedMessages: AgentMessage[];
  tailMessages: AgentMessage[];
}

export interface CompactionPlan {
  shouldCompact: boolean;
  beforeMessageCount: number;
  compactedMessageCount: number;
  retainedTailMessageCount: number;
}

function firstUserContent(messages: AgentMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  return firstUser?.content ?? "";
}

function formatTodo(todo: TodoItem): string {
  return `${todo.status}: ${todo.text}${todo.note ? ` (${todo.note})` : ""}`;
}

function compactLine(text: string, maxChars = 240): string {
  return truncateMiddle(text.replace(/\s+/g, " ").trim(), maxChars).text;
}

function messageText(message: AgentMessage): string {
  if (message.role === "assistant") {
    const content = message.content ? `content=${message.content}` : "";
    const reasoning = message.reasoningContent ? `reasoning=${message.reasoningContent}` : "";
    return compactLine([content, reasoning].filter(Boolean).join(" "));
  }
  if (message.role === "tool") {
    return compactLine(message.content);
  }
  return compactLine(message.content);
}

function tailHighlights(messages: AgentMessage[], role: AgentMessage["role"], maxItems: number): string[] {
  return messages
    .filter((message) => message.role === role)
    .map(messageText)
    .filter(Boolean)
    .slice(-maxItems);
}

export function createDeterministicCompactionArtifact(request: CompactionRequest): CompactionArtifact {
  const workflow = request.workflow;
  const todos = request.todos ?? [];
  const evidence = request.evidenceRecords ?? [];
  const changedFiles = request.changedFiles ?? workflow?.changed_files ?? [];
  const loop = request.loopDiagnostics;
  const mutationEvidence = request.mutationEvidence ?? [];
  const activePhase = loop?.phase ?? workflow?.phase;
  const pendingTodos = todos.filter((todo) => todo.status !== "done");
  const completedTodos = todos.filter((todo) => todo.status === "done");
  const failurePatterns = workflow?.failure_patterns ?? [];
  const validationEvidence = evidence
    .filter((record) => record.executable || record.kind !== "unknown")
    .slice(-8)
    .map((record) => {
      const pieces = [
        record.ok ? "ok" : "failed",
        record.kind,
        record.command ? compactLine(record.command, 180) : record.toolName,
        record.summary ? compactLine(record.summary, 220) : ""
      ].filter(Boolean);
      return pieces.join(": ");
    });
  const tailDecisions = tailHighlights(request.messages, "assistant", 5);

  return {
    objective: compactLine(request.objective ?? firstUserContent(request.messages), 1000),
    ...(loop?.intent ? { task_intent: loop.intent } : {}),
    ...(activePhase ? { phase: activePhase } : {}),
    current_plan: activePhase
      ? [
          `active phase: ${activePhase}`,
          ...pendingTodos.slice(0, 5).map((todo) => `deferred todo: ${formatTodo(todo)}`)
        ]
      : pendingTodos.map(formatTodo),
    changed_files: [...changedFiles],
    ...(loop ? {
      loop_counters: {
        mode: loop.mode,
        phase: loop.phase,
        step_outcome: loop.stepOutcome,
        provider_turns: loop.providerTurns,
        read_only_turns: loop.readOnlyTurns,
        no_change_turns: loop.noChangeTurns,
        broad_read_turns: loop.broadReadTurns,
        repeated_read_intents: loop.repeatedReadIntents,
        mutation_count: loop.mutationCount,
        validation_count: loop.validationCount,
        last_reason: loop.lastControllerReason
      }
    } : {}),
    ...(mutationEvidence.length > 0 ? {
      mutation_evidence: mutationEvidence.slice(-8).map((record) => {
        const source = [record.kind, record.toolName, record.toolCallId].filter(Boolean).join(":");
        const files = record.files.join(", ");
        return [source || record.kind, files, record.summary].filter(Boolean).join(" - ");
      })
    } : {}),
    ...(loop?.lastControllerReason ? { forbidden_repeats: [loop.lastControllerReason] } : {}),
    key_decisions: [
      ...completedTodos.slice(-5).map(formatTodo),
      ...tailDecisions
    ].slice(-8),
    failed_attempts: failurePatterns.map((failure) => {
      const command = failure.last_command ? ` command=${compactLine(failure.last_command, 180)}` : "";
      return `${failure.category} x${failure.count}:${command} ${compactLine(failure.last_summary, 220)}`.trim();
    }),
    validation_evidence: validationEvidence,
    unresolved_questions: [],
    next_actions: loop?.intent === "mutation" && activePhase === "verify" && changedFiles.length > 0
      ? [
          "phase=verify: do not restart broad exploration; run validation/diff review, final summary, or typed blocker."
        ]
      : loop?.intent === "mutation" && activePhase === "implement"
        ? ["phase=implement: produce edit/write/apply_patch mutation evidence or typed blocker."]
        : pendingTodos.length > 0
          ? pendingTodos.slice(0, 5).map((todo) => `deferred todo: ${formatTodo(todo)}`)
          : ["Continue from the retained conversation tail."]
  };
}

export function messageHistoryChars(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + JSON.stringify(message).length, 0);
}

export function compactMessageForSummary(message: AgentMessage): string {
  if (message.role === "assistant") {
    const pieces = ["assistant:"];
    if (message.reasoningContent) pieces.push(`reasoning=${truncateMiddle(message.reasoningContent, 600).text}`);
    if (message.content) pieces.push(`content=${truncateMiddle(message.content, 600).text}`);
    if (message.toolCalls && message.toolCalls.length > 0) {
      const calls = message.toolCalls.map((call) => `${call.function.name}(${JSON.stringify(call.function.arguments)})`);
      pieces.push(`tool_calls=${truncateMiddle(calls.join("; "), 1200).text}`);
    }
    return pieces.join(" ");
  }

  if (message.role === "tool") {
    return `tool ${message.name ?? message.toolCallId}: ${truncateMiddle(message.content, 1200).text}`;
  }

  return `${message.role}: ${truncateMiddle(message.content, 1200).text}`;
}

export function summarizeMessages(messages: AgentMessage[], maxChars: number): string {
  const body = messages.map(compactMessageForSummary).join("\n\n");
  return `${COMPACTION_MARKER}\n\n${truncateMiddle(body, Math.max(1, maxChars)).text}`;
}

function compactionWindow(request: CompactionRequest): CompactionWindow {
  const maxChars = request.maxMessageHistoryChars;
  if (
    !maxChars ||
    maxChars <= 0 ||
    messageHistoryChars(request.messages) <= maxChars ||
    request.messages.length <= 3
  ) {
    return {
      shouldCompact: false,
      protectedMessages: [],
      compactedMessages: [],
      tailMessages: []
    };
  }

  const retainCount = Math.max(0, Math.floor(request.messageHistoryRetain ?? DEFAULT_MESSAGE_HISTORY_RETAIN));
  let tailStart = Math.max(2, request.messages.length - retainCount);
  while (tailStart < request.messages.length && request.messages[tailStart].role === "tool") {
    tailStart += 1;
  }

  if (tailStart <= 2 || tailStart >= request.messages.length) {
    return {
      shouldCompact: false,
      protectedMessages: [],
      compactedMessages: [],
      tailMessages: []
    };
  }

  return {
    shouldCompact: true,
    protectedMessages: request.messages.slice(0, 2),
    compactedMessages: request.messages.slice(2, tailStart),
    tailMessages: request.messages.slice(tailStart)
  };
}

export function planCompaction(request: CompactionRequest): CompactionPlan {
  const window = compactionWindow(request);
  return {
    shouldCompact: window.shouldCompact,
    beforeMessageCount: request.messages.length,
    compactedMessageCount: window.compactedMessages.length,
    retainedTailMessageCount: window.tailMessages.length
  };
}

export function compactErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncateMiddle(redactSecretText(message.replace(/\s+/g, " ").trim()), 600).text;
}

export class NoopCompactionStrategy implements CompactionStrategy {
  readonly name = "off" as const;

  compact(request: CompactionRequest): CompactionResult {
    return {
      messages: request.messages,
      compacted: false,
      strategy: this.name,
      artifact: null,
      fallbackUsed: false
    };
  }
}

export class DeterministicCompactionStrategy implements CompactionStrategy {
  readonly name = "deterministic" as const;

  compact(request: CompactionRequest): CompactionResult {
    const window = compactionWindow(request);
    if (!window.shouldCompact) {
      return {
        messages: request.messages,
        compacted: false,
        strategy: this.name,
        artifact: null,
        fallbackUsed: false
      };
    }

    const artifact = createDeterministicCompactionArtifact(request);
    const summary: AgentMessage = {
      role: "user",
      content: summarizeMessages(
        window.compactedMessages,
        request.compactionSummaryChars ?? DEFAULT_COMPACTION_SUMMARY_CHARS
      )
    };

    return {
      messages: [...window.protectedMessages, summary, ...window.tailMessages],
      compacted: true,
      strategy: this.name,
      artifact,
      fallbackUsed: false
    };
  }
}

function formatArtifactSummary(artifact: CompactionArtifact, maxChars: number): string {
  const body = JSON.stringify(artifact, null, 2);
  return `${COMPACTION_MARKER}\n\nStructured compaction artifact:\n${truncateMiddle(body, Math.max(1, maxChars)).text}`;
}

export interface ModelSubSessionCompactionStrategyOptions {
  provider: ModelCompactionProvider;
  fallback?: CompactionFallbackMode;
}

export class ModelSubSessionCompactionStrategy implements CompactionStrategy {
  readonly name = "model_sub_session" as const;
  private readonly provider: ModelCompactionProvider;
  private readonly fallback: CompactionFallbackMode;
  private readonly deterministic = new DeterministicCompactionStrategy();

  constructor(providerOrOptions: ModelCompactionProvider | ModelSubSessionCompactionStrategyOptions) {
    if ("compact" in providerOrOptions) {
      this.provider = providerOrOptions;
      this.fallback = "deterministic";
    } else {
      this.provider = providerOrOptions.provider;
      this.fallback = providerOrOptions.fallback ?? "deterministic";
    }
  }

  async compact(request: CompactionRequest): Promise<CompactionResult> {
    const window = compactionWindow(request);
    if (!window.shouldCompact) {
      return {
        messages: request.messages,
        compacted: false,
        strategy: this.name,
        artifact: null,
        fallbackUsed: false
      };
    }

    const fallbackArtifact = createDeterministicCompactionArtifact(request);
    let artifact: CompactionArtifact;
    try {
      artifact = await this.provider.compact({
        ...request,
        protectedMessages: window.protectedMessages,
        compactedMessages: window.compactedMessages,
        tailMessages: window.tailMessages,
        fallbackArtifact
      });
    } catch (error) {
      const summary = compactErrorSummary(error);
      if (this.fallback === "fail") {
        throw new Error(`Model compaction failed: ${summary}`);
      }
      const fallbackResult = this.deterministic.compact(request);
      return {
        ...fallbackResult,
        strategy: this.name,
        artifact: fallbackResult.artifact ?? fallbackArtifact,
        fallbackUsed: true,
        error: summary
      };
    }
    const summary: AgentMessage = {
      role: "user",
      content: formatArtifactSummary(artifact, request.compactionSummaryChars ?? DEFAULT_COMPACTION_SUMMARY_CHARS)
    };

    return {
      messages: [...window.protectedMessages, summary, ...window.tailMessages],
      compacted: true,
      strategy: this.name,
      artifact,
      fallbackUsed: false
    };
  }
}

export interface CompactionServiceOptions {
  strategy?: CompactionStrategy;
  mode?: CompactionMode;
  modelProvider?: ModelCompactionProvider;
  fallback?: CompactionFallbackMode;
}

export class CompactionService {
  private readonly strategy: CompactionStrategy;

  constructor(options: CompactionServiceOptions = {}) {
    this.strategy = options.strategy ?? this.strategyFromOptions(options);
  }

  get strategyName(): CompactionStrategyName {
    return this.strategy.name;
  }

  async compact(request: CompactionRequest): Promise<CompactionResult> {
    return await this.strategy.compact(request);
  }

  private strategyFromOptions(options: CompactionServiceOptions): CompactionStrategy {
    if (options.mode === "off") return new NoopCompactionStrategy();
    if (options.mode === "model_sub_session") {
      if (!options.modelProvider) {
        throw new Error("model_sub_session compaction requires a modelProvider.");
      }
      return new ModelSubSessionCompactionStrategy({
        provider: options.modelProvider,
        fallback: options.fallback
      });
    }
    return new DeterministicCompactionStrategy();
  }
}
