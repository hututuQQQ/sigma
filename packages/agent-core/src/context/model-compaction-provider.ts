import type { AgentMessage, ModelClient, ModelRequest } from "agent-ai";
import { truncateMiddle } from "../compaction.js";
import { redactSecretText } from "../redaction.js";
import type { CompactionArtifact, ModelCompactionProvider, ModelCompactionRequest } from "./compaction-service.js";

const DEFAULT_MODEL_COMPACTION_MAX_INPUT_CHARS = 60000;
const DEFAULT_MODEL_COMPACTION_MAX_OUTPUT_CHARS = 8000;
const DEFAULT_MODEL_COMPACTION_TIMEOUT_SEC = 60;
const MESSAGE_FIELD_MAX_CHARS = 1800;

export interface ModelSubSessionCompactionProviderOptions {
  modelClient: ModelClient;
  maxInputChars?: number;
  maxOutputChars?: number;
  timeoutSec?: number;
  abortSignal?: AbortSignal;
}

interface SafeCompactionMessage {
  role: AgentMessage["role"];
  name?: string;
  toolCallId?: string;
  content?: string;
  reasoningContent?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
}

function clip(value: string | undefined, maxChars = MESSAGE_FIELD_MAX_CHARS): string | undefined {
  if (!value) return undefined;
  return truncateMiddle(redactSecretText(value), Math.max(1, maxChars)).text;
}

function jsonClip(value: unknown, maxChars = MESSAGE_FIELD_MAX_CHARS): string {
  return truncateMiddle(redactSecretText(JSON.stringify(value) ?? ""), Math.max(1, maxChars)).text;
}

function safeMessage(message: AgentMessage): SafeCompactionMessage {
  if (message.role === "assistant") {
    const content = clip(message.content);
    const reasoningContent = clip(message.reasoningContent);
    return {
      role: message.role,
      ...(content ? { content } : {}),
      ...(reasoningContent ? { reasoningContent } : {}),
      ...(message.toolCalls && message.toolCalls.length > 0
        ? {
            toolCalls: message.toolCalls.map((call) => ({
              id: call.id,
              name: call.function.name,
              arguments: jsonClip(call.function.arguments)
            }))
          }
        : {})
    };
  }

  if (message.role === "tool") {
    return {
      role: message.role,
      name: message.name,
      toolCallId: message.toolCallId,
      content: clip(message.content)
    };
  }

  return {
    role: message.role,
    content: clip(message.content)
  };
}

function safeMessages(messages: AgentMessage[], maxMessages = 80): SafeCompactionMessage[] {
  if (messages.length <= maxMessages) return messages.map(safeMessage);
  const head = messages.slice(0, 12);
  const tail = messages.slice(-(maxMessages - head.length));
  return [...head, ...tail].map(safeMessage);
}

function compactJson(value: unknown, maxChars: number): string {
  const json = JSON.stringify(value, null, 2);
  return truncateMiddle(redactSecretText(json), Math.max(1, maxChars)).text;
}

function stripMarkdownFence(value: string): string {
  const trimmed = value.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fence?.[1]?.trim() ?? trimmed;
}

function tryParseJsonObject(raw: string): unknown {
  const candidates: string[] = [];
  const stripped = stripMarkdownFence(raw);
  candidates.push(stripped);
  const firstBrace = stripped.indexOf("{");
  const lastBrace = stripped.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(stripped.slice(firstBrace, lastBrace + 1));
  }
  candidates.push(stripped.replace(/,\s*([}\]])/g, "$1"));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next lightweight repair candidate.
    }
  }
  throw new Error("Model compaction response was not valid JSON.");
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function artifactFromJson(parsed: unknown, fallback: CompactionArtifact): CompactionArtifact {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model compaction response JSON must be an object.");
  }
  const value = parsed as Record<string, unknown>;
  return {
    objective: typeof value.objective === "string" && value.objective.trim() ? value.objective.trim() : fallback.objective,
    current_plan: stringArray(value.current_plan),
    changed_files: stringArray(value.changed_files),
    key_decisions: stringArray(value.key_decisions),
    failed_attempts: stringArray(value.failed_attempts),
    validation_evidence: stringArray(value.validation_evidence),
    unresolved_questions: stringArray(value.unresolved_questions),
    next_actions: stringArray(value.next_actions)
  };
}

