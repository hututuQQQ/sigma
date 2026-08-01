import { describe, expect, it } from "vitest";
import {
  PiModelGateway,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model as PiModel,
  type Models
} from "../packages/agent-pi/src/index.js";
import type {
  JsonValue,
  ModelMessage,
  ModelRequest
} from "../packages/agent-protocol/src/index.js";

const apiFamilies = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "google-generative-ai",
  "bedrock-converse-stream",
  "mistral-conversations",
  "pi-messages"
] as const satisfies readonly Api[];

interface CapturedCall {
  context: Context;
  options: Record<string, unknown>;
}

function contractModel(api: Api): PiModel<Api> {
  const provider = api === "openai-codex-responses"
    ? "openai-codex"
    : `contract-${api}`;
  return {
    id: `model-${api}`,
    name: `Contract ${api}`,
    api,
    provider,
    baseUrl: "https://provider.example.test/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1,
      output: 2,
      cacheRead: 0.5,
      cacheWrite: 0.75
    },
    contextWindow: 128_000,
    maxTokens: 16_384
  };
}

function completedMessage(model: PiModel<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: "Use both tools.",
        thinkingSignature: "opaque-output-reasoning"
      },
      { type: "text", text: "Running both tools." },
      {
        type: "toolCall",
        id: "call_read",
        name: "read_file",
        arguments: { path: "README.md" },
        thoughtSignature: "opaque-read-signature"
      },
      {
        type: "toolCall",
        id: "call_search",
        name: "search_files",
        arguments: { query: "agent-pi" },
        thoughtSignature: "opaque-search-signature"
      }
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    responseId: `response-${model.api}`,
    usage: {
      input: 11,
      output: 7,
      cacheRead: 3,
      cacheWrite: 2,
      reasoning: 4,
      totalTokens: 23,
      cost: {
        input: 0.000_011,
        output: 0.000_014,
        cacheRead: 0.000_001_5,
        cacheWrite: 0.000_001_5,
        total: 0.000_028
      }
    },
    stopReason: "toolUse",
    timestamp: Date.now()
  };
}

async function* completedEvents(
  message: AssistantMessage
): AsyncIterable<AssistantMessageEvent> {
  yield { type: "start", partial: message };
  yield {
    type: "thinking_delta",
    contentIndex: 0,
    delta: "Use both tools.",
    partial: message
  };
  yield {
    type: "text_delta",
    contentIndex: 1,
    delta: "Running both tools.",
    partial: message
  };
  yield {
    type: "toolcall_end",
    contentIndex: 2,
    toolCall: message.content[2] as Extract<
      AssistantMessage["content"][number],
      { type: "toolCall" }
    >,
    partial: message
  };
  yield {
    type: "toolcall_end",
    contentIndex: 3,
    toolCall: message.content[3] as Extract<
      AssistantMessage["content"][number],
      { type: "toolCall" }
    >,
    partial: message
  };
  yield { type: "done", reason: "toolUse", message };
}

function contractModels(
  model: PiModel<Api>,
  captured: CapturedCall[]
): Models {
  return {
    getProviders: () => [],
    getProvider: () => undefined,
    getModels: () => [model],
    getModel: (provider, id) =>
      provider === model.provider && id === model.id ? model : undefined,
    refresh: async () => ({ refreshed: [], errors: [] }) as never,
    checkAuth: async () => ({
      type: model.provider === "openai-codex" ? "oauth" : "api_key",
      source: "contract-test"
    }) as never,
    getAvailable: async () => [model],
    getAuth: async () => undefined,
    login: async () => {
      throw new Error("Contract gateway must not start interactive authentication.");
    },
    logout: async () => undefined,
    stream: (_model, context, options) => {
      captured.push({
        context,
        options: options as unknown as Record<string, unknown>
      });
      return completedEvents(completedMessage(model)) as never;
    },
    complete: async () => completedMessage(model),
    streamSimple: () => completedEvents(completedMessage(model)) as never,
    completeSimple: async () => completedMessage(model)
  };
}

function replayMessages(model: PiModel<Api>): ModelMessage[] {
  const replayContent: JsonValue = [
    {
      type: "thinking",
      thinking: "Prior reasoning.",
      thinkingSignature: "opaque-prior-reasoning"
    },
    { type: "text", text: "I need two results." },
    {
      type: "toolCall",
      id: "prior_read",
      name: "read_file",
      arguments: { path: "package.json" },
      thoughtSignature: "opaque-prior-tool"
    },
    {
      type: "toolCall",
      id: "prior_search",
      name: "search_files",
      arguments: { query: "gateway" }
    }
  ];
  return [
    { role: "system", content: "System policy." },
    { role: "developer", content: "Developer policy." },
    { role: "user", content: "Inspect the repository." },
    {
      role: "assistant",
      content: "I need two results.",
      reasoningContent: "Prior reasoning.",
      toolCalls: [
        {
          id: "prior_read",
          name: "read_file",
          arguments: { path: "package.json" }
        },
        {
          id: "prior_search",
          name: "search_files",
          arguments: { query: "gateway" }
        }
      ],
      providerState: {
        provider: model.provider,
        version: 1,
        data: {
          api: model.api,
          model: model.id,
          responseId: "prior-response",
          content: replayContent
        }
      }
    },
    {
      role: "tool",
      content: "package metadata",
      toolCallId: "prior_read"
    },
    {
      role: "tool",
      content: "gateway matches",
      toolCallId: "prior_search"
    },
    { role: "user", content: "Continue." }
  ];
}

