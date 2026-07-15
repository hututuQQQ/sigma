import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "../packages/agent-protocol/src/index.js";
import {
  checkProviderHealth,
  createModelGateway,
  createSseStreamState,
  OpenAIModelGateway,
  ssePayloads,
  type OpenAIModelGatewayOptions
} from "../packages/agent-model/src/index.js";

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
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("OpenAI-compatible model gateway", () => {
  it("parses split CRLF and multi-line SSE frames without losing the terminal payload", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      "data: first\r",
      "\ndata: second\r\n\r",
      "\ndata: [DO",
      "NE]"
    ].map((value) => encoder.encode(value));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      }
    });
    const state = createSseStreamState();
    const payloads: string[] = [];
    for await (const payload of ssePayloads(body, new AbortController().signal, 1_000, state)) {
      payloads.push(payload);
    }

    expect(payloads).toEqual(["first\nsecond", "[DONE]"]);
    expect(state).toMatchObject({
      chunksRead: 4,
      framesRead: 2,
      dataPayloads: 2,
      transportEnded: true
    });
  });

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

  it("maps the legacy unsupported-tool-choice flag and rejects strict choices before fetch", async () => {
    let fetchCalls = 0;
    const gateway = createGateway((async () => {
      fetchCalls += 1;
      return jsonResponse("ok");
    }) as typeof fetch, { wireProfile: { supportsToolChoice: false } });

    await expect(gateway.complete({
      messages: [{ role: "user", content: "use a tool" }],
      tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
      toolChoice: "required",
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      category: "configuration",
      message: "OpenAI wire profile cannot honor toolChoice='required'."
    });
    expect(fetchCalls).toBe(0);
  });

  it("keeps the legacy supported-tool-choice flag equivalent to the always policy", async () => {
    let body: Record<string, unknown> | undefined;
    const gateway = createGateway((async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse("ok");
    }) as typeof fetch, { wireProfile: { supportsToolChoice: true } });

    await gateway.complete({
      messages: [{ role: "user", content: "use a tool" }],
      tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
      toolChoice: "required",
      signal: new AbortController().signal
    });

    expect(body).toMatchObject({ tool_choice: "required" });
  });

  it("rejects strict choices under the canonical never policy before fetch", async () => {
    let fetchCalls = 0;
    const gateway = createGateway((async () => {
      fetchCalls += 1;
      return jsonResponse("ok");
    }) as typeof fetch, { wireProfile: { toolChoicePolicy: "never" } });

    await expect(gateway.complete({
      messages: [{ role: "user", content: "do not use a tool" }],
      tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
      toolChoice: "none",
      signal: new AbortController().signal
    })).rejects.toMatchObject({ category: "configuration" });
    expect(fetchCalls).toBe(0);
  });

  it("rejects conflicting legacy and canonical tool-choice settings", () => {
    expect(() => createGateway((async () => jsonResponse("ok")) as typeof fetch, {
      wireProfile: { supportsToolChoice: true, toolChoicePolicy: "never" }
    })).toThrow(/conflicting tool choice settings/u);
  });

  it("requires a thinking mode for the non-thinking-only policy", () => {
    expect(() => createGateway((async () => jsonResponse("ok")) as typeof fetch, {
      wireProfile: { toolChoicePolicy: "non_thinking_only" }
    })).toThrow(/requires a thinking mode/u);
  });

  it("rejects required tool choice without a tool definition before fetch", async () => {
    let fetchCalls = 0;
    const gateway = createGateway((async () => {
      fetchCalls += 1;
      return jsonResponse("ok");
    }) as typeof fetch);

    await expect(gateway.complete({
      messages: [{ role: "user", content: "use a tool" }],
      toolChoice: "required",
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      category: "configuration",
      message: "toolChoice='required' requires at least one tool definition."
    });
    expect(fetchCalls).toBe(0);
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

    await collectStream(gateway, {
      messages: [
        ...initialMessages,
        firstDone.response.message,
        { role: "tool", content: "tool failed: file was unavailable", toolCallId: "call_1" }
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
    expect(bodies[0]).not.toHaveProperty("tool_choice");
    expect(bodies[1]).toMatchObject({
      thinking: { type: "disabled" },
      tool_choice: "required"
    });
    expect(bodies[2]).toMatchObject({
      thinking: { type: "disabled" },
      tool_choice: "required"
    });
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
      tool_choice: "none",
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

  it("bounds a fetch implementation that never resolves", async () => {
    const startedAt = performance.now();
    const gateway = createGateway((async () => await new Promise<Response>(() => undefined)) as typeof fetch, {
      maxRetries: 3,
      requestTimeoutMs: 25
    });
    await expect(gateway.complete(request())).rejects.toMatchObject({
      name: "TimeoutError",
      category: "timeout"
    });
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it("honors a parent run abort before the model deadline", async () => {
    const controller = new AbortController();
    const reason = new Error("parent run deadline");
    const gateway = createGateway((async () => await new Promise<Response>(() => undefined)) as typeof fetch, {
      requestTimeoutMs: 1_000,
      maxRetries: 3
    });
    const pending = gateway.complete({ ...request(), signal: controller.signal });
    setTimeout(() => controller.abort(reason), 20);
    await expect(pending).rejects.toBe(reason);
  });

  it("returns structured provider health without exposing credentials", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "health-secret");
    const result = await checkProviderHealth({
      provider: "deepseek",
      model: "auto",
      signal: new AbortController().signal,
      requestTimeoutMs: 25,
      fetchImpl: (async () => await new Promise<Response>(() => undefined)) as typeof fetch
    });
    expect(result).toMatchObject({
      ok: false,
      provider: "deepseek",
      model: "deepseek-v4-pro",
      endpointHost: "api.deepseek.com",
      failureKind: "network_error",
      errorCategory: "timeout"
    });
    expect(JSON.stringify(result)).not.toContain("health-secret");
  });

  it("uses a non-thinking health probe with a bounded text budget", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "health-secret");
    let body: Record<string, unknown> | undefined;
    const result = await checkProviderHealth({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      signal: new AbortController().signal,
      fetchImpl: (async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse("OK");
      }) as typeof fetch
    });

    expect(result).toMatchObject({ ok: true, provider: "deepseek", model: "deepseek-v4-pro", message: "OK" });
    expect(body).toMatchObject({
      thinking: { type: "disabled" },
      max_tokens: 32,
      temperature: 0,
      messages: [{ role: "user", content: "Return exactly the text OK." }]
    });
  });

  it("accepts explicit reasoning text without treating empty content as universal success", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "health-secret");
    const result = await checkProviderHealth({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      signal: new AbortController().signal,
      fetchImpl: (async () => new Response(JSON.stringify({
        choices: [{ message: { content: null, reasoning_content: "OK" }, finish_reason: "stop" }]
      }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch
    });

    expect(result).toMatchObject({ ok: true, message: "OK" });
  });

  it("reports malformed completion shapes as protocol errors", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "health-secret");
    const result = await checkProviderHealth({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      signal: new AbortController().signal,
      fetchImpl: (async () => new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as typeof fetch
    });

    expect(result).toMatchObject({
      ok: false,
      failureKind: "api_error",
      errorCategory: "protocol",
      message: expect.stringContaining("choices must be a non-empty array")
    });
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
    await expect(consume()).rejects.toMatchObject({
      name: "TimeoutError",
      diagnostics: {
        doneReceived: false,
        transportEnded: false,
        retryAttempts: 1,
        timeoutReason: "Model stream idle for 25ms."
      }
    });
    expect(cancelled).toBeGreaterThan(0);
  });

  it("reports protocol metadata when the transport ends before [DONE]", async () => {
    const gateway = createGateway((async () => streamResponse([
      { choices: [{ delta: { content: "partial" }, finish_reason: null }] }
    ], false)) as typeof fetch, { maxRetries: 0 });

    let failure: unknown;
    try {
      await collectStream(gateway);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "model_stream_protocol_error",
      diagnostics: {
        httpStatus: 200,
        doneReceived: false,
        transportEnded: true,
        lastEventType: "content",
        hasContent: true,
        hasReasoning: false,
        hasToolCall: false,
        retryAttempts: 1,
        sseFrames: 1,
        ssePayloads: 1,
        sseTrailingBytes: 0
      }
    });
    const diagnostics = (failure as { diagnostics?: { sseChunks?: number; sseBytes?: number } })?.diagnostics;
    expect(diagnostics?.sseChunks).toBeGreaterThan(0);
    expect(diagnostics?.sseBytes).toBeGreaterThan(0);
  });

  it("carries an HTTP-stage abort reason into stream diagnostics", async () => {
    const controller = new AbortController();
    const gateway = createGateway((async () => await new Promise<Response>(() => undefined)) as typeof fetch, {
      maxRetries: 0,
      requestTimeoutMs: 1_000
    });
    const pending = collectStream(gateway, { ...request(), signal: controller.signal });
    setTimeout(() => controller.abort(new Error("parent request aborted")), 20);

    await expect(pending).rejects.toMatchObject({
      diagnostics: {
        doneReceived: false,
        lastEventType: "none",
        retryAttempts: 1,
        sseChunks: 0,
        sseBytes: 0,
        sseFrames: 0,
        ssePayloads: 0,
        sseTrailingBytes: 0,
        abortReason: "parent request aborted"
      }
    });
  });

  it("reports trailing bytes for an incomplete final SSE frame", async () => {
    const trailing = `data: ${JSON.stringify({
      choices: [{ delta: { content: "unterminated" }, finish_reason: null }]
    })}`;
    const gateway = createGateway((async () => new Response(trailing, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    })) as typeof fetch, { maxRetries: 0 });

    let failure: unknown;
    try {
      await collectStream(gateway);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      diagnostics: {
        httpStatus: 200,
        doneReceived: false,
        transportEnded: true,
        lastEventType: "content",
        hasContent: true,
        sseFrames: 1,
        ssePayloads: 1
      }
    });
    expect((failure as { diagnostics?: { sseTrailingBytes?: number } }).diagnostics?.sseTrailingBytes)
      .toBe(new TextEncoder().encode(trailing).byteLength);
  });

  it("completes a reasoning-and-tool stream only after [DONE]", async () => {
    const gateway = createGateway((async () => streamResponse([
      { choices: [{ delta: { reasoning_content: "inspect" }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{
        index: 0,
        id: "call_1",
        function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" }
      }] }, finish_reason: "tool_calls" }] }
    ], true)) as typeof fetch, { maxRetries: 0 });

    await expect(collectStream(gateway)).resolves.toEqual([
      { type: "reasoning", delta: "inspect" },
      { type: "tool_call", index: 0, call: {
        id: "call_1", name: "read_file", arguments: { path: "a.ts" }
      } },
      expect.objectContaining({
        type: "done",
        response: expect.objectContaining({ finishReason: "tool_calls" })
      })
    ]);
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

  it("classifies a reasoning-only stream that ends without [DONE] as an observable protocol failure", async () => {
    let attempts = 0;
    const gateway = createGateway((async () => {
      attempts += 1;
      return streamResponse([{ choices: [{ delta: { reasoning_content: "thinking" }, finish_reason: null }] }], false);
    }) as typeof fetch, { maxRetries: 1 });
    const events: ModelStreamEvent[] = [];
    let failure: unknown;
    try {
      for await (const event of gateway.stream(request())) events.push(event);
    } catch (error) {
      failure = error;
    }

    expect(events).toEqual([{ type: "reasoning", delta: "thinking" }]);
    expect(attempts).toBe(2);
    expect(failure).toMatchObject({
      code: "model_stream_protocol_error",
      category: "protocol",
      semanticDelta: true,
      diagnostics: {
        provider: "fake",
        model: "fake",
        httpStatus: 200,
        doneReceived: false,
        transportEnded: true,
        lastEventType: "reasoning",
        hasContent: false,
        hasReasoning: true,
        hasToolCall: false,
        retryAttempts: 2,
        sseChunks: 2,
        sseFrames: 2,
        ssePayloads: 2,
        sseTrailingBytes: 0
      }
    });
    expect((failure as Error).message).toContain("ended before [DONE]");
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
