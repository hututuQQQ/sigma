import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import os from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileCredentialStore,
  FileModelsStore,
  PiModelGateway,
  OPENAI_CODEX_DEFAULT_MODEL,
  OPENAI_CODEX_PROVIDER_ID,
  loginOpenAICodex,
  listPiAuthStatuses,
  listPiModels,
  listPiProviders,
  listOpenAICodexModels,
  getPiModel,
  logoutPiProvider,
  openAICodexAuthStatus,
  piAuthStatus,
  sanitizePiModelError,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type OAuthCredential
} from "../packages/agent-pi/src/index.js";
import type { JsonValue, ModelMessage } from "../packages/agent-protocol/src/index.js";

class MemoryCredentialStore implements CredentialStore {
  private credential: Credential | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(credential?: Credential) {
    this.credential = credential;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return providerId === OPENAI_CODEX_PROVIDER_ID ? this.credential : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return this.credential
      ? [{ providerId: OPENAI_CODEX_PROVIDER_ID, type: this.credential.type }]
      : [];
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    const operation = this.chain.then(async () => {
      if (providerId !== OPENAI_CODEX_PROVIDER_ID) return undefined;
      const next = await fn(this.credential);
      if (next !== undefined) this.credential = next;
      return next ?? this.credential;
    });
    this.chain = operation.catch(() => undefined);
    return operation;
  }

  async delete(providerId: string): Promise<void> {
    await this.modify(providerId, async () => {
      this.credential = undefined;
      return undefined;
    });
  }
}

class ApiKeyCredentialStore implements CredentialStore {
  constructor(
    private readonly providerId: string,
    private credential: Credential = { type: "api_key", key: "provider-api-key" }
  ) {}

  async read(providerId: string): Promise<Credential | undefined> {
    return providerId === this.providerId ? this.credential : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [{ providerId: this.providerId, type: this.credential.type }];
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    if (providerId !== this.providerId) return undefined;
    const next = await fn(this.credential);
    if (next) this.credential = next;
    return next;
  }

