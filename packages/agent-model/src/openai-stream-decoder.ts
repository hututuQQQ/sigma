import type { ModelStreamEvent, ModelToolCall } from "agent-protocol";
import { normalizedFinishReason, parseArguments, providerFinishError } from "./openai-wire.js";
import type { RawUsage, UnnormalizedModelResponse } from "./usage.js";

export type RawDoneStreamEvent = { type: "done"; response: UnnormalizedModelResponse };

export interface StreamProgress {
  deliveredContent: string;
  deliveredReasoning: string;
}

export interface StreamAttemptStatus {
  semantic: boolean;
  retryAllowed: boolean;
  retryAfter: string | null;
  httpStatus?: number;
  doneReceived: boolean;
  lastEventType: string;
  hasContent: boolean;
  hasReasoning: boolean;
  hasToolCall: boolean;
}

interface StreamCallParts {
  id?: string;
  name?: string;
  arguments: string;
}

function finalizeCalls(calls: Map<number, StreamCallParts>): ModelToolCall[] {
  return [...calls.entries()].sort(([left], [right]) => left - right).flatMap(([index, call]): ModelToolCall[] => call.name
    ? [{ id: call.id ?? `call_${index}`, name: call.name, arguments: parseArguments(call.arguments) }]
    : []);
}

export class StreamDecoder {
  private readonly calls = new Map<number, StreamCallParts>();
  private content = "";
  private reasoningContent = "";
  private reasoningObserved = false;
  private inputTokens: number | undefined;
  private outputTokens: number | undefined;
  private reasoningTokens: number | undefined;
  private cacheReadTokens: number | undefined;
  private cacheWriteTokens: number | undefined;
  private finish: unknown;

  constructor(
    private readonly provider: string,
    private readonly progress: StreamProgress,
    private readonly status: StreamAttemptStatus,
    private readonly retryableFinishReasons: ReadonlySet<string>
  ) {}

  consume(payload: string): ModelStreamEvent[] {
    const chunk = JSON.parse(payload) as Record<string, unknown>;
    const events = this.consumeUsage(chunk);
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices) events.push(...this.consumeChoice(choice));
    return events;
  }

  done(): RawDoneStreamEvent {
    const calls = finalizeCalls(this.calls);
    this.assertStableBoundary();
    if (typeof this.finish === "string" && this.retryableFinishReasons.has(this.finish)) {
      throw providerFinishError(this.provider, this.finish);
    }
    return { type: "done", response: {
      message: {
        role: "assistant",
        content: this.content,
        ...(this.reasoningObserved ? { reasoningContent: this.reasoningContent } : {}),
        ...(calls.length ? { toolCalls: calls } : {})
      },
      finishReason: normalizedFinishReason(this.finish, calls.length > 0),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens
    } };
  }

  rawUsage(): RawUsage {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      reasoningTokens: this.reasoningTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens
    };
  }

  private assertStableBoundary(): void {
    if (this.content !== this.progress.deliveredContent) {
      this.status.retryAllowed = false;
      throw new Error(`${this.provider} restarted stream ended before the prior stable boundary.`);
    }
    if (this.reasoningContent !== this.progress.deliveredReasoning) {
      this.status.retryAllowed = false;
      throw new Error(`${this.provider} restarted reasoning stream ended before the prior stable boundary.`);
    }
  }

  private consumeUsage(chunk: Record<string, unknown>): ModelStreamEvent[] {
    const usage = chunk.usage && typeof chunk.usage === "object" ? chunk.usage as Record<string, unknown> : {};
    const hasInput = typeof usage.prompt_tokens === "number";
    const hasOutput = typeof usage.completion_tokens === "number";
    const inputDetails = objectOrEmpty(usage.prompt_tokens_details);
    const outputDetails = objectOrEmpty(usage.completion_tokens_details);
    if (!hasInput && !hasOutput) return [];
    this.inputTokens = hasInput ? usage.prompt_tokens as number : this.inputTokens;
    this.outputTokens = hasOutput ? usage.completion_tokens as number : this.outputTokens;
    this.reasoningTokens = numberOrPrevious(outputDetails.reasoning_tokens, this.reasoningTokens);
    this.cacheReadTokens = numberOrPrevious(inputDetails.cached_tokens, this.cacheReadTokens);
    this.cacheWriteTokens = numberOrPrevious(inputDetails.cache_creation_tokens, this.cacheWriteTokens);
    return [{ type: "usage", inputTokens: this.inputTokens, outputTokens: this.outputTokens }];
  }

  private consumeChoice(value: unknown): ModelStreamEvent[] {
    const choice = value && typeof value === "object" ? value as Record<string, unknown> : {};
    if (choice.finish_reason !== undefined) this.finish = choice.finish_reason;
    const delta = choice.delta && typeof choice.delta === "object" ? choice.delta as Record<string, unknown> : {};
    return [
      ...this.consumeText("content", delta.content),
      ...this.consumeText("reasoning", delta.reasoning_content),
      ...this.consumeToolCalls(delta.tool_calls)
    ];
  }

  private consumeText(kind: "content" | "reasoning", value: unknown): ModelStreamEvent[] {
    if (kind === "reasoning" && typeof value === "string") this.reasoningObserved = true;
    if (typeof value !== "string" || !value) return [];
    this.status.lastEventType = kind;
    const current = kind === "content" ? this.content + value : this.reasoningContent + value;
    const delivered = kind === "content" ? this.progress.deliveredContent : this.progress.deliveredReasoning;
    if (!delivered.startsWith(current) && !current.startsWith(delivered)) {
      this.status.retryAllowed = false;
      const label = kind === "reasoning" ? " reasoning" : "";
      throw new Error(`${this.provider} restarted${label} stream diverged before the prior stable boundary.`);
    }
    if (kind === "content") this.content = current; else this.reasoningContent = current;
    if (kind === "content") this.status.hasContent = true; else this.status.hasReasoning = true;
    if (current.length <= delivered.length) return [];
    const delta = current.slice(delivered.length);
    if (kind === "content") this.progress.deliveredContent = current; else this.progress.deliveredReasoning = current;
    this.status.semantic = true;
    return [kind === "content" ? { type: "content", delta } : { type: "reasoning", delta }];
  }

  private consumeToolCalls(value: unknown): ModelStreamEvent[] {
    const events: ModelStreamEvent[] = [];
    for (const raw of Array.isArray(value) ? value : []) {
      const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const index = typeof item.index === "number" ? item.index : this.calls.size;
      const fn = item.function && typeof item.function === "object" ? item.function as Record<string, unknown> : {};
      const current = this.calls.get(index) ?? { arguments: "" };
      if (typeof item.id === "string") current.id = item.id;
      if (typeof fn.name === "string") current.name = fn.name;
      if (typeof fn.arguments === "string") current.arguments += fn.arguments;
      this.calls.set(index, current);
      if (!current.name) continue;
      this.status.semantic = true;
      this.status.hasToolCall = true;
      // Tool-call deltas do not have the stable-prefix replay contract used for
      // text, so replaying them could execute a duplicated or partial call.
      this.status.retryAllowed = false;
      events.push({ type: "tool_call", index, call: {
        id: current.id ?? `call_${index}`,
        name: current.name,
        arguments: parseArguments(current.arguments)
      } });
    }
    return events;
  }
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberOrPrevious(value: unknown, previous: number | undefined): number | undefined {
  return typeof value === "number" ? value : previous;
}