function buildPayload(request: ModelCompactionRequest, maxInputChars: number): string {
  const workflow = request.workflow;
  const payload = {
    objective: request.objective ?? request.fallbackArtifact.objective,
    workflow_summary: workflow ?? null,
    todos: request.todos ?? [],
    changed_files: request.changedFiles ?? workflow?.changed_files ?? [],
    evidence_records: (request.evidenceRecords ?? []).slice(-12),
    failure_patterns: workflow?.failure_patterns ?? [],
    compacted_message_history: safeMessages(request.compactedMessages),
    retained_tail_summary: safeMessages(request.tailMessages, 24),
    fallback_artifact_shape: request.fallbackArtifact
  };
  return compactJson(payload, maxInputChars);
}

function timeoutSignal(timeoutSec: number, upstream?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Model compaction timed out.")), timeoutSec * 1000);
  const onAbort = () => controller.abort(upstream?.reason ?? new Error("Model compaction aborted."));
  if (upstream?.aborted) onAbort();
  upstream?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      upstream?.removeEventListener("abort", onAbort);
    }
  };
}

export class ModelSubSessionCompactionProvider implements ModelCompactionProvider {
  private readonly modelClient: ModelClient;
  private readonly maxInputChars: number;
  private readonly maxOutputChars: number;
  private readonly timeoutSec: number;
  private readonly abortSignal?: AbortSignal;

  constructor(options: ModelSubSessionCompactionProviderOptions) {
    this.modelClient = options.modelClient;
    this.maxInputChars = options.maxInputChars ?? DEFAULT_MODEL_COMPACTION_MAX_INPUT_CHARS;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MODEL_COMPACTION_MAX_OUTPUT_CHARS;
    this.timeoutSec = options.timeoutSec ?? DEFAULT_MODEL_COMPACTION_TIMEOUT_SEC;
    this.abortSignal = options.abortSignal;
  }

  async compact(request: ModelCompactionRequest): Promise<CompactionArtifact> {
    const payload = buildPayload(request, this.maxInputChars);
    const { signal, dispose } = timeoutSignal(this.timeoutSec, this.abortSignal);
    const modelRequest: ModelRequest = {
      messages: [
        {
          role: "system",
          content: [
            "You compact an autonomous coding agent conversation into durable JSON.",
            "Return only a JSON object with these keys:",
            "objective, current_plan, changed_files, key_decisions, failed_attempts, validation_evidence, unresolved_questions, next_actions.",
            "Each key except objective must be an array of concise strings.",
            "Do not call tools. Do not include secrets, credentials, or raw large tool output."
          ].join("\n")
        },
        { role: "user", content: payload }
      ],
      tools: [],
      toolChoice: "none",
      maxTokens: Math.max(256, Math.ceil(this.maxOutputChars / 4)),
      temperature: 0,
      abortSignal: signal
    };

    try {
      const response = await this.modelClient.complete(modelRequest);
      const content = response.message.content ?? "";
      const clipped = truncateMiddle(content, Math.max(1, this.maxOutputChars)).text;
      return artifactFromJson(tryParseJsonObject(clipped), request.fallbackArtifact);
    } finally {
      dispose();
    }
  }
}

export {
  DEFAULT_MODEL_COMPACTION_MAX_INPUT_CHARS,
  DEFAULT_MODEL_COMPACTION_MAX_OUTPUT_CHARS,
  DEFAULT_MODEL_COMPACTION_TIMEOUT_SEC
};
