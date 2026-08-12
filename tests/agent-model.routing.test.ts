import { describe, expect, it, vi } from "vitest";
import type {
  ModelCapabilities,
  ModelGateway,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  UsageRecord
} from "../packages/agent-protocol/src/index.js";
import type { ModelSpecConfigValue } from "../packages/agent-config/src/index.js";
import {
  listPiAuthStatuses,
  listPiProviders,
  piProviderEnvironmentValue,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Credential,
  type CredentialStore,
  type Model as PiModel,
  type Models,
  type ModelsStore
} from "../packages/agent-pi/src/index.js";
import {
  BUILTIN_MODEL_SPECS,
  ModelRouteExecutionError,
  ModelRouter,
  RoutedModelGateway,
  approximateTokenCount,
  checkProviderHealth,
  classifyModelFailure,
  createModelGatewayForSpec,
  loadPiRuntimeModelCatalog,
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
import {
  consumedBudget,
  failedModelUsage,
  prepareModelBudget,
  successfulModelUsage
} from "../packages/agent-runtime/src/model-accounting.js";
import type { RuntimeCustomization } from "../packages/agent-runtime/src/customization.js";
import { aggregateReviewerUsage } from "../packages/agent-runtime/src/reviewer-accounting.js";

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
    upstreamModel: id,
    billingMode: "metered",
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
    billingMode: "metered",
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

function credentialStore(providerId: string, credential: Credential): CredentialStore {
  return {
    async read(id) { return id === providerId ? credential : undefined; },
    async list() { return [{ providerId, type: credential.type }]; },
    async modify(id, update) {
      if (id !== providerId) return undefined;
      const replacement = await update(credential);
      if (replacement) credential = replacement;
      return replacement;
    },
    async delete() { /* test-only in-memory store */ }
  };
}

function genericHealthModels(): Models {
  const model: PiModel<Api> = {
    id: "fixture-model",
    name: "Fixture model",
    api: "pi-messages",
    provider: "fixture-provider",
    baseUrl: "https://fixture-provider.example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 1_024
  };
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "OK" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 4,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: Date.now()
  };
  async function* events(): AsyncIterable<AssistantMessageEvent> {
    yield { type: "start", partial: message };
    yield { type: "text_delta", contentIndex: 0, delta: "OK", partial: message };
    yield { type: "done", reason: "stop", message };
  }
  return {
    getProviders: () => [],
    getProvider: () => undefined,
    getModels: () => [model],
    getModel: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
    refresh: async () => ({ refreshed: [], errors: [] }) as never,
    checkAuth: async () => ({ type: "api_key", source: "fixture" }) as never,
    getAvailable: async () => [model],
    getAuth: async () => ({
      type: "api_key",
      source: "fixture",
      auth: { apiKey: "fixture-secret", baseUrl: model.baseUrl }
    }) as never,
    login: async () => { throw new Error("not interactive"); },
    logout: async () => undefined,
    stream: () => events() as never,
    complete: async () => message,
    streamSimple: () => events() as never,
    completeSimple: async () => message
  };
}

describe("provider health probe", () => {
  it("executes a real gateway probe for a provider-neutral Pi transport", async () => {
    const report = await checkProviderHealth({
      provider: "fixture-provider",
      model: "fixture-model",
      signal: new AbortController().signal,
      piModels: genericHealthModels()
    });

    expect(report).toMatchObject({
      ok: true,
      provider: "fixture-provider",
      model: "fixture-model",
      endpointHost: "fixture-provider.example.test",
      message: "OK"
    });
  });

  it("probes the same configured default model used by runtime auto selection", async () => {
    vi.stubEnv("DEEPSEEK_MODEL", "configured-default-model");
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "configured-default-model"
      });
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "OK" } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const report = await checkProviderHealth({
      provider: "deepseek",
      model: "auto",
      signal: new AbortController().signal,
      credentials: credentialStore("deepseek", {
        type: "api_key",
        key: "persisted-health-key"
      }),
      fetchImpl
    });

    expect(report).toMatchObject({ ok: true, model: "configured-default-model" });
    vi.unstubAllEnvs();
  });

  it("uses a persisted credential and only the injected fetch implementation", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const globalFetch = vi.fn(() => Promise.reject(new Error("global fetch must not run")));
    vi.stubGlobal("fetch", globalFetch);
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization"))
        .toBe("Bearer persisted-health-key");
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "OK" } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const report = await checkProviderHealth({
      provider: "deepseek",
      model: "deepseek-chat",
      signal: new AbortController().signal,
      credentials: credentialStore("deepseek", {
        type: "api_key",
        key: "persisted-health-key"
      }),
      fetchImpl
    });

    expect(report).toMatchObject({ ok: true, provider: "deepseek", message: "OK" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(globalFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("safely classifies an injected network failure without exposing credentials", async () => {
    const secret = "health-secret-that-must-not-leak";
    const report = await checkProviderHealth({
      provider: "deepseek",
      model: "deepseek-chat",
      signal: new AbortController().signal,
      credentials: credentialStore("deepseek", { type: "api_key", key: secret }),
      fetchImpl: vi.fn(async () => { throw new Error(`socket failed Bearer ${secret}`); })
    });

    expect(report).toMatchObject({ ok: false, failureKind: "network_error" });
    expect(report.message).not.toContain(secret);
    expect(report.message).toContain("[redacted]");
  });

  it("sanitizes authentication failures that happen before credentials resolve", async () => {
    const secret = "oauth-refresh-secret-that-must-not-leak";
    const report = await checkProviderHealth({
      provider: "deepseek",
      model: "deepseek-chat",
      signal: new AbortController().signal,
      piModels: {
        getAuth: async () => {
          throw new Error(`OAuth refresh rejected ${secret}`);
        },
        getProvider: () => undefined
      } as unknown as Models,
      fetchImpl: vi.fn()
    });

    expect(report).toMatchObject({
      ok: false,
      failureKind: "api_error",
      errorCategory: "auth"
    });
    expect(report.message).not.toContain(secret);
    expect(report.message).toContain("authentication is required");
  });

  it("enforces the configured request timeout for an injected fetch implementation", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));

    const report = await checkProviderHealth({
      provider: "deepseek",
      model: "deepseek-chat",
      signal: new AbortController().signal,
      requestTimeoutMs: 10,
      credentials: credentialStore("deepseek", {
        type: "api_key",
        key: "persisted-health-key"
      }),
      fetchImpl
    });

    expect(report).toMatchObject({
      ok: false,
      failureKind: "network_error",
      errorCategory: "timeout"
    });
    expect(report.message).toContain("timed out after 10 ms");
  });
});