  async delete(providerId: string): Promise<void> {
    if (providerId === this.providerId) {
      this.credential = { type: "api_key", key: undefined };
    }
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function jwt(accountId = "acct_test", email = "person@example.test"): string {
  const payload = Buffer.from(JSON.stringify({
    email,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId }
  })).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${payload}.signature`;
}

function oauth(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    access: jwt(),
    refresh: "refresh-token",
    expires: Date.now() + 60 * 60 * 1_000,
    accountId: "acct_test",
    ...overrides
  };
}

function sse(events: readonly Record<string, unknown>[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function completedTextEvents(text: string, responseId = "resp_text"): Record<string, unknown>[] {
  const item = {
    type: "message",
    id: `${responseId}_message`,
    role: "assistant",
    status: "completed",
    phase: "final_answer",
    content: [{ type: "output_text", text, annotations: [] }]
  };
  return [
    { type: "response.created", response: { id: responseId, status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_text.delta", output_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 0 }
        }
      }
    }
  ];
}

function completedToolEvents(): Record<string, unknown>[] {
  const reasoning = {
    type: "reasoning",
    id: "reasoning_1",
    summary: [{ type: "summary_text", text: "Inspect the workspace." }],
    encrypted_content: "opaque-reasoning-signature"
  };
  const message = {
    type: "message",
    id: "message_1",
    role: "assistant",
    status: "completed",
    phase: "commentary",
    content: [{ type: "output_text", text: "I will inspect it.", annotations: [] }]
  };
  const call = {
    type: "function_call",
    id: "function_1",
    call_id: "call_1",
    name: "read_file",
    arguments: "{\"path\":\"README.md\"}",
    status: "completed"
  };
  return [
    { type: "response.created", response: { id: "resp_tool", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: reasoning },
    {
      type: "response.reasoning_summary_text.delta",
      output_index: 0,
      delta: "Inspect the workspace."
    },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: message },
    { type: "response.output_text.delta", output_index: 1, delta: "I will inspect it." },
    { type: "response.output_item.done", output_index: 1, item: message },
    { type: "response.output_item.added", output_index: 2, item: call },
    {
      type: "response.function_call_arguments.delta",
      output_index: 2,
      delta: "{\"path\":\"README.md\"}"
    },
    { type: "response.output_item.done", output_index: 2, item: call },
    {
      type: "response.completed",
      response: {
        id: "resp_tool",
        status: "completed",
        output: [reasoning, message, call],
        usage: {
          input_tokens: 12,
          output_tokens: 6,
          total_tokens: 18,
          input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
          output_tokens_details: { reasoning_tokens: 3 }
        }
      }
    }
  ];
}

function openAICompletionSse(): Response {
  const events = [
    {
      id: "chatcmpl_test",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-pro",
      choices: [{
        index: 0,
        delta: { role: "assistant", content: "Compatible." },
        finish_reason: null
      }]
    },
    {
      id: "chatcmpl_test",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-pro",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_tokens_details: { cached_tokens: 3 }
      }
    }
  ];
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  const headers = new Headers(init?.headers);
  const body = init?.body;
  if (body === undefined || body === null) throw new Error("Expected a request body.");
  const bytes = typeof body === "string"
    ? Buffer.from(body)
    : body instanceof Uint8Array
      ? Buffer.from(body.buffer, body.byteOffset, body.byteLength)
      : body instanceof ArrayBuffer
        ? Buffer.from(body)
        : Buffer.from(String(body));
  const decoded = headers.get("content-encoding") === "zstd"
    ? zstdDecompressSync(bytes)
    : bytes;
  return JSON.parse(decoded.toString("utf8")) as Record<string, unknown>;
}

describe("OpenAI Codex subscription gateway", () => {
  it("pins the expected Pi catalog and defaults to Terra", () => {
    const models = listPiModels();
    const catalogSummary = models
      .map((model) => [
        model.providerId,
        model.id,
        model.api,
        model.contextWindowTokens,
        model.maxOutputTokens,
        model.billingModes.join(",")
      ].join("|"))
      .sort()
      .join("\n");
    expect(listPiProviders()).toHaveLength(39);
    expect(models).toHaveLength(1_110);
    expect(models.filter((model) => model.providerId !== "glm")).toHaveLength(1_109);
    expect(createHash("sha256").update(catalogSummary).digest("hex"))
      .toBe("e613a457d3db26fbb2ea0fc4fd04214ace80768ea5d252eb64dc9f5265238569");
    expect(OPENAI_CODEX_DEFAULT_MODEL).toBe("gpt-5.6-terra");
    expect(listOpenAICodexModels().map((model) => model.id)).toEqual([
      "gpt-5.3-codex-spark",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.5",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra"
    ]);
  });

  it("uses only the ChatGPT Codex SSE endpoint and durably replays opaque state", async () => {
    vi.stubEnv("OPENAI_API_KEY", "metered-api-key-must-not-be-read");
    const captured: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const responses = [
      sse(completedToolEvents()),
      sse(completedTextEvents("Done.", "resp_done"))
    ];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      captured.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: requestBody(init)
      });
      return responses.shift()!;
    });
    vi.stubGlobal("fetch", fetchMock);

    const gateway = new PiModelGateway({
      provider: OPENAI_CODEX_PROVIDER_ID,
      model: OPENAI_CODEX_DEFAULT_MODEL,
      credentials: new MemoryCredentialStore(oauth())
    });
    const controller = new AbortController();
    const messages: ModelMessage[] = [
      { role: "system", content: "System first." },
      { role: "developer", content: "Developer second." },
      {
        role: "assistant",
        content: "A prior answer from another provider.",
        providerState: {
          provider: "deepseek",
          version: 1,
          data: { opaque: "cross-provider-state-must-be-discarded" }
        }
      },
      { role: "user", content: "Inspect this repository." }
    ];
    const first = await gateway.complete({
      messages,
      tools: [{
        name: "read_file",
        description: "Read a workspace file.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"]
        } as JsonValue as Record<string, JsonValue>
      }],
      toolChoice: "auto",
      signal: controller.signal
    });

    expect(first).toMatchObject({
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: "I will inspect it.",
        reasoningContent: "Inspect the workspace.",
        toolCalls: [{
          id: "call_1|function_1",
          name: "read_file",
          arguments: { path: "README.md" }
        }],
        providerState: {
          provider: "openai-codex",
          version: 1
        }
      },
      usage: {
        inputTokens: 12,
        outputTokens: 6,
        reasoningTokens: 3,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        costMicroUsd: null,
        billingMode: "subscription"
      }
    });

    const second = await gateway.complete({
      messages: [
        ...messages,
        first.message,
        {
          role: "tool",
          content: "README contents",
          toolCallId: first.message.toolCalls![0]!.id
        }
      ],
      signal: controller.signal
    });
    expect(second.message.content).toBe("Done.");

    expect(captured).toHaveLength(2);
    expect(captured.every((request) =>
      request.url === "https://chatgpt.com/backend-api/codex/responses")).toBe(true);
    expect(captured.every((request) =>
      request.headers.get("authorization") === `Bearer ${oauth().access}`)).toBe(true);
    expect(captured.every((request) =>
      request.headers.get("authorization") !== "Bearer metered-api-key-must-not-be-read")).toBe(true);
    expect(captured[0]!.body.instructions).toBe(
      "<system>\nSystem first.\n</system>\n\n<developer>\nDeveloper second.\n</developer>"
    );
    expect(captured[0]!.body.parallel_tool_calls).toBe(true);
    expect(JSON.stringify(captured[0]!.body.input))
      .not.toContain("cross-provider-state-must-be-discarded");
    expect(JSON.stringify(captured[1]!.body.input)).toContain("opaque-reasoning-signature");
    expect(JSON.stringify(captured[1]!.body.input)).toContain("README contents");
  });

  it("refreshes an expired token under the credential-store mutation path", async () => {
    const previous = oauth({ access: jwt("old"), refresh: "old-refresh", expires: Date.now() - 1 });
    const refreshedAccess = jwt("refreshed");
    const store = new MemoryCredentialStore(previous);
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://auth.openai.com/oauth/token") {
        expect(String(init?.body)).toContain("refresh_token=old-refresh");
        return new Response(JSON.stringify({
          access_token: refreshedAccess,
          refresh_token: "rotated-refresh",
          expires_in: 3600
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${refreshedAccess}`);
      return sse(completedTextEvents("Refreshed."));
    }));

    const gateway = new PiModelGateway({
      provider: OPENAI_CODEX_PROVIDER_ID,
      model: OPENAI_CODEX_DEFAULT_MODEL,
      credentials: store
    });
    const result = await gateway.complete({
      messages: [{ role: "user", content: "hello" }],
      signal: new AbortController().signal
    });

    expect(result.message.content).toBe("Refreshed.");
    expect(calls).toEqual([
      "https://auth.openai.com/oauth/token",
      "https://chatgpt.com/backend-api/codex/responses"
    ]);
    expect(await store.read(OPENAI_CODEX_PROVIDER_ID)).toMatchObject({
      type: "oauth",
      access: refreshedAccess,
      refresh: "rotated-refresh"
    });
  });

  it("preserves cancellation and exposes only sanitized error categories", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("fetch contained secret-token")), {
          once: true
        });
      })));
    const gateway = new PiModelGateway({
      provider: OPENAI_CODEX_PROVIDER_ID,
      model: OPENAI_CODEX_DEFAULT_MODEL,
      credentials: new MemoryCredentialStore(oauth())
    });
    const pending = gateway.complete({
      messages: [{ role: "user", content: "wait" }],
      signal: controller.signal
    });
    controller.abort(new Error("cancelled by caller"));
    await expect(pending).rejects.toThrow("cancelled by caller");

    expect(sanitizePiModelError(new Error(
      "You have hit your ChatGPT usage limit; secret-token"
    ))).toMatchObject({
      code: "allowance_exhausted",
      category: "capacity",
      message: "The model provider allowance is currently exhausted."
    });
    expect(sanitizePiModelError(Object.assign(
      new Error("ChatGPT allowance exhausted; secret-token"),
      { status: 403 }
    ))).toMatchObject({
      code: "allowance_exhausted",
      category: "capacity"
    });
    expect(sanitizePiModelError(new Error("rate limit: secret-token"))).toMatchObject({
      code: "rate_limited",
      category: "rate_limit"
    });
    expect(sanitizePiModelError(new Error("Provider is not configured: openai-codex")))
      .toMatchObject({ code: "auth_required", category: "auth" });
  });

  it("bounds an SSE stream that stops producing events", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      start() {
        // Deliberately leave the stream open without producing an SSE frame.
      }
    }), {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    })));
    const gateway = new PiModelGateway({
      provider: OPENAI_CODEX_PROVIDER_ID,
      model: OPENAI_CODEX_DEFAULT_MODEL,
      credentials: new MemoryCredentialStore(oauth()),
      idleTimeoutMs: 10
    });
    await expect(gateway.complete({
      messages: [{ role: "user", content: "wait" }],
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      code: "timeout",
      category: "timeout",
      message: "The model provider request timed out."
    });
  });
});

