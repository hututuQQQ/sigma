import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest, ModelStreamEvent } from "../packages/agent-protocol/src/index.js";
import { OpenAIModelGateway, type OpenAIModelGatewayOptions } from "../packages/agent-model/src/index.js";

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

async function collectStream(model: OpenAIModelGateway, input: ModelRequest = request()): Promise<ModelStreamEvent[]> {
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
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "a.ts" } }] },
        { role: "tool", content: "contents", toolCallId: "call_1" }
      ],
      tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
      maxOutputTokens: 256,
      temperature: 0,
      signal: new AbortController().signal
    });

    expect(requestedUrl).toBe("https://example.invalid/v1/chat/completions");
    expect(requestedInit?.headers).toMatchObject({ Authorization: "Bearer secret", "Content-Type": "application/json" });
    expect(JSON.parse(String(requestedInit?.body))).toMatchObject({
      model: "fake",
      tool_choice: "auto",
      max_tokens: 256,
      temperature: 0,
      tools: [{ type: "function", function: { name: "read_file" } }],
      messages: [
        { role: "assistant", tool_calls: [{ id: "call_1", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }] },
        { role: "tool", tool_call_id: "call_1" }
      ]
    });
    expect(model.capabilities.reasoning).toBe(false);
    expect(response).toMatchObject({
      message: {
        content: "",
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