function request(model: PiModel<Api>): ModelRequest {
  return {
    messages: replayMessages(model),
    tools: [
      {
        name: "read_file",
        description: "Read one file.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"]
        }
      },
      {
        name: "search_files",
        description: "Search workspace files.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"]
        }
      }
    ],
    toolChoice: "auto",
    maxOutputTokens: 4_096,
    signal: new AbortController().signal
  };
}

describe.each(apiFamilies)("Pi %s API family contract", (api) => {
  it("preserves roles, parallel tools, opaque replay, usage, and retry ownership", async () => {
    const model = contractModel(api);
    const captured: CapturedCall[] = [];
    const gateway = new PiModelGateway({
      provider: model.provider,
      model: model.id,
      models: contractModels(model, captured),
      reasoningEffort: "high"
    });

    const response = await gateway.complete(request(model));

    expect(response).toMatchObject({
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: "Running both tools.",
        reasoningContent: "Use both tools.",
        toolCalls: [
          { id: "call_read", name: "read_file", arguments: { path: "README.md" } },
          { id: "call_search", name: "search_files", arguments: { query: "agent-pi" } }
        ],
        providerState: {
          provider: model.provider,
          version: 1,
          data: {
            api,
            model: model.id,
            responseId: `response-${api}`
          }
        }
      },
      usage: {
        inputTokens: 16,
        outputTokens: 7,
        reasoningTokens: 4,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        billingMode: api === "openai-codex-responses" ? "subscription" : "metered"
      }
    });
    expect(response.message.providerState?.data).toMatchObject({
      content: expect.arrayContaining([
        expect.objectContaining({ thinkingSignature: "opaque-output-reasoning" }),
        expect.objectContaining({ thoughtSignature: "opaque-read-signature" })
      ])
    });
    expect(response.usage.costMicroUsd).toBe(
      api === "openai-codex-responses" ? null : 28
    );

    expect(captured).toHaveLength(1);
    const call = captured[0]!;
    expect(call.context.systemPrompt).toBe(
      "<system>\nSystem policy.\n</system>\n\n"
      + "<developer>\nDeveloper policy.\n</developer>"
    );
    expect(call.context.tools?.map((tool) => tool.name)).toEqual([
      "read_file",
      "search_files"
    ]);
    expect(call.context.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "user"
    ]);
    const replay = call.context.messages[1] as AssistantMessage;
    expect(replay).toMatchObject({
      api,
      provider: model.provider,
      model: model.id,
      responseId: "prior-response"
    });
    expect(replay.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ thinkingSignature: "opaque-prior-reasoning" }),
      expect.objectContaining({ thoughtSignature: "opaque-prior-tool" })
    ]));
    expect(call.options.maxRetries).toBe(0);
    expect(call.options.maxTokens).toBe(api === "anthropic-messages" ? 16_384 : 4_096);
    expect(call.options.signal).toBeInstanceOf(AbortSignal);
    expect(call.options.toolChoice).toBe("auto");
    expect(call.options.transport).toBe(
      api === "openai-codex-responses" ? "auto" : undefined
    );
    const expectedReasoningOptions: Record<
      (typeof apiFamilies)[number],
      Record<string, unknown>
    > = {
      "openai-completions": { reasoningEffort: "high" },
      "openai-responses": { reasoningEffort: "high" },
      "openai-codex-responses": { reasoningEffort: "high" },
      "anthropic-messages": {
        thinkingEnabled: true,
        thinkingBudgetTokens: 15_360
      },
      "google-generative-ai": {
        thinking: { enabled: true, budgetTokens: -1 }
      },
      "bedrock-converse-stream": { reasoning: "high" },
      "mistral-conversations": { promptMode: "reasoning" },
      "pi-messages": { reasoning: "high" }
    };
    expect(call.options).toMatchObject(expectedReasoningOptions[api]);
  });
});

describe("Pi Codex cache-preserving instruction projection", () => {
  it("keeps dynamic developer context at the input suffix and restores its wire role", async () => {
    const model = contractModel("openai-codex-responses");
    const captured: CapturedCall[] = [];
    const gateway = new PiModelGateway({
      provider: model.provider,
      model: model.id,
      models: contractModels(model, captured)
    });
    const modelRequest = request(model);
    modelRequest.messages.push({
      role: "developer",
      content: "Use the latest durable runtime state."
    });

    await gateway.complete(modelRequest);

    const call = captured[0]!;
    expect(call.context.systemPrompt).not.toContain("latest durable runtime state");
    const suffix = call.context.messages.at(-1);
    expect(suffix).toMatchObject({ role: "user" });
    const onPayload = call.options.onPayload as (
      payload: unknown,
      model: PiModel<Api>
    ) => unknown;
    const transformed = onPayload({
      input: [{
        role: "user",
        content: [{ type: "input_text", text: (suffix as { content: string }).content }]
      }]
    }, model) as {
      input: Array<{ role: string; content: Array<{ text: string }> }>;
    };
    expect(transformed.input).toEqual([{
      role: "developer",
      content: [{
        type: "input_text",
        text: "Use the latest durable runtime state."
      }]
    }]);
  });
});

describe("Pi token-budget reasoning adapters", () => {
  it("reserves the selected thinking budget for non-adaptive Claude on Bedrock", async () => {
    const model = {
      ...contractModel("bedrock-converse-stream"),
      id: "anthropic.claude-sonnet-3-7",
      name: "Claude Sonnet 3.7"
    };
    const captured: CapturedCall[] = [];
    const gateway = new PiModelGateway({
      provider: model.provider,
      model: model.id,
      models: contractModels(model, captured),
      reasoningEffort: "high"
    });

    await gateway.complete(request(model));

    expect(captured[0]?.options).toMatchObject({
      maxTokens: 16_384,
      reasoning: "high",
      thinkingBudgets: { high: 15_360 },
      toolChoice: "auto"
    });
  });
});
