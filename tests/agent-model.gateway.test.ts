import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "../packages/agent-protocol/src/index.js";
import { createModelGateway, OpenAIModelGateway, type OpenAIModelGatewayOptions } from "../packages/agent-model/src/index.js";

function request(): ModelRequest {
  return { messages: [{ role: "user", content: "hello" }], signal: new AbortController().signal };
}

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }), {
    status: 200,
    headers: { "content-type": "application/json", "retry-after": "0" }
  });
}

function streamResponse(frames: unknown[], done: boolean): Response {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "retry-after": "0" } });
}

function createGateway(fetchImpl: typeof fetch, options: Partial<OpenAIModelGatewayOptions> = {}): OpenAIModelGateway {
  return new OpenAIModelGateway({
    provider: "fake",
    model: "fake",
    baseUrl: "https://example.invalid",
    apiKey: "secret",
    apiKeyName: "FAKE_KEY",
    fetchImpl,
    ...options
  });
}

async function collectStream(model: ModelGateway, input: ModelRequest = request()): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of model.stream(input)) events.push(event);
  return events;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("OpenAI-compatible model gateway", () => {
  it("retries transport failures for non-streaming requests", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let attempts = 0;
    const gateway = createGateway((async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("connection reset");
      return jsonResponse("ok");
    }) as typeof fetch, { maxRetries: 2 });
    await expect(gateway.complete(request())).resolves.toMatchObject({ message: { content: "ok" }, finishReason: "stop" });
    expect(attempts).toBe(2);
  });

  it("serializes rich requests and normalizes tool calls, usage, and raw provider values", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const raw = {
      choices: [{
        message: {
          content: null,
          reasoning_content: "provider reasoning",
          tool_calls: [
            { id: "provided", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } },
            { function: { name: "opaque", arguments: "not-json" } },
            { id: "ignored", function: { arguments: "{}" } },
            null
          ]
        },
        finish_reason: "future_tool_reason"
      }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
      provider_meta: { finite: 1, infinite: Number.POSITIVE_INFINITY, unsupported: undefined, nested: [true] }
    };
    const model = createGateway((async (url, init) => {
      requestedUrl = String(url);
      requestedInit = init;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => raw
      } as Response;
    }) as typeof fetch, {
      baseUrl: "https://example.invalid/v1///",
      capabilities: { reasoning: false }
    });

    const response = await model.complete({
      messages: [
        {
          role: "assistant",
          content: "",
          reasoningContent: "prior reasoning",
          toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "a.ts" } }]
        },
        { role: "tool", content: "contents", toolCallId: "call_1" }
      ],
      tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
      toolChoice: "required",
      maxOutputTokens: 256,
      temperature: 0,
      signal: new AbortController().signal
    });

    expect(requestedUrl).toBe("https://example.invalid/v1/chat/completions");
    expect(requestedInit?.headers).toMatchObject({ Authorization: "Bearer secret", "Content-Type": "application/json" });
    expect(JSON.parse(String(requestedInit?.body))).toMatchObject({
      model: "fake",
      tool_choice: "required",
      max_tokens: 256,
      temperature: 0,
      tools: [{ type: "function", function: { name: "read_file" } }],
      messages: [
        {
          role: "assistant",
          reasoning_content: "prior reasoning",
          tool_calls: [{ id: "call_1", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }]
        },
        { role: "tool", tool_call_id: "call_1" }
      ]
    });
    expect(model.capabilities.reasoning).toBe(false);
    expect(response).toMatchObject({
      message: {
        content: "",
        reasoningContent: "provider reasoning",
        toolCalls: [
          { id: "provided", name: "read_file", arguments: { path: "a.ts" } },
          { id: "call_1", name: "opaque", arguments: "not-json" }
        ]
      },
      finishReason: "tool_calls",
      inputTokens: 12,
      outputTokens: 4,
      raw: { provider_meta: { finite: 1, infinite: null, unsupported: null, nested: [true] } }
    });
  });

  it("omits tool_choice for adapters that explicitly do not support it", async () => {
    let body: Record<string, unknown> | undefined;
    const gateway = createGateway((async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse("ok");
    }) as typeof fetch, { wireProfile: { supportsToolChoice: false } });

    await gateway.complete({
      messages: [{ role: "user", content: "use a tool" }],
      tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
      toolChoice: "required",
      signal: new AbortController().signal
    });

    expect(body).toMatchObject({
      tools: [{ type: "function", function: { name: "read_file" } }]
    });
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("adapts DeepSeek developer messages and replays reasoning across tool turns", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let attempt = 0;
    const gateway = createModelGateway({
      provider: "deepseek",
      apiKey: "secret",
      fetchImpl: (async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        attempt += 1;
        return attempt === 1
          ? streamResponse([
              { choices: [{ delta: { reasoning_content: "inspect first" }, finish_reason: null }] },
              {
                choices: [{
                  delta: {
                    tool_calls: [{
                      index: 0,
                      id: "call_1",
                      function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" }
                    }]
                  },
                  finish_reason: "tool_calls"
                }]
              }
            ], true)
          : streamResponse([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }], true);
      }) as typeof fetch
    });
    const tools = [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }];
    const initialMessages: ModelRequest["messages"] = [
      { role: "system", content: "system contract" },
      { role: "developer", content: "runtime context" },
      { role: "user", content: "read a.ts" }
    ];

    const first = await collectStream(gateway, {
      messages: initialMessages,
      tools,
      signal: new AbortController().signal
    });
    const firstDone = first.at(-1);
    expect(firstDone).toMatchObject({
      type: "done",
      response: {
        message: {
          reasoningContent: "inspect first",
          toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "a.ts" } }]
        },
        finishReason: "tool_calls"
      }
    });
    if (firstDone?.type !== "done") throw new Error("Expected the first DeepSeek stream to complete.");

    await collectStream(gateway, {
      messages: [
        ...initialMessages,
        firstDone.response.message,
        { role: "tool", content: "file contents", toolCallId: "call_1" }
      ],
      tools,
      toolChoice: "required",
      signal: new AbortController().signal
    });

    expect(bodies[0]).toMatchObject({
      model: "deepseek-v4-pro",
      thinking: { type: "enabled" },
      messages: [
        { role: "system", content: "system contract" },
        { role: "system", content: "runtime context" },
        { role: "user", content: "read a.ts" }
      ]
    });
    expect(bodies[0]).toMatchObject({ tool_choice: "auto" });
    expect(bodies[1]).toMatchObject({ tool_choice: "required" });
    expect(bodies[1]).toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({
        role: "assistant",
        content: "",
        reasoning_content: "inspect first",
        tool_calls: [expect.objectContaining({ id: "call_1" })]
      })])
    });
  });

  it("adapts GLM developer messages to the supported system wire role", async () => {
    let body: Record<string, unknown> | undefined;
    const gateway = createModelGateway({
      provider: "glm",
      apiKey: "secret",
      fetchImpl: (async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse("ok");
      }) as typeof fetch
    });

    await gateway.complete({
      messages: [
        { role: "system", content: "system contract" },
        { role: "developer", content: "runtime context" },
        { role: "user", content: "hello" }
      ],
      signal: new AbortController().signal
    });

    expect(body).toMatchObject({
      messages: [
        { role: "system", content: "system contract" },
        { role: "system", content: "runtime context" },
        { role: "user", content: "hello" }
      ]
    });
  });

  it("retries DeepSeek insufficient-system-resource finishes instead of returning protocol_error", async () => {
    let completionAttempts = 0;
    const completion = createModelGateway({
      provider: "deepseek",
      apiKey: "secret",
      maxRetries: 1,
      fetchImpl: (async () => {
        completionAttempts += 1;
        return completionAttempts === 1
          ? new Response(JSON.stringify({
              choices: [{ message: { content: "" }, finish_reason: "insufficient_system_resource" }]
            }), { status: 200, headers: { "retry-after": "0" } })
          : jsonResponse("recovered");
      }) as typeof fetch
    });
    await expect(completion.complete(request())).resolves.toMatchObject({
      message: { content: "recovered" },
      finishReason: "stop"
    });
    expect(completionAttempts).toBe(2);

    let streamAttempts = 0;
    const streaming = createModelGateway({
      provider: "deepseek",
      apiKey: "secret",
      maxRetries: 1,
      fetchImpl: (async () => {
        streamAttempts += 1;
        return streamAttempts === 1
          ? streamResponse([{ choices: [{ delta: {}, finish_reason: "insufficient_system_resource" }] }], true)
          : streamResponse([{ choices: [{ delta: { content: "recovered" }, finish_reason: "stop" }] }], true);
      }) as typeof fetch
    });
    await expect(collectStream(streaming)).resolves.toEqual([
      { type: "content", delta: "recovered" },
      expect.objectContaining({ type: "done", response: expect.objectContaining({ finishReason: "stop" }) })
    ]);
    expect(streamAttempts).toBe(2);
  });

  it("fails clearly when DeepSeek resource exhaustion exceeds the retry budget", async () => {
    const model = createModelGateway({
      provider: "deepseek",
      apiKey: "secret",
      maxRetries: 0,
      fetchImpl: (async () => streamResponse([
        { choices: [{ delta: {}, finish_reason: "insufficient_system_resource" }] }
      ], true)) as typeof fetch
    });

    await expect(collectStream(model)).rejects.toMatchObject({
      code: "provider_resource_exhausted",
      message: "deepseek returned retryable finish reason 'insufficient_system_resource'."
    });
  });

  it.each([
    ["length", "length"],
    ["content_filter", "content_filter"],
    ["future_reason", "protocol_error"],
    [null, "protocol_error"]
  ] as const)("maps provider finish reason %s to %s", async (providerReason, expected) => {
    const model = createGateway((async () => new Response(JSON.stringify({
      choices: [{ message: { content: "result" }, finish_reason: providerReason }]
    }), { status: 200 })) as typeof fetch);

    await expect(model.complete(request())).resolves.toMatchObject({ finishReason: expected });
  });

  it("honors an HTTP-date Retry-After header before retrying", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T00:00:00.000Z"));
    let attempts = 0;
    const retryAt = new Date(Date.now() + 2_000).toUTCString();
    const model = createGateway((async () => {
      attempts += 1;
      return attempts === 1
        ? new Response("busy", { status: 429, headers: { "retry-after": retryAt } })
        : jsonResponse("ok");
    }) as typeof fetch, { maxRetries: 1, requestTimeoutMs: 10_000 });

    const completion = model.complete(request());
    await vi.advanceTimersByTimeAsync(1_999);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(completion).resolves.toMatchObject({ message: { content: "ok" } });
    expect(attempts).toBe(2);
  });

  it("does not retry a non-retryable completion response", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad request", { status: 400 }));
    const model = createGateway(fetchImpl as typeof fetch, { maxRetries: 3 });

    await expect(model.complete(request())).rejects.toThrow("fake HTTP 400: bad request");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails both completion modes clearly when the API key is absent", async () => {
    const model = new OpenAIModelGateway({
      provider: "fake",
      model: "fake",
      baseUrl: "https://example.invalid",
      apiKeyName: "FAKE_KEY"
    });

    await expect(model.complete(request())).rejects.toThrow("Set FAKE_KEY");
    await expect(collectStream(model)).rejects.toThrow("Set FAKE_KEY");
  });

  it("counts mixed CJK and Latin input with the approximate tokenizer", async () => {
    const unusedFetch = (async () => { throw new Error("fetch should not be called"); }) as typeof fetch;
    const model = createGateway(unusedFetch);
    const empty = await model.countTokens([]);
    const mixed = await model.countTokens([{ role: "user", content: "中文abc" }], [
      { name: "lookup", description: "查询", inputSchema: { type: "object" } }
    ]);

    expect(mixed).toBeGreaterThan(empty);
  });

  it("keeps the deadline active while reading a response body", async () => {
    const gateway = createGateway((async (_url: string | URL | Request, init?: RequestInit) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })
    }) as Response) as typeof fetch, { maxRetries: 0, requestTimeoutMs: 25 });
    await expect(gateway.complete(request())).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("cancels a pending stream read when the idle timeout expires", async () => {
    let cancelled = 0;
    const gateway = createGateway((async () => new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled += 1; }
    }), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch, {
      maxRetries: 0,
      idleTimeoutMs: 25,
      requestTimeoutMs: 1_000
    });
    const consume = async (): Promise<void> => {
      for await (const _event of gateway.stream(request())) { /* wait for terminal failure */ }
    };
    await expect(consume()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(cancelled).toBeGreaterThan(0);
  });

  it("restarts a partial stream at a stable prefix without duplicate deltas", async () => {
    let attempts = 0;
    const gateway = createGateway((async () => {
      attempts += 1;
      return attempts === 1
        ? streamResponse([{ choices: [{ delta: { content: "hel" }, finish_reason: null }] }], false)
        : streamResponse([
            { choices: [{ delta: { content: "hel" }, finish_reason: null }] },
            { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] }
          ], true);
    }) as typeof fetch, { maxRetries: 3 });
    const events: ModelStreamEvent[] = [];
    for await (const event of gateway.stream(request())) events.push(event);
    expect(events.filter((event) => event.type === "content").map((event) => event.type === "content" ? event.delta : "")).toEqual(["hel", "lo"]);
    expect(events.at(-1)).toMatchObject({ type: "done", response: { message: { content: "hello" } } });
    expect(attempts).toBe(2);
  });

  it("emits reasoning and usage while treating an unknown streamed finish reason as a protocol error", async () => {
    const model = createGateway((async () => streamResponse([
      { usage: { prompt_tokens: 7 }, choices: [null] },
      { usage: { completion_tokens: 3 }, choices: [{ delta: { reasoning_content: "thinking" }, finish_reason: "future_reason" }] }
    ], true)) as typeof fetch);

    const events = await collectStream(model);
    expect(events).toEqual([
      { type: "usage", inputTokens: 7, outputTokens: undefined },
      { type: "usage", inputTokens: 7, outputTokens: 3 },
      { type: "reasoning", delta: "thinking" },
      expect.objectContaining({ type: "done", response: expect.objectContaining({ finishReason: "protocol_error" }) })
    ]);
  });

  it("retries retryable stream HTTP failures and rejects non-retryable ones", async () => {
    let retryableAttempts = 0;
    const retrying = createGateway((async () => {
      retryableAttempts += 1;
      return retryableAttempts === 1
        ? new Response("unavailable", { status: 503, headers: { "retry-after": "0" } })
        : streamResponse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }], true);
    }) as typeof fetch, { maxRetries: 1 });
    await expect(collectStream(retrying)).resolves.toEqual([
      { type: "content", delta: "ok" },
      expect.objectContaining({ type: "done" })
    ]);
    expect(retryableAttempts).toBe(2);

    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    const rejecting = createGateway(fetchImpl as typeof fetch, { maxRetries: 3 });
    await expect(collectStream(rejecting)).rejects.toThrow("fake stream HTTP 403: forbidden");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when a restarted stream diverges from the delivered prefix", async () => {
    let attempts = 0;
    const model = createGateway((async () => {
      attempts += 1;
      return attempts === 1
        ? streamResponse([{ choices: [{ delta: { content: "hello" }, finish_reason: null }] }], false)
        : streamResponse([{ choices: [{ delta: { content: "help" }, finish_reason: "stop" }] }], true);
    }) as typeof fetch, { maxRetries: 3 });

    await expect(collectStream(model)).rejects.toThrow("restarted stream diverged before the prior stable boundary");
    expect(attempts).toBe(2);
  });

  it("rejects a restarted stream that ends before the prior reasoning boundary", async () => {
    let attempts = 0;
    const model = createGateway((async () => {
      attempts += 1;
      return attempts === 1
        ? streamResponse([{ choices: [{ delta: { reasoning_content: "thinking" }, finish_reason: null }] }], false)
        : streamResponse([{ choices: [{ delta: { reasoning_content: "think" }, finish_reason: "stop" }] }], true);
    }) as typeof fetch, { maxRetries: 3 });

    await expect(collectStream(model)).rejects.toThrow(
      "restarted reasoning stream ended before the prior stable boundary"
    );
    expect(attempts).toBe(2);
  });

  it("aggregates interleaved tool calls by provider index", async () => {
    const gateway = createGateway((async () => streamResponse([
        { choices: [{ delta: { tool_calls: [{ index: 1, id: "b", function: { name: "second", arguments: "{\"b\":" } }, { index: 0, id: "a", function: { name: "first", arguments: "{\"a\":" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }, { index: 1, function: { arguments: "2}" } }] }, finish_reason: "tool_calls" }] }
      ], true)) as typeof fetch);
    const events: ModelStreamEvent[] = [];
    for await (const event of gateway.stream(request())) events.push(event);
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") expect(done.response.message.toolCalls).toEqual([
      { id: "a", name: "first", arguments: { a: 1 } },
      { id: "b", name: "second", arguments: { b: 2 } }
    ]);
  });
});