describe("Pi provider compatibility gateway", () => {
  it("preserves DeepSeek reminders, tool policy, and metered usage through Pi", async () => {
    let captured: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      captured = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: requestBody(init)
      };
      return openAICompletionSse();
    }));

    const gateway = new PiModelGateway({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      baseUrl: "https://deepseek.example.test/v1",
      credentials: new ApiKeyCredentialStore("deepseek")
    });
    const result = await gateway.complete({
      messages: [
        { role: "system", content: "Follow the workspace rules." },
        { role: "user", content: "Inspect the repository." },
        { role: "developer", content: "Report only verified findings." }
      ],
      tools: [{
        name: "read_file",
        description: "Read a file.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"]
        }
      }],
      toolChoice: "required",
      signal: new AbortController().signal
    });

    expect(result.message.content).toBe("Compatible.");
    expect(result.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 3,
      billingMode: "metered"
    });
    expect(result.usage.costMicroUsd).toBeTypeOf("number");
    expect(captured?.url).toBe("https://deepseek.example.test/v1/chat/completions");
    expect(captured?.headers.get("authorization")).toBe("Bearer provider-api-key");
    expect(captured?.body).toMatchObject({
      model: "deepseek-v4-pro",
      stream: true,
      tool_choice: "required",
      thinking: { type: "disabled" }
    });
    const messages = captured?.body.messages as Array<{ role?: string; content?: string }>;
    expect(messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("<system>")
    });
    expect(messages).toContainEqual(expect.objectContaining({
      role: "user",
      content: expect.stringContaining("<latest_reminder>")
    }));
  });

  it("reports ambient credentials after logout without copying them into auth.json", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "ambient-provider-key");
    const store = new MemoryCredentialStore();

    expect(await piAuthStatus("anthropic", store)).toMatchObject({
      provider: "anthropic",
      status: "authenticated",
      authType: "api_key"
    });
    expect(await logoutPiProvider("anthropic", store)).toMatchObject({
      provider: "anthropic",
      status: "authenticated",
      authType: "api_key"
    });
    expect(await store.list()).toEqual([]);
  });
});

