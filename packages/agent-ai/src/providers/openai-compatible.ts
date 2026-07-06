import type { AssistantMessage, ModelClient, ModelRequest, ModelResponse, ProviderName } from "../types.js";
import { normalizeAssistantMessage, toOpenAIMessages } from "../normalize/messages.js";
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

    const raw = await this.postWithRetry(body);
    const response = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const choices = Array.isArray(response.choices) ? response.choices : [];
    const firstChoice = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : {};
    const message: AssistantMessage = normalizeAssistantMessage(firstChoice.message);
    const usage = normalizeUsage(response.usage);

    return { message, usage, raw };
  }

  private async postWithRetry(body: Record<string, unknown>): Promise<unknown> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
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
