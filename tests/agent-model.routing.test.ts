import { describe, expect, it, vi } from "vitest";
import type {
  ModelCapabilities,
  ModelGateway,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent
} from "../packages/agent-protocol/src/index.js";
import type { ModelSpecConfigValue } from "../packages/agent-config/src/index.js";
import {
  BUILTIN_MODEL_SPECS,
  ModelRouteExecutionError,
  ModelRouter,
  OpenAIModelGateway,
  RoutedModelGateway,
  approximateTokenCount,
  classifyModelFailure,
  createModelGatewayForSpec,
  normalizeUsage,
  modelReservationEstimate,
  toUsageRecord,
  type ModelRoute,
  type ModelSpec
} from "../packages/agent-model/src/index.js";
import { DEFAULT_PROFILE_BUDGET, freezeAgentProfile, type ResolvedAgentProfile } from "../packages/agent-extensions/src/index.js";
import {
  createRoleGateways,
  productionModelCandidates
} from "../packages/agent-runtime/src/model-composition.js";
import type { RuntimeCustomization } from "../packages/agent-runtime/src/customization.js";

const capabilities: ModelCapabilities = {
  contextWindowTokens: 10_000,
  maxOutputTokens: 2_000,
  tools: true,
  parallelTools: true,
  reasoning: true,
  structuredOutput: false,
  promptCache: false,
  tokenizer: "approximate"
};

function spec(id: string, overrides: Partial<ModelSpec> = {}): ModelSpec {
  return {
    id,
    providerId: id.startsWith("glm") ? "glm" : "deepseek",
    wireProtocol: "openai_chat",
    upstreamModel: id,
    capabilities,
    tokenizer: { id: "test", accuracy: "approximate" },
    pricing: {
      inputMicroUsdPerMillion: 1_000_000,
      outputMicroUsdPerMillion: 2_000_000,
      cacheReadMicroUsdPerMillion: 100_000,
      effectiveAt: "2026-01-01"
    },
    ...overrides
  };
}

function specConfig(
  id: string,
  upstreamModel: string,
  accuracy: "exact" | "approximate",
  inputPrice: number,
  priced = true
): ModelSpecConfigValue {
  return {
    id,
    providerId: "deepseek",
    upstreamModel,
    capabilities,
    tokenizer: { id: `${id}-tokenizer`, accuracy },
    ...(priced ? { pricing: {
      inputMicroUsdPerMillion: inputPrice,
      outputMicroUsdPerMillion: inputPrice * 2,
      cacheReadMicroUsdPerMillion: 0,
      effectiveAt: "2026-01-01"
    } } : {})
  };
}

function route(overrides: Partial<ModelRoute> = {}): ModelRoute {
  return {
    id: "main",
    candidates: ["deepseek/a", "glm/b"],
    fallbackOn: ["rate_limit", "capacity", "network", "server", "timeout"],
    maxAttempts: 2,
    ...overrides
  };
}

function request(): ModelRequest {
  return { messages: [{ role: "user", content: "hello" }], signal: new AbortController().signal };
}

function gateway(id: string, complete: () => Promise<ModelResponse>): ModelGateway {
  return {
    provider: id,
    model: id,
    capabilities,
    complete,
    async *stream(): AsyncIterable<ModelStreamEvent> { yield { type: "done", response: await complete() }; },
    async countTokens() { return 1; }
  };
}