describe("OpenAI Codex OAuth adapter", () => {
  it("completes from the localhost callback without requiring a manual retry", async () => {
    const access = jwt("callback-account", "callback@example.test");
    let callbackResponse: Promise<number> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://auth.openai.com/oauth/token");
      return new Response(JSON.stringify({
        access_token: access,
        refresh_token: "callback-refresh",
        expires_in: 3600
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const store = new MemoryCredentialStore();
    const status = await loginOpenAICodex("browser", {
      notify: (event) => {
        if (event.type !== "auth_url") return;
        const state = new URL(event.url).searchParams.get("state");
        expect(state).toBeTruthy();
        callbackResponse = new Promise<number>((resolve, reject) => {
          const request = httpGet(
            `http://127.0.0.1:1455/auth/callback?code=callback-code&state=${encodeURIComponent(state!)}`,
            (response) => {
              response.resume();
              response.on("end", () => resolve(response.statusCode ?? 0));
            }
          );
          request.on("error", reject);
        });
      },
      prompt: async (prompt) => await new Promise<string>((_resolve, reject) => {
        const onAbort = (): void => reject(prompt.signal?.reason ?? new Error("cancelled"));
        prompt.signal?.addEventListener("abort", onAbort, { once: true });
      })
    }, store);

    expect(await callbackResponse).toBe(200);
    expect(status).toMatchObject({
      provider: "openai-codex",
      status: "authenticated",
      accountId: "callback-account",
      email: "callback@example.test"
    });
    expect(await store.read(OPENAI_CODEX_PROVIDER_ID)).toMatchObject({
      access,
      refresh: "callback-refresh"
    });
  });

  it("supports browser login with the localhost callback and manual-code fallback", async () => {
    const access = jwt("browser-account", "browser@example.test");
    const notices: Array<Record<string, unknown>> = [];
    const prompts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://auth.openai.com/oauth/token");
      expect(String(init?.body)).toContain("grant_type=authorization_code");
      expect(String(init?.body)).toContain(
        "redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback"
      );
      return new Response(JSON.stringify({
        access_token: access,
        refresh_token: "browser-refresh",
        expires_in: 3600
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const store = new MemoryCredentialStore();
    const status = await loginOpenAICodex("browser", {
      notify: (event) => notices.push(event as unknown as Record<string, unknown>),
      prompt: async (prompt) => {
        prompts.push(prompt.type);
        expect(prompt.signal).toBeInstanceOf(AbortSignal);
        return "manual-browser-code";
      }
    }, store);

    expect(prompts).toEqual(["manual_code"]);
    expect(notices).toEqual([
      expect.objectContaining({
        type: "auth_url",
        url: expect.stringMatching(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/u)
      })
    ]);
    expect(status).toMatchObject({
      provider: "openai-codex",
      status: "authenticated",
      accountId: "browser-account",
      email: "browser@example.test"
    });
    expect(await store.read(OPENAI_CODEX_PROVIDER_ID)).toMatchObject({
      access,
      refresh: "browser-refresh"
    });
  });

  it("supports the headless device-code flow", async () => {
    const access = jwt("device-account", "device@example.test");
    const notices: Array<Record<string, unknown>> = [];
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return new Response(JSON.stringify({
          device_auth_id: "device-auth-id",
          user_code: "ABCD-EFGH",
          interval: 0
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/api/accounts/deviceauth/token")) {
        return new Response(JSON.stringify({
          authorization_code: "device-authorization-code",
          code_verifier: "device-verifier"
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        access_token: access,
        refresh_token: "device-refresh",
        expires_in: 3600
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const status = await loginOpenAICodex("device-code", {
      notify: (event) => notices.push(event as unknown as Record<string, unknown>),
      prompt: async () => {
        throw new Error("The device-code flow must not request manual input.");
      }
    }, new MemoryCredentialStore());

    expect(urls).toEqual([
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      "https://auth.openai.com/api/accounts/deviceauth/token",
      "https://auth.openai.com/oauth/token"
    ]);
    expect(notices).toEqual([{
      type: "device_code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.openai.com/codex/device",
      intervalSeconds: 0,
      expiresInSeconds: 900
    }]);
    expect(status).toMatchObject({
      status: "authenticated",
      accountId: "device-account",
      email: "device@example.test"
    });
  });
});

describe("OpenAI Codex credential persistence", () => {
  it("lists every provider's local auth state without network access", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("offline status must not call fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const statuses = await listPiAuthStatuses(new MemoryCredentialStore());

    expect(statuses).toHaveLength(39);
    expect(new Set(statuses.map((status) => status.provider)).size).toBe(39);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps status local and atomically persists one host-scoped credential", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-codex-auth-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, ".sigma", "auth.json");
    const store = new FileCredentialStore({ filePath });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await openAICodexAuthStatus(store)).toEqual({
      provider: "openai-codex",
      status: "unauthenticated"
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const loginLease = await store.acquireLoginLease();
    await expect(store.acquireLoginLease()).rejects.toThrow(
      "Sigma provider authentication is active"
    );
    await loginLease.release();
    await writeFile(`${filePath}.login.lock`, `${JSON.stringify({
      pid: 99_999_999,
      instanceId: "stale-login",
      startedAt: "2000-01-01T00:00:00.000Z"
    })}\n`, "utf8");
    const recoveredLease = await store.acquireLoginLease();
    await recoveredLease.release();

    await store.modify(OPENAI_CODEX_PROVIDER_ID, async () => oauth());
    expect(await openAICodexAuthStatus(store)).toMatchObject({
      provider: "openai-codex",
      status: "authenticated",
      accountId: "acct_test",
      email: "person@example.test"
    });
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      version: 1,
      credentials: { "openai-codex": { type: "oauth", refresh: "refresh-token" } }
    });
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o077).toBe(0);
    }

    await store.delete(OPENAI_CODEX_PROVIDER_ID);
    expect(await openAICodexAuthStatus(store)).toMatchObject({ status: "unauthenticated" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not echo malformed credential or model cache contents", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-private-json-"));
    temporaryDirectories.push(directory);
    const stateDirectory = path.join(directory, ".sigma");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const credentialPath = path.join(stateDirectory, "auth.json");
    const modelsPath = path.join(stateDirectory, "models.json");
    await writeFile(credentialPath, "{\"access\":\"secret-access-token\"", {
      encoding: "utf8",
      mode: 0o600
    });
    await writeFile(modelsPath, "{\"response\":\"secret-provider-response\"", {
      encoding: "utf8",
      mode: 0o600
    });

    await expect(new FileCredentialStore({ filePath: credentialPath }).list())
      .rejects.toThrow("Sigma credential file contains invalid JSON.");
    await expect(new FileModelsStore({ filePath: modelsPath }).read("radius"))
      .rejects.toThrow("Sigma model catalog file contains invalid JSON.");
  });

  it("atomically persists a validated dynamic model catalog", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-model-cache-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, ".sigma", "models.json");
    const store = new FileModelsStore({ filePath });
    const template = getPiModel("deepseek", "deepseek-v4-pro");
    expect(template).toBeDefined();
    const model = {
      ...template!,
      provider: "dynamic-contract",
      id: "dynamic-model",
      name: "Dynamic Model"
    };

    await store.write("dynamic-contract", {
      models: [model],
      checkedAt: 123,
      etag: "catalog-v1"
    });

    expect(await store.read("dynamic-contract")).toMatchObject({
      checkedAt: 123,
      etag: "catalog-v1",
      models: [{
        provider: "dynamic-contract",
        id: "dynamic-model",
        name: "Dynamic Model"
      }]
    });
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o077).toBe(0);
    }
  });
});
