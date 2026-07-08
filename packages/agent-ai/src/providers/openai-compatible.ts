import type { AssistantMessage, ModelClient, ModelEvent, ModelRequest, ModelResponse, ProviderName, ToolCall } from "../types.js";
import { normalizeAssistantMessage, toOpenAIMessages } from "../normalize/messages.js";
import { parseToolArguments } from "../normalize/tool-calls.js";
import { normalizeUsage } from "../normalize/usage.js";

export interface OpenAICompatibleProviderOptions {
  provider: ProviderName;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnvName: string;
  model: string;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateErrorBody(body: string): string {
  return body.length > 800 ? `${body.slice(0, 800)}...` : body;
}

async function *readSsePayloads(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data:")) yield trimmed.slice(5).trim();
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    for (const line of buffer.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) yield trimmed.slice(5).trim();
    }
  } finally {
    reader.releaseLock();
  }
}

export class OpenAICompatibleProvider implements ModelClient {
  readonly provider: ProviderName;
  readonly model: string;

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly apiKeyEnvName: string;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.apiKeyEnvName = options.apiKeyEnvName;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    if (!this.apiKey) {
      throw new Error(`${this.provider} API key is missing. Set ${this.apiKeyEnvName} or pass an apiKey explicitly.`);
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAIMessages(req.messages)
    };

    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
      body.tool_choice = req.toolChoice ?? "auto";
    } else if (req.toolChoice === "none") {
      body.tool_choice = "none";
    }

    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.reasoning?.enabled) {
      body.reasoning_effort = req.reasoning.effort ?? "high";
    }

    const raw = await this.postWithRetry(body, req.abortSignal);
    const response = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const choices = Array.isArray(response.choices) ? response.choices : [];
    const firstChoice = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : {};
    const message: AssistantMessage = normalizeAssistantMessage(firstChoice.message);
    const usage = normalizeUsage(response.usage);

    return { message, usage, raw };
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
    if (!this.apiKey) {
      throw new Error(`${this.provider} API key is missing. Set ${this.apiKeyEnvName} or pass an apiKey explicitly.`);
    }
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAIMessages(req.messages),
      stream: true,
      stream_options: { include_usage: true }
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
      body.tool_choice = req.toolChoice ?? "auto";
    } else if (req.toolChoice === "none") {
      body.tool_choice = "none";
    }
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.reasoning?.enabled) body.reasoning_effort = req.reasoning.effort ?? "high";

    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: req.abortSignal
    });
    if (!response.ok) {
      throw new Error(`${this.provider} API stream failed with HTTP ${response.status}: ${truncateErrorBody(await response.text())}`);
    }
    if (!response.body) {
      throw new Error(`${this.provider} API stream response had no body`);
    }

    const toolCalls = new Map<number, { id?: string; name?: string; arguments: string }>();
    for await (const payload of readSsePayloads(response.body)) {
      if (payload === "[DONE]") {
        yield { type: "done" };
        return;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(payload) as Record<string, unknown>;
      } catch (error) {
        yield { type: "error", data: { message: error instanceof Error ? error.message : String(error) } };
        continue;
      }
      const usage = normalizeUsage(parsed.usage);
      const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
      for (const choice of choices) {
        const choiceRecord = choice && typeof choice === "object" ? choice as Record<string, unknown> : {};
        const delta = choiceRecord.delta && typeof choiceRecord.delta === "object"
          ? choiceRecord.delta as Record<string, unknown>
          : {};
        const content = typeof delta.content === "string" ? delta.content : "";
        if (content) yield { type: "message_delta", data: { delta: content } };
        const reasoning = typeof delta.reasoning_content === "string"
          ? delta.reasoning_content
          : typeof delta.reasoningContent === "string"
            ? delta.reasoningContent
            : "";
        if (reasoning) yield { type: "reasoning_delta", data: { delta: reasoning } };
        const deltaToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (const raw of deltaToolCalls) {
          const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
          const index = typeof item.index === "number" ? item.index : toolCalls.size;
          const fn = item.function && typeof item.function === "object" ? item.function as Record<string, unknown> : {};
          const current = toolCalls.get(index) ?? { arguments: "" };
          if (typeof item.id === "string") current.id = item.id;
          if (typeof fn.name === "string") current.name = fn.name;
          if (typeof fn.arguments === "string") current.arguments += fn.arguments;
          toolCalls.set(index, current);
          if (current.name) {
            const toolCall: ToolCall = {
              id: current.id ?? `call_${index}`,
              type: "function",
              function: {
                name: current.name,
                arguments: parseToolArguments(current.arguments)
              }
            };
            yield { type: "tool_call_delta", data: { index, delta: item, toolCall } };
          }
        }
      }
      if (usage) yield { type: "usage", data: usage };
    }
    yield { type: "done" };
  }

  private async postWithRetry(body: Record<string, unknown>, abortSignal?: AbortSignal): Promise<unknown> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body),
          signal: abortSignal
        });

        if (response.ok) {
          return (await response.json()) as unknown;
        }

        const responseText = await response.text();
        const retryable = response.status === 429 || response.status >= 500;
        const message = `${this.provider} API request failed with HTTP ${response.status}: ${truncateErrorBody(responseText)}`;
        if (!retryable || attempt === this.maxRetries) {
          throw new Error(message);
        }
        lastError = new Error(message);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (abortSignal?.aborted || lastError.name === "AbortError") {
          throw lastError;
        }
        if (attempt === this.maxRetries) {
          throw lastError;
        }
      }

      const delayMs = 500 * 2 ** attempt;
      await sleep(delayMs);
    }

    throw lastError ?? new Error(`${this.provider} API request failed`);
  }
}