describe("capability-aware model routing", () => {
  it("classifies transport codes without treating configuration failures as retryable", () => {
    expect(classifyModelFailure(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe("network");
    expect(classifyModelFailure(Object.assign(new Error("slow"), { code: "ETIMEDOUT" }))).toBe("timeout");
    expect(classifyModelFailure(Object.assign(new Error("bad config"), { category: "configuration" }))).toBe("configuration");
  });
  it("ships deterministic DeepSeek and GLM catalog entries", () => {
    expect(BUILTIN_MODEL_SPECS.map((item) => item.id)).toEqual([
      "deepseek/deepseek-v4-pro",
      "glm/glm-5.2"
    ]);
    expect(BUILTIN_MODEL_SPECS.every((item) => item.pricing && item.tokenizer.accuracy === "approximate")).toBe(true);
    const gateway = createModelGatewayForSpec(spec("deepseek/custom", {
      capabilities: { ...capabilities, contextWindowTokens: 42_000 }
    }), { apiKey: "secret" });
    expect(gateway).toMatchObject({ provider: "deepseek", model: "deepseek/custom" });
    expect(gateway.capabilities.contextWindowTokens).toBe(42_000);
  });

  it("composes production fallback candidates only when configured and keeps legacy flags single", () => {
    expect(productionModelCandidates(
      { provider: "deepseek", model: "auto" },
      { DEEPSEEK_API_KEY: "primary", GLM_API_KEY: "fallback" }
    ).map((item) => item.id)).toEqual(["deepseek/deepseek-v4-pro", "glm/glm-5.2"]);
    expect(productionModelCandidates(
      { provider: "glm", model: "auto", legacySingleModelRoute: true },
      { GLM_API_KEY: "primary", DEEPSEEK_API_KEY: "unused" }
    ).map((item) => item.id)).toEqual(["glm/glm-5.2"]);
    expect(productionModelCandidates(
      { provider: "deepseek", model: "auto" },
      { DEEPSEEK_API_KEY: "primary" }
    ).map((item) => item.id)).toEqual(["deepseek/deepseek-v4-pro"]);
  });

  it("uses explicit profile route ids as distinct production policies", async () => {
    const selectedProfile: ResolvedAgentProfile = {
      id: "routed",
      roleRoutes: { orchestrator: "exact-tools", reviewer: "cheap-review" },
      toolAllow: null, toolDeny: [], skills: [], hooks: [], permissionMode: "deny",
      budget: { ...DEFAULT_PROFILE_BUDGET },
      mutationPolicy: {
        requirePlanBeforeMutation: true, checkpointBeforeMutation: true,
        reviewMode: "advisory"
      },
      allowedChildProfiles: []
    };
    const frozen = freezeAgentProfile(selectedProfile);
    const customization = {
      profile: frozen,
      profileSource: "home",
      availableProfiles: [{ profile: frozen, source: "home" }]
    } as unknown as RuntimeCustomization;
    const calls: string[] = [];
    const timeoutPolicies: Array<{
      requestTimeoutMs: number;
      idleTimeoutMs: number;
      activeStreamTimeoutMs?: number;
    }> = [];
    const configuredSpecs = [
      specConfig("deepseek/approx", "approx", "approximate", 100),
      specConfig("deepseek/exact", "exact", "exact", 300)
    ];
    const gateways = createRoleGateways({
      provider: "deepseek", model: "approx", modelDeadlineSec: 10, streamIdleSec: 5, streamActiveSec: 7,
      modelSpecs: configuredSpecs,
      modelRoutes: [
        {
          id: "exact-tools", candidates: ["deepseek/approx", "deepseek/exact"],
          requiredCapabilities: { tools: true }, requireExactTokenizer: true,
          fallbackOn: ["timeout"], maxAttempts: 2
        },
        {
          id: "cheap-review", candidates: ["deepseek/approx"],
          fallbackOn: [], maxAttempts: 1
        }
      ]
    }, {
      gatewayFactory: (options) => {
        const { model } = options;
        timeoutPolicies.push(options);
        return gateway(model, async () => {
        calls.push(model);
        return response(model);
        });
      }
    }, customization, {});
    await gateways.orchestrator.complete(request());
    await gateways.reviewer.complete(request());
    expect(calls).toEqual(["exact", "approx"]);
    expect(timeoutPolicies.every((policy) => policy.requestTimeoutMs === 10_000
      && policy.idleTimeoutMs === 5_000 && policy.activeStreamTimeoutMs === 7_000)).toBe(true);
    expect(gateways.orchestrator.routingIdentity()).toEqual({ role: "orchestrator", routeId: "exact-tools" });
    expect(gateways.reviewer.routingIdentity()).toEqual({ role: "reviewer", routeId: "cheap-review" });
  });

  it("rejects unpriced custom models, profile route aliases, and unknown profile routes", () => {
    expect(() => new ModelRouter([spec("deepseek/a")], [
      route({ id: "one", candidates: ["deepseek/a"], maxAttempts: 1 }),
      route({ id: "two", candidates: ["deepseek/a"], maxAttempts: 1 })
    ], (item) => gateway(item.id, async () => response("ok")))).toThrow("only an alias");

    const profile = freezeAgentProfile({
      id: "missing-route", roleRoutes: { orchestrator: "missing", reviewer: "missing" },
      toolAllow: null, toolDeny: [], skills: [], hooks: [], permissionMode: "deny",
      budget: { ...DEFAULT_PROFILE_BUDGET },
      mutationPolicy: {
        requirePlanBeforeMutation: true, checkpointBeforeMutation: true,
        reviewMode: "advisory"
      },
      allowedChildProfiles: []
    });
    const customization = {
      profile, profileSource: "home", availableProfiles: [{ profile, source: "home" }]
    } as unknown as RuntimeCustomization;
    expect(() => createRoleGateways({
      provider: "deepseek", model: "custom", modelDeadlineSec: 10, streamIdleSec: 5,
      modelSpecs: [specConfig("deepseek/custom", "custom", "approximate", 100, false)],
      modelRoutes: [{ id: "known", candidates: ["deepseek/custom"], fallbackOn: [], maxAttempts: 1 }]
    }, { gatewayFactory: () => gateway("custom", async () => response("ok")) }, customization, {}))
      .toThrow("requires explicit pricing");
    expect(() => createRoleGateways({
      provider: "deepseek", model: "custom", modelDeadlineSec: 10, streamIdleSec: 5,
      modelSpecs: [specConfig("deepseek/custom", "custom", "approximate", 100)],
      modelRoutes: [{ id: "known", candidates: ["deepseek/custom"], fallbackOn: [], maxAttempts: 1 }]
    }, { gatewayFactory: () => gateway("custom", async () => response("ok")) }, customization, {}))
      .toThrow("has unusable orchestrator route 'missing'");
  });

  it("filters deterministically by capability, context margin, tokenizer, and budget", () => {
    const first = spec("deepseek/a", {
      capabilities: { ...capabilities, contextWindowTokens: 1_150, maxOutputTokens: 100 }
    });
    const second = spec("glm/b", { tokenizer: { id: "exact", accuracy: "exact", assetDigest: "a".repeat(64) } });
    const router = new ModelRouter([first, second], [route()], (item) => gateway(item.id, async () => response("ok")));

    const resolution = router.resolve("main", {
      estimatedInputTokens: 1_000,
      requireExactTokenizer: true,
      remainingBudgetMicroUsd: 10_000
    });
    expect(resolution.candidates.map((item) => item.id)).toEqual(["glm/b"]);
    expect(resolution.rejected).toEqual([
      expect.objectContaining({ modelSpecId: "deepseek/a", reason: "tokenizer" })
    ]);

    const unpriced = new ModelRouter(
      [spec("deepseek/a", { pricing: undefined })],
      [route({ candidates: ["deepseek/a"], maxAttempts: 1 })],
      (item) => gateway(item.id, async () => response("ok"))
    );
    expect(() => unpriced.resolve("main", { remainingBudgetMicroUsd: 10_000 })).toThrow("no eligible candidates");
    expect(modelReservationEstimate(first, { estimatedInputTokens: 100, maxOutputTokens: 50 })).toMatchObject({
      inputTokens: 150,
      outputTokens: 75
    });

    const cumulative = router.resolve("main", {
      estimatedInputTokens: 10,
      maxOutputTokens: 10,
      remainingBudgetMicroUsd: 50
    });
    expect(cumulative.candidates.map((item) => item.id)).toEqual(["deepseek/a"]);
    expect(cumulative.rejected).toContainEqual(expect.objectContaining({
      modelSpecId: "glm/b", reason: "budget", detail: expect.stringContaining("cumulative")
    }));
  });

  it("reserves the complete eligible fallback chain before execution", async () => {
    const cheap = spec("deepseek/a", { pricing: {
      inputMicroUsdPerMillion: 100_000,
      outputMicroUsdPerMillion: 100_000,
      cacheReadMicroUsdPerMillion: 0,
      effectiveAt: "2026-01-01"
    } });
    const expensive = spec("glm/b", { pricing: {
      inputMicroUsdPerMillion: 2_000_000,
      outputMicroUsdPerMillion: 3_000_000,
      cacheReadMicroUsdPerMillion: 0,
      effectiveAt: "2026-01-01"
    } });
    const representative: ModelGateway = {
      ...gateway("deepseek/a", async () => response("ok")),
      async countTokens() { return 1.25; }
    };
    const router = new ModelRouter([cheap, expensive], [route()], (item) => gateway(item.id, async () => response("ok")));
    const routed = new RoutedModelGateway({ router, role: "child_analyze", routeId: "main", representative });
    const plan = await routed.budgetPlan([{ role: "user", content: "hello" }], [], 100, 10_000);
    expect(plan.estimatedInputTokens).toBe(2);
    expect(plan.reservedInputTokens).toBeGreaterThan(plan.estimatedInputTokens * 2);
    expect(plan.reservedOutputTokens).toBe(300);
    expect(plan.reservedCostMicroUsd).toBeGreaterThan(0);
    expect(routed.routingIdentity()).toEqual({ role: "child_analyze", routeId: "main" });
  });

  it("falls back only for configured infrastructure errors before semantic output", async () => {
    const calls: string[] = [];
    const router = new ModelRouter([spec("deepseek/a"), spec("glm/b")], [route()], (item) => gateway(item.id, async () => {
      calls.push(item.id);
      if (item.id === "deepseek/a") throw Object.assign(new Error("busy"), { category: "rate_limit" });
      return response("recovered");
    }));

    const result = await router.complete("orchestrator", "main", request());
    expect(calls).toEqual(["deepseek/a", "glm/b"]);
    expect(result).toMatchObject({ modelSpecId: "glm/b", attempt: 1, inputTokens: expect.any(Number) });
    expect(result.usage).toMatchObject({ providerReported: false, retryAttempt: 1, costMicroUsd: expect.any(Number) });
  });

  it("does not fall back on protocol failures or after streamed semantic output", async () => {
    const second = vi.fn(async () => response("unexpected"));
    const protocolRouter = new ModelRouter([spec("deepseek/a"), spec("glm/b")], [route()], (item) => gateway(
      item.id,
      item.id === "deepseek/a" ? async () => { throw new Error("invalid payload"); } : second
    ));
    await expect(protocolRouter.complete("planner", "main", request())).rejects.toMatchObject({
      category: "protocol",
      attempts: 1
    });
    expect(second).not.toHaveBeenCalled();

    const semantic: ModelGateway = {
      ...gateway("deepseek/a", async () => response("unused")),
      async *stream() {
        yield { type: "content", delta: "partial" };
        throw Object.assign(new Error("server lost"), { category: "server" });
      }
    };
    const streamRouter = new ModelRouter(
      [spec("deepseek/a"), spec("glm/b")],
      [route()],
      (item) => item.id === "deepseek/a" ? semantic : gateway(item.id, second)
    );
    const consume = async (): Promise<void> => { for await (const _event of streamRouter.stream("planner", "main", request())) { /* consume */ } };
    const failure = consume();
    await expect(failure).rejects.toBeInstanceOf(ModelRouteExecutionError);
    await expect(failure).rejects.toMatchObject({ semanticDelta: true, attempts: 1 });

    const doneThenFailure: ModelGateway = {
      ...gateway("deepseek/a", async () => response("first")),
      async *stream() {
        yield { type: "done", response: response("first") };
        throw Object.assign(new Error("late disconnect"), { category: "server" });
      }
    };
    const afterDoneSecond = vi.fn(async () => response("must-not-run"));
    const doneRouter = new ModelRouter([spec("deepseek/a"), spec("glm/b")], [route()], (item) =>
      item.id === "deepseek/a" ? doneThenFailure : gateway(item.id, afterDoneSecond));
    const consumeDone = async (): Promise<void> => {
      for await (const _event of doneRouter.stream("orchestrator", "main", request())) { /* consume */ }
    };
    await expect(consumeDone()).rejects.toMatchObject({ semanticDelta: true, attempts: 1 });
    expect(afterDoneSecond).not.toHaveBeenCalled();
  });

  it("treats an empty stream without a terminal response as a protocol failure", async () => {
    const calls: string[] = [];
    const empty: ModelGateway = {
      ...gateway("deepseek/a", async () => response("unused")),
      async *stream() {
        calls.push("deepseek/a");
        yield* [] as ModelStreamEvent[];
      }
    };
    const router = new ModelRouter(
      [spec("deepseek/a"), spec("glm/b")],
      [route()],
      (item) => item.id === "deepseek/a" ? empty : gateway(item.id, async () => response("must-not-run"))
    );
    const consume = async (): Promise<void> => {
      for await (const _event of router.stream("orchestrator", "main", request())) { /* consume */ }
    };
    await expect(consume()).rejects.toMatchObject({
      category: "protocol",
      semanticDelta: false,
      attempts: 1,
      diagnostics: { doneReceived: false, lastEventType: "none" }
    });
    expect(calls).toEqual(["deepseek/a"]);
  });

  it("does not replay a stream that ends after semantic output", async () => {
    const fallback = vi.fn(async () => response("must-not-run"));
    const partial: ModelGateway = {
      ...gateway("deepseek/a", async () => response("unused")),
      async *stream() {
        yield { type: "content", delta: "partial" };
      }
    };
    const router = new ModelRouter(
      [spec("deepseek/a"), spec("glm/b")],
      [route()],
      (item) => item.id === "deepseek/a" ? partial : gateway(item.id, fallback)
    );
    const consume = async (): Promise<void> => {
      for await (const _event of router.stream("orchestrator", "main", request())) { /* consume */ }
    };
    await expect(consume()).rejects.toMatchObject({
      category: "protocol", semanticDelta: true, attempts: 1
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves cancellation when a %s semantic stream ends", async (semantic) => {
    const controller = new AbortController();
    const reason = Object.assign(new Error("The model turn was steered."), { code: "run_steered" });
    const fallback = vi.fn(async () => response("must-not-run"));
    const interrupted: ModelGateway = {
      ...gateway("deepseek/a", async () => response("unused")),
      async *stream() {
        if (semantic) yield { type: "content", delta: "partial" } as const;
        controller.abort(reason);
      }
    };
    const router = new ModelRouter(
      [spec("deepseek/a"), spec("glm/b")],
      [route()],
      (item) => item.id === "deepseek/a" ? interrupted : gateway(item.id, fallback)
    );
    const consume = async (): Promise<void> => {
      for await (const _event of router.stream("orchestrator", "main", {
        ...request(), signal: controller.signal
      })) { /* consume */ }
    };
    await expect(consume()).rejects.toBe(reason);
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe("normalized model usage", () => {
  it("always supplies token, cost, latency, and reporting fields", () => {
    const usage = normalizeUsage({
      request: request(),
      response: response("answer"),
      raw: { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 250, reasoningTokens: 40 },
      pricing: spec("deepseek/a").pricing,
      latencyMs: 12.4,
      retryAttempt: 2
    });
    expect(usage).toEqual({
      inputTokens: 1_000,
      outputTokens: 100,
      reasoningTokens: 40,
      cacheReadTokens: 250,
      cacheWriteTokens: 0,
      providerReported: true,
      costMicroUsd: 975,
      latencyMs: 12,
      retryAttempt: 2
    });
    expect(approximateTokenCount("中文abc")).toBeGreaterThan(2);
    expect(toUsageRecord(usage, {
      usageId: "usage-1",
      requestId: "request-1",
      sessionId: "session-1",
      runId: "run-1",
      role: "reviewer",
      routeId: "main",
      providerId: "deepseek",
      modelId: "deepseek/a",
      tokenizer: { id: "test", accuracy: "approximate", assetDigest: "c".repeat(64) },
      occurredAt: "2026-07-11T00:00:00.000Z"
    })).toMatchObject({
      costMicroUsd: 975,
      attempt: 3,
      role: "reviewer",
      tokenizerAssetDigest: "c".repeat(64)
    });
  });

  it("normalizes detailed provider usage on streaming gateway responses", async () => {
    const frames = [
      {
        usage: {
          prompt_tokens: 10,
          completion_tokens: 3,
          prompt_tokens_details: { cached_tokens: 4 },
          completion_tokens_details: { reasoning_tokens: 2 }
        },
        choices: [{ delta: { content: "ok" }, finish_reason: "stop" }]
      }
    ];
    const body = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
    const model = new OpenAIModelGateway({
      provider: "fake",
      model: "fake",
      baseUrl: "https://example.invalid",
      apiKey: "secret",
      apiKeyName: "FAKE_KEY",
      pricing: spec("deepseek/a").pricing,
      fetchImpl: (async () => new Response(body, { headers: { "content-type": "text/event-stream" } })) as typeof fetch
    });
    const events: ModelStreamEvent[] = [];
    for await (const event of model.stream(request())) events.push(event);
    const done = events.at(-1);
    expect(done).toMatchObject({
      type: "done",
      response: {
        inputTokens: 10,
        outputTokens: 3,
        usage: { cacheReadTokens: 4, reasoningTokens: 2, providerReported: true, costMicroUsd: 13 }
      }
    });
  });
});

function response(content: string): ModelResponse {
  return { message: { role: "assistant", content }, finishReason: "stop" };
}