describe("provider environment conventions", () => {
  it("resolves a future provider without adding a provider-specific branch", () => {
    expect(piProviderEnvironmentValue("future-provider", "BASE_URL", {
      FUTURE_PROVIDER_BASE_URL: "  https://future.example.test/v1  "
    })).toBe("https://future.example.test/v1");
  });
});

describe("capability-aware model routing", () => {
  it("classifies transport codes without treating configuration failures as retryable", () => {
    expect(classifyModelFailure(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe("network");
    expect(classifyModelFailure(Object.assign(new Error("slow"), { code: "ETIMEDOUT" }))).toBe("timeout");
    expect(classifyModelFailure(Object.assign(new Error("bad config"), { category: "configuration" }))).toBe("configuration");
  });
  it("ships deterministic metered and ChatGPT subscription catalog entries", () => {
    expect(BUILTIN_MODEL_SPECS).toHaveLength(1_110);
    // Radius has no static models until its cache is hydrated, while the
    // provider registry still exposes it as a connection.
    expect(new Set(BUILTIN_MODEL_SPECS.map((item) => item.providerId)).size).toBe(38);
    expect(BUILTIN_MODEL_SPECS.map((item) => item.id)).toContain("openai-codex/gpt-5.6-terra");
    expect(BUILTIN_MODEL_SPECS.map((item) => item.id)).toContain("glm/glm-5.2");
    expect(BUILTIN_MODEL_SPECS.filter((item) => item.billingMode === "metered")
      .every((item) => item.pricing && item.tokenizer.accuracy === "approximate")).toBe(true);
    expect(BUILTIN_MODEL_SPECS.filter((item) => item.billingMode !== "metered")
      .every((item) => item.pricing === undefined)).toBe(true);
    const terra = BUILTIN_MODEL_SPECS.find((item) => item.id === "openai-codex/gpt-5.6-terra");
    expect(terra).toMatchObject({ billingMode: "subscription" });
    expect(terra?.pricing).toBeUndefined();
    expect(BUILTIN_MODEL_SPECS.find((item) => item.id === "openai/gpt-5.4")?.pricing)
      .toMatchObject({
        tiers: [expect.objectContaining({
          inputTokensAbove: 272_000,
          inputMicroUsdPerMillion: 5_000_000
        })]
      });
    const gateway = createModelGatewayForSpec(spec("deepseek/custom", {
      capabilities: { ...capabilities, contextWindowTokens: 42_000 }
    }));
    expect(gateway).toMatchObject({ provider: "deepseek", model: "deepseek/custom" });
    expect(gateway.capabilities.contextWindowTokens).toBe(42_000);
    const openAiGateway = createModelGatewayForSpec(spec("custom-openai", {
      providerId: "openai",
      upstreamModel: "future-openai-model",
      capabilities: { ...capabilities, contextWindowTokens: 64_000 }
    }));
    expect(openAiGateway).toMatchObject({
      provider: "openai",
      model: "future-openai-model",
      capabilities: expect.objectContaining({ contextWindowTokens: 64_000 })
    });
  });

  it("hydrates Radius models from the local cache without network access", async () => {
    const storedCredentials = new Map<string, Credential>([
      ["anthropic", {
        type: "oauth" as const,
        access: "local-oauth-access",
        refresh: "local-oauth-refresh",
        expires: Date.now() + 60_000
      }]
    ]);
    const credentials: CredentialStore = {
      async read(providerId) { return storedCredentials.get(providerId); },
      async list() {
        return [...storedCredentials].map(([providerId, credential]) => ({
          providerId,
          type: credential.type
        }));
      },
      async modify(providerId, update) {
        const replacement = await update(storedCredentials.get(providerId));
        if (replacement) storedCredentials.set(providerId, replacement);
        return replacement;
      },
      async delete(providerId) { storedCredentials.delete(providerId); }
    };
    type ModelsEntry = NonNullable<Awaited<ReturnType<ModelsStore["read"]>>>;
    const entries = new Map<string, ModelsEntry>([
      ["radius", {
        checkedAt: 1_753_804_800_000,
        models: [{
          id: "cached-model",
          name: "Cached Radius Model",
          api: "pi-messages",
          provider: "radius",
          baseUrl: "https://radius.example.test",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_000,
          maxTokens: 4_096
        }]
      }]
    ]);
    const modelsStore: ModelsStore = {
      async read(providerId) { return entries.get(providerId); },
      async write(providerId, entry) { entries.set(providerId, entry); },
      async delete(providerId) { entries.delete(providerId); }
    };
    const fetchSpy = vi.fn(() => {
      throw new Error("offline catalog hydration must not access the network");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      expect((await listPiAuthStatuses(credentials)).find(
        (status) => status.provider === "anthropic"
      )).toMatchObject({ status: "authenticated", authType: "oauth" });
      expect(listPiProviders().find((provider) => provider.id === "anthropic")?.authMethods)
        .toContainEqual(expect.objectContaining({
          kind: "oauth",
          billingMode: "subscription"
        }));
      const catalog = await loadPiRuntimeModelCatalog({ credentials, modelsStore });
      expect(catalog.specs).toContainEqual(expect.objectContaining({
        id: "radius/cached-model",
        providerId: "radius",
        upstreamModel: "cached-model",
        billingMode: "unpriced"
      }));
      const anthropicSubscription = catalog.specs.find((candidate) =>
        candidate.id === "anthropic/claude-fable-5");
      expect(anthropicSubscription).toMatchObject({
        id: "anthropic/claude-fable-5",
        providerId: "anthropic",
        billingMode: "subscription"
      });
      expect(anthropicSubscription?.pricing).toBeUndefined();
      expect(catalog.gatewayFactory({
        provider: "radius",
        model: "cached-model",
        maxRetries: 7,
        requestTimeoutMs: 10_000,
        idleTimeoutMs: 5_000
      })).toMatchObject({
        provider: "radius",
        model: "cached-model"
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("composes production fallback candidates and honors an explicit single-model route", () => {
    expect(productionModelCandidates(
      { provider: "deepseek", model: "auto" },
      { DEEPSEEK_MODEL: "deepseek-v4-pro" },
      BUILTIN_MODEL_SPECS,
      new Set(["deepseek", "glm"])
    ).map((item) => item.id)).toEqual(["deepseek/deepseek-v4-pro", "glm/glm-5.2"]);
    expect(productionModelCandidates(
      { provider: "glm", model: "auto", explicitSingleModelRoute: true },
      {},
      BUILTIN_MODEL_SPECS,
      new Set(["glm", "deepseek"])
    ).map((item) => item.id)).toEqual(["glm/glm-5.2"]);
    expect(productionModelCandidates(
      { provider: "deepseek", model: "auto" },
      {},
      BUILTIN_MODEL_SPECS,
      new Set(["deepseek"])
    ).map((item) => item.id)).toEqual(["deepseek/deepseek-v4-pro"]);
    expect(productionModelCandidates(
      { provider: "openai-codex", model: "gpt-5.6-terra" },
      {},
      BUILTIN_MODEL_SPECS,
      new Set(["openai-codex", "deepseek"])
    ).map((item) => item.id)).toEqual(["openai-codex/gpt-5.6-terra"]);

    const primary = spec("alpha/main", {
      providerId: "alpha",
      upstreamModel: "main",
      recommended: true
    });
    const fallback = spec("beta/backup", {
      providerId: "beta",
      upstreamModel: "backup",
      recommended: true
    });
    expect(productionModelCandidates(
      { provider: "alpha", model: "main" },
      {},
      [primary, fallback],
      new Set(["alpha", "beta"])
    ).map((item) => item.id)).toEqual(["alpha/main", "beta/backup"]);
  });

  it("retries transient subscription failures without routing them to paid providers", async () => {
    vi.useFakeTimers();
    try {
      const profile = freezeAgentProfile({
        id: "subscription-route",
        roleRoutes: {},
        toolAllow: null,
        toolDeny: [],
        skills: [],
        hooks: [],
        permissionMode: "deny",
        budget: { ...DEFAULT_PROFILE_BUDGET },
        mutationPolicy: {
          requirePlanBeforeMutation: true,
          checkpointBeforeMutation: true,
          reviewMode: "advisory"
        },
        allowedChildProfiles: []
      });
      for (const category of ["auth", "capacity", "rate_limit", "server", "network"] as const) {
        const calls: string[] = [];
        const gateways = createRoleGateways({
          provider: "openai-codex",
          model: "gpt-5.6-terra",
          modelDeadlineSec: 10,
          streamIdleSec: 5
        }, {
          gatewayFactory: ({ provider, model }) => gateway(`${provider}/${model}`, async () => {
            calls.push(provider);
            throw Object.assign(new Error(category), { category });
          })
        }, {
          profile,
          profileSource: "builtin",
          availableProfiles: [{ profile, source: "builtin" }]
        } as unknown as RuntimeCustomization, {
          OPENAI_API_KEY: "must-not-be-used",
          DEEPSEEK_API_KEY: "must-not-fallback",
          GLM_API_KEY: "must-not-fallback"
        });

        const failed = expect(gateways.orchestrator.complete(request())).rejects.toThrow(category);
        await vi.runAllTimersAsync();
        await failed;
        expect(new Set(calls)).toEqual(new Set(["openai-codex"]));
        expect(calls).toHaveLength(category === "auth" || category === "capacity" ? 1 : 11);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the bounded production retry schedule by default", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const profile = freezeAgentProfile({
        id: "retry-schedule",
        roleRoutes: {},
        toolAllow: null,
        toolDeny: [],
        skills: [],
        hooks: [],
        permissionMode: "deny",
        budget: { ...DEFAULT_PROFILE_BUDGET },
        mutationPolicy: {
          requirePlanBeforeMutation: true,
          checkpointBeforeMutation: true,
          reviewMode: "advisory"
        },
        allowedChildProfiles: []
      });
      let calls = 0;
      const gateways = createRoleGateways({
        provider: "openai-codex",
        model: "gpt-5.6-terra",
        modelDeadlineSec: 10,
        streamIdleSec: 5
      }, {
        gatewayFactory: ({ provider, model }) => gateway(`${provider}/${model}`, async () => {
          calls += 1;
          throw Object.assign(new Error("temporary server failure"), { category: "server" });
        })
      }, {
        profile,
        profileSource: "builtin",
        availableProfiles: [{ profile, source: "builtin" }]
      } as unknown as RuntimeCustomization, {});

      const failed = expect(gateways.orchestrator.complete(request())).rejects.toThrow("server");
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      const delays = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 32_000, 32_000, 32_000];
      for (const [index, delay] of delays.entries()) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(calls).toBe(index + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(calls).toBe(index + 2);
      }
      await failed;
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
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
      reasoningEffort?: string;
    }> = [];
    const configuredSpecs = [
      specConfig("deepseek/approx", "approx", "approximate", 100),
      specConfig("deepseek/exact", "exact", "exact", 300)
    ];
    const gateways = createRoleGateways({
      provider: "deepseek", model: "approx", modelDeadlineSec: 10, streamIdleSec: 5,
      streamActiveSec: 7, reasoningEffort: "max",
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
      && policy.idleTimeoutMs === 5_000 && policy.activeStreamTimeoutMs === 7_000
      && policy.reasoningEffort === "max")).toBe(true);
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
      [spec("deepseek/a", { billingMode: "unpriced", pricing: undefined })],
      [route({ candidates: ["deepseek/a"], maxAttempts: 1 })],
      (item) => gateway(item.id, async () => response("ok"))
    );
    expect(() => unpriced.resolve("main", { remainingBudgetMicroUsd: 10_000 })).toThrow("no eligible candidates");
    expect(unpriced.resolve("main", {
      remainingBudgetMicroUsd: 10_000,
      allowUnpricedCosts: true
    }).candidates.map((item) => item.id)).toEqual(["deepseek/a"]);
    const subscriptionSpec = spec("openai-codex/subscription", {
      providerId: "openai-codex",
      billingMode: "subscription",
      pricing: undefined
    });
    const subscription = new ModelRouter(
      [subscriptionSpec],
      [route({ candidates: [subscriptionSpec.id], maxAttempts: 1 })],
      (item) => gateway(item.id, async () => response("ok"))
    );
    expect(subscription.resolve("main", {
      remainingBudgetMicroUsd: 0
    }).candidates.map((item) => item.id)).toEqual([subscriptionSpec.id]);
    expect(modelReservationEstimate(subscriptionSpec, {})).toMatchObject({
      costMicroUsd: null
    });
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

  it("applies approximate tokenizer margin only to locally estimated input", () => {
    const fits = spec("deepseek/context-fit", {
      capabilities: { ...capabilities, contextWindowTokens: 1_600, maxOutputTokens: 100 }
    });
    const fittingRouter = new ModelRouter(
      [fits],
      [route({ candidates: [fits.id], maxAttempts: 1 })],
      (item) => gateway(item.id, async () => response("ok"))
    );
    expect(fittingRouter.resolve("main", {
      estimatedInputTokens: 1_000,
      maxOutputTokens: 100
    }).candidates.map((item) => item.id)).toEqual([fits.id]);

    const tooSmall = spec("deepseek/context-small", {
      capabilities: { ...capabilities, contextWindowTokens: 1_599, maxOutputTokens: 100 }
    });
    const constrainedRouter = new ModelRouter(
      [tooSmall],
      [route({ candidates: [tooSmall.id], maxAttempts: 1 })],
      (item) => gateway(item.id, async () => response("ok"))
    );
    try {
      constrainedRouter.resolve("main", {
        estimatedInputTokens: 1_000,
        maxOutputTokens: 100
      });
      throw new Error("Expected the undersized context window to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({
        code: "model_route_unavailable",
        rejected: [expect.objectContaining({
          modelSpecId: tooSmall.id,
          reason: "context",
          detail: expect.stringContaining("1600 tokens")
        })]
      });
    }

    expect(modelReservationEstimate(fits, {
      estimatedInputTokens: 1_000,
      maxOutputTokens: 100
    })).toMatchObject({ inputTokens: 1_500, outputTokens: 150 });
  });

  it("routes image prompts by model-visible cost instead of base64 transport size", async () => {
    const imageModel = spec("deepseek/image", {
      capabilities: {
        ...capabilities,
        contextWindowTokens: 10_000,
        maxOutputTokens: 2_000,
        imageInput: true
      }
    });
    const router = new ModelRouter(
      [imageModel],
      [route({ candidates: [imageModel.id], maxAttempts: 1 })],
      (item) => gateway(item.id, async () => response("image accepted"))
    );

    const result = await router.complete("orchestrator", "main", {
      messages: [{
        role: "user",
        content: "Inspect this screenshot",
        images: [{ mimeType: "image/png", data: "A".repeat(40_000) }]
      }],
      maxOutputTokens: 2_000,
      signal: new AbortController().signal
    });

    expect(result.message.content).toBe("image accepted");
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
    expect(result).toMatchObject({ modelSpecId: "glm/b", attempt: 1 });
    expect(result.usage).toMatchObject({
      inputTokens: expect.any(Number),
      providerReported: false,
      retryAttempt: 1,
      costMicroUsd: expect.any(Number)
    });
  });

  it("releases every gateway actually touched by a routed session", async () => {
    const releases: string[] = [];
    const routedGateways = new Map<string, ModelGateway>();
    const router = new ModelRouter(
      [spec("deepseek/a"), spec("glm/b")],
      [route()],
      (item) => {
        const existing = routedGateways.get(item.id);
        if (existing) return existing;
        const created: ModelGateway = {
          ...gateway(item.id, async () => {
            if (item.id === "deepseek/a") {
              throw Object.assign(new Error("busy"), { category: "rate_limit" });
            }
            return response("recovered");
          }),
          releaseSession(sessionId) {
            releases.push(`${item.id}:${sessionId}`);
          }
        };
        routedGateways.set(item.id, created);
        return created;
      }
    );
    const routed = new RoutedModelGateway({
      router,
      role: "orchestrator",
      routeId: "main",
      representative: gateway("representative", async () => response("unused"))
    });

    await routed.complete({ ...request(), sessionId: "routed-session" });
    await routed.releaseSession("routed-session");

    expect(releases.sort()).toEqual([
      "deepseek/a:routed-session",
      "glm/b:routed-session"
    ]);
  });

  it("keeps transport retries in the Sigma policy layer and reserves them", async () => {
    let calls = 0;
    const only = spec("metered-provider/a", { providerId: "metered-provider" });
    const representative = gateway(only.id, async () => response("unused"));
    const retrying = gateway(only.id, async () => {
      calls += 1;
      if (calls < 3) {
        throw Object.assign(new Error("temporary network failure"), { category: "network" });
      }
      return response("recovered");
    });
    const router = new ModelRouter(
      [only],
      [route({ candidates: [only.id], maxAttempts: 1 })],
      () => retrying,
      { maxRetriesPerCandidate: 2 }
    );
    const result = await router.complete("orchestrator", "main", request());
    expect(calls).toBe(3);
    expect(result).toMatchObject({ modelSpecId: only.id, attempt: 2 });

    const routed = new RoutedModelGateway({
      router,
      role: "orchestrator",
      routeId: "main",
      representative
    });
    const plan = await routed.budgetPlan([{ role: "user", content: "hello" }], [], 100, 10_000);
    expect(plan.reservedModelTurns).toBe(3);
    expect(plan.attemptReservations).toHaveLength(3);

    let resourceCalls = 0;
    const resourceRetry = new ModelRouter(
      [only],
      [route({ candidates: [only.id], maxAttempts: 1 })],
      () => gateway(only.id, async () => {
        resourceCalls += 1;
        if (resourceCalls < 3) {
          throw Object.assign(new Error("provider resources are insufficient"), {
            category: "capacity"
          });
        }
        return response("resource recovered");
      }),
      { maxRetriesPerCandidate: 2 }
    );
    await expect(resourceRetry.complete("orchestrator", "main", request()))
      .resolves.toMatchObject({ modelSpecId: only.id, attempt: 2 });
    expect(resourceCalls).toBe(3);

    let capacityCalls = 0;
    const subscriptionOnly = spec("openai-codex/gpt-5.6-terra", {
      providerId: "openai-codex",
      upstreamModel: "gpt-5.6-terra",
      billingMode: "subscription",
      pricing: undefined
    });
    const exhausted = new ModelRouter(
      [subscriptionOnly],
      [route({ candidates: [subscriptionOnly.id], maxAttempts: 1 })],
      () => gateway(subscriptionOnly.id, async () => {
        capacityCalls += 1;
        throw Object.assign(new Error("allowance exhausted"), { category: "capacity" });
      }),
      { maxRetriesPerCandidate: 2 }
    );
    await expect(exhausted.complete("orchestrator", "main", request())).rejects.toMatchObject({
      category: "capacity",
      attempts: 1
    });
    expect(capacityCalls).toBe(1);
  });

  it("retries only the same model after a reasoning-only transient stream failure", async () => {
    const only = spec("deepseek/a");
    let reasoningAttempts = 0;
    const reasoningOnly: ModelGateway = {
      ...gateway(only.id, async () => response("unused")),
      async *stream() {
        reasoningAttempts += 1;
        yield { type: "reasoning", delta: `attempt-${reasoningAttempts}` } as const;
        if (reasoningAttempts === 1) {
          throw Object.assign(new Error("transient stream failure"), { category: "server" });
        }
        yield { type: "done", response: response("recovered") } as const;
      }
    };
    const retrying = new ModelRouter(
      [only],
      [route({ candidates: [only.id], maxAttempts: 1 })],
      () => reasoningOnly,
      { maxRetriesPerCandidate: 1 }
    );
    const events = [];
    for await (const event of retrying.stream("orchestrator", "main", request())) events.push(event);
    expect(reasoningAttempts).toBe(2);
    expect(events.map((event) => event.type)).toEqual(["reasoning", "reasoning", "done"]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      response: { message: { content: "recovered" }, attempt: 1 }
    });

    let contentAttempts = 0;
    const partialContent: ModelGateway = {
      ...gateway(only.id, async () => response("unused")),
      async *stream() {
        contentAttempts += 1;
        yield { type: "content", delta: "partial" } as const;
        throw Object.assign(new Error("transient stream failure"), { category: "network" });
      }
    };
    const blocked = new ModelRouter(
      [only],
      [route({ candidates: [only.id], maxAttempts: 1 })],
      () => partialContent,
      { maxRetriesPerCandidate: 1 }
    );
    const consume = async (): Promise<void> => {
      for await (const _event of blocked.stream("orchestrator", "main", request())) { /* consume */ }
    };
    await expect(consume()).rejects.toMatchObject({ semanticDelta: true, attempts: 1 });
    expect(contentAttempts).toBe(1);
  });

  it("retries an interrupted stream only before durable output", async () => {
    const only = spec("deepseek/a");
    let attempts = 0;
    const interrupted: ModelGateway = {
      ...gateway(only.id, async () => response("unused")),
      async *stream() {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("transport ended"), { category: "network" });
        }
        yield { type: "done", response: response("recovered") } as const;
      }
    };
    const router = new ModelRouter(
      [only],
      [route({ candidates: [only.id], maxAttempts: 1 })],
      () => interrupted,
      { maxRetriesPerCandidate: 1 }
    );

    const events = [];
    for await (const event of router.stream("orchestrator", "main", request())) events.push(event);

    expect(attempts).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "done",
      response: { message: { content: "recovered" }, attempt: 1 }
    });
  });

  it("retries one opaque protocol failure on the same model before committed output", async () => {
    const only = spec("deepseek/a");
    let completeAttempts = 0;
    const completeGateway = gateway(only.id, async () => {
      completeAttempts += 1;
      if (completeAttempts === 1) {
        throw Object.assign(new Error("opaque response failure"), {
          category: "protocol",
          diagnostics: { doneReceived: false, lastEventType: "error" }
        });
      }
      return response("recovered");
    });
    const completeRouter = new ModelRouter(
      [only],
      [route({ candidates: [only.id], maxAttempts: 1 })],
      () => completeGateway,
      { maxRetriesPerCandidate: 3 }
    );

    await expect(completeRouter.complete("orchestrator", "main", request()))
      .resolves.toMatchObject({ attempt: 1, message: { content: "recovered" } });
    expect(completeAttempts).toBe(2);

    let streamAttempts = 0;
    const streamGateway: ModelGateway = {
      ...gateway(only.id, async () => response("unused")),
      async *stream() {
        streamAttempts += 1;
        yield { type: "reasoning", delta: "uncommitted reasoning" } as const;
        if (streamAttempts === 1) {
          throw Object.assign(new Error("opaque stream failure"), {
            category: "protocol",
            diagnostics: { doneReceived: false, lastEventType: "error" }
          });
        }
        yield { type: "done", response: response("stream recovered") } as const;
      }
    };
    const streamRouter = new ModelRouter(
      [only],
      [route({ candidates: [only.id], maxAttempts: 1 })],
      () => streamGateway,
      { maxRetriesPerCandidate: 3 }
    );
    const events = [];
    for await (const event of streamRouter.stream("orchestrator", "main", request())) events.push(event);
    expect(streamAttempts).toBe(2);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      response: { attempt: 1, message: { content: "stream recovered" } }
    });
  });

  it("does not retry structured or repeatedly failing protocol responses", async () => {
    const only = spec("deepseek/a");
    let structuredAttempts = 0;
    const structured = new ModelRouter(
      [only],
      [route({ candidates: [only.id], maxAttempts: 1 })],
      () => gateway(only.id, async () => {
        structuredAttempts += 1;
        throw Object.assign(new Error("invalid request"), {
          category: "protocol",
          diagnostics: { providerErrorCode: "invalid_prompt", httpStatus: 400 }
        });
      }),
      { maxRetriesPerCandidate: 3 }
    );
    await expect(structured.complete("orchestrator", "main", request()))
      .rejects.toMatchObject({ category: "protocol", attempts: 1 });
    expect(structuredAttempts).toBe(1);

    let opaqueAttempts = 0;
    const opaque = new ModelRouter(
      [only],
      [route({ candidates: [only.id], maxAttempts: 1 })],
      () => gateway(only.id, async () => {
        opaqueAttempts += 1;
        throw Object.assign(new Error("opaque response failure"), {
          category: "protocol",
          diagnostics: { doneReceived: false, lastEventType: "error" }
        });
      }),
      { maxRetriesPerCandidate: 3 }
    );
    await expect(opaque.complete("orchestrator", "main", request()))
      .rejects.toMatchObject({ category: "protocol", attempts: 2 });
    expect(opaqueAttempts).toBe(2);
  });

  it("uses abortable exponential backoff only between same-provider retries", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const only = spec("deepseek/a");
      const router = new ModelRouter(
        [only],
        [route({ candidates: [only.id], maxAttempts: 1 })],
        () => gateway(only.id, async () => {
          calls += 1;
          if (calls < 3) {
            throw Object.assign(new Error("temporary server failure"), { category: "server" });
          }
          return response("recovered after backoff");
        }),
        {
          maxRetriesPerCandidate: 2,
          retryBaseDelayMs: 2_000,
          retryMaxDelayMs: 60_000
        }
      );

      const pending = router.complete("orchestrator", "main", request());
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({
        modelSpecId: only.id,
        attempt: 2
      });
      expect(calls).toBe(3);

      const controller = new AbortController();
      const cancellation = new Error("cancel retry backoff");
      let cancelledCalls = 0;
      const cancelledRouter = new ModelRouter(
        [only],
        [route({ candidates: [only.id], maxAttempts: 1 })],
        () => gateway(only.id, async () => {
          cancelledCalls += 1;
          throw Object.assign(new Error("temporary server failure"), { category: "server" });
        }),
        { maxRetriesPerCandidate: 2, retryBaseDelayMs: 2_000 }
      );
      const cancelled = cancelledRouter.complete("orchestrator", "main", {
        ...request(),
        signal: controller.signal
      });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(cancellation);
      await expect(cancelled).rejects.toBe(cancellation);
      expect(cancelledCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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
  it("uses the highest matching request-wide pricing tier for usage and reservation", () => {
    const tiered = spec("deepseek/tiered", {
      tokenizer: { id: "exact", accuracy: "exact" },
      pricing: {
        inputMicroUsdPerMillion: 1_000_000,
        outputMicroUsdPerMillion: 2_000_000,
        cacheReadMicroUsdPerMillion: 100_000,
        cacheWriteMicroUsdPerMillion: 1_000_000,
        effectiveAt: "2026-01-01",
        tiers: [{
          inputTokensAbove: 999,
          inputMicroUsdPerMillion: 3_000_000,
          outputMicroUsdPerMillion: 4_000_000,
          cacheReadMicroUsdPerMillion: 200_000,
          cacheWriteMicroUsdPerMillion: 5_000_000
        }]
      }
    });
    expect(normalizeUsage({
      request: request(),
      response: response("answer"),
      raw: {
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadTokens: 250,
        cacheWriteTokens: 50
      },
      pricing: tiered.pricing,
      latencyMs: 1,
      retryAttempt: 0
    }).costMicroUsd).toBe(2_800);
    expect(modelReservationEstimate(tiered, {
      estimatedInputTokens: 1_000,
      maxOutputTokens: 100
    }).costMicroUsd).toBe(3_400);
  });

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

  it("charges failed usage only for retry attempts that actually ran", async () => {
    const only = spec("deepseek/a");
    const representative = gateway(only.id, async () => response("unused"));
    const router = new ModelRouter(
      [only],
      [route({ candidates: [only.id], maxAttempts: 1 })],
      () => representative,
      { maxRetriesPerCandidate: 2 }
    );
    const routed = new RoutedModelGateway({
      router,
      role: "orchestrator",
      routeId: "main",
      representative
    });
    const prepared = await prepareModelBudget(
      routed,
      request().messages,
      [],
      100,
      10_000
    );
    const reservations = prepared.attemptReservations!;
    const reservedInput = reservations.reduce((total, item) => total + item.inputTokens, 0);
    const firstFailure = failedModelUsage(
      { sessionId: "session", runId: "run" },
      routed,
      "failed-once",
      prepared,
      5,
      "orchestrator",
      1
    );
    const secondFailure = failedModelUsage(
      { sessionId: "session", runId: "run" },
      routed,
      "failed-twice",
      prepared,
      5,
      "orchestrator",
      2
    );

    expect(reservations).toHaveLength(3);
    expect(prepared.estimatedInputTokens).toBe(reservations[0]!.inputTokens);
    expect(prepared.reserved.inputTokens).toBe(reservedInput);
    expect(firstFailure).toMatchObject({
      inputTokens: reservations[0]!.inputTokens,
      costMicroUsd: reservations[0]!.costMicroUsd,
      attempt: 1
    });
    expect(secondFailure).toMatchObject({
      inputTokens: reservations[0]!.inputTokens + reservations[1]!.inputTokens,
      costMicroUsd: (reservations[0]!.costMicroUsd ?? 0)
        + (reservations[1]!.costMicroUsd ?? 0),
      attempt: 2
    });
    expect(consumedBudget(firstFailure, prepared).modelTurns).toBe(1);
    expect(consumedBudget(secondFailure, prepared).modelTurns).toBe(2);
  });

  it("persists subscription usage as null cost while charging zero to the budget ledger", async () => {
    const subscriptionGateway: ModelGateway = {
      ...gateway("subscription", async () => response("ok")),
      provider: "openai-codex",
      model: "gpt-5.6-terra",
      async countTokens() { return 4; }
    };
    const prepared = await prepareModelBudget(
      subscriptionGateway,
      request().messages,
      [],
      10,
      10_000
    );
    expect(prepared.spec).toMatchObject({
      providerId: "openai-codex",
      billingMode: "subscription"
    });
    expect(prepared.reserved.costMicroUsd).toBe(0);

    const result = response("ok");
    result.usage = {
      ...result.usage,
      inputTokens: 4,
      outputTokens: 2,
      costMicroUsd: null,
      billingMode: "subscription"
    };
    const usage = successfulModelUsage(
      { sessionId: "session", runId: "run" },
      subscriptionGateway,
      "request",
      { messages: request().messages, tools: [] },
      result,
      prepared,
      5
    );
    expect(usage).toMatchObject({
      providerId: "openai-codex",
      costMicroUsd: null,
      billingMode: "subscription"
    });
    expect(consumedBudget(usage).costMicroUsd).toBe(0);
    expect(failedModelUsage(
      { sessionId: "session", runId: "run" },
      subscriptionGateway,
      "failed-request",
      prepared,
      5
    )).toMatchObject({
      costMicroUsd: null,
      billingMode: "subscription"
    });
  });

  it("matches built-in accounting metadata for providers outside the legacy trio", async () => {
    const genericSpec = BUILTIN_MODEL_SPECS.find((item) =>
      !["deepseek", "glm", "openai-codex"].includes(item.providerId)
      && item.billingMode === "metered"
      && item.pricing !== undefined);
    expect(genericSpec).toBeDefined();
    const genericGateway: ModelGateway = {
      ...gateway("generic-metered", async () => response("ok")),
      provider: genericSpec!.providerId,
      model: genericSpec!.upstreamModel,
      capabilities: genericSpec!.capabilities,
      async countTokens() { return 4; }
    };

    const prepared = await prepareModelBudget(
      genericGateway,
      request().messages,
      [],
      10,
      10_000_000
    );

    expect(prepared.spec?.id).toBe(genericSpec!.id);
    expect(prepared.reserved.costMicroUsd).toBeGreaterThan(0);
  });

  it("allows null persisted cost only when usage is explicitly subscription billed", () => {
    const unpriced = normalizeUsage({
      request: request(),
      response: response("answer"),
      latencyMs: 1,
      retryAttempt: 0
    });
    const identity = {
      usageId: "usage-subscription",
      requestId: "request-subscription",
      sessionId: "session",
      runId: "run",
      role: "orchestrator" as const,
      routeId: "default",
      providerId: "openai-codex",
      modelId: "openai-codex/gpt-5.6-terra",
      tokenizer: { id: "test", accuracy: "approximate" as const },
      occurredAt: "2026-07-29T00:00:00.000Z"
    };

    expect(() => toUsageRecord(unpriced, identity)).toThrow(
      "has no pricing for cost accounting"
    );
    expect(toUsageRecord({
      ...unpriced,
      billingMode: "subscription"
    }, identity)).toMatchObject({
      costMicroUsd: null,
      billingMode: "subscription"
    });
  });

  it("keeps aggregated reviewer subscription usage distinct from zero API cost", () => {
    const base: UsageRecord = {
      usageId: "usage-1",
      requestId: "review-1",
      sessionId: "session",
      runId: "run",
      role: "reviewer",
      routeId: "default",
      providerId: "openai-codex",
      modelId: "openai-codex/gpt-5.6-terra",
      tokenizerId: "test",
      tokenizerAccuracy: "approximate",
      providerReported: true,
      inputTokens: 4,
      outputTokens: 2,
      reasoningTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicroUsd: null,
      billingMode: "subscription",
      latencyMs: 2,
      attempt: 1,
      occurredAt: "2026-07-29T00:00:00.000Z"
    };
    const aggregated = aggregateReviewerUsage(
      {} as never,
      "review-aggregate",
      [base, { ...base, usageId: "usage-2" }],
      {} as never,
      {} as never
    );
    expect(aggregated).toMatchObject({
      billingMode: "subscription",
      costMicroUsd: null,
      inputTokens: 8,
      outputTokens: 4
    });
  });

});

function response(content: string): ModelResponse {
  return {
    message: { role: "assistant", content },
    finishReason: "stop",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      providerReported: false,
      costMicroUsd: null,
      latencyMs: 0,
      retryAttempt: 0
    }
  };
}
