import type { ModelCapabilities, ModelGateway } from "agent-protocol";
import { OpenAIModelGateway } from "./openai-gateway.js";
import type { OpenAIWireProfile } from "./openai-wire.js";
import { builtinModelSpec, type ModelSpec } from "./catalog.js";
import { classifyModelFailure } from "./failure-policy.js";
import type { ProviderSpiV1 } from "./provider-spi.js";

export type SupportedProvider = "deepseek" | "glm";

export interface CreateGatewayOptions {
  provider: SupportedProvider;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxRetries?: number;
  requestTimeoutMs?: number;
  idleTimeoutMs?: number;
  activeStreamTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  wireProfile?: Partial<OpenAIWireProfile>;
}

export type CreateCatalogGatewayOptions = Omit<CreateGatewayOptions, "provider" | "model">;

export function defaultModel(provider: SupportedProvider, env: NodeJS.ProcessEnv = process.env): string {
  return providerAdapter(provider).defaultModel(env);
}

export function createModelGateway(options: CreateGatewayOptions): ModelGateway {
  const selectedModel = options.model ?? defaultModel(options.provider);
  const spec = builtinModelSpec(options.provider, selectedModel);
  return providerAdapter(options.provider).prepare(options, selectedModel, spec);
}

export function createModelGatewayForSpec(
  spec: ModelSpec,
  options: CreateCatalogGatewayOptions = {}
): ModelGateway {
  const gatewayOptions: CreateGatewayOptions = {
    ...options,
    provider: spec.providerId,
    model: spec.upstreamModel
  };
  return providerAdapter(spec.providerId).prepare(gatewayOptions, spec.upstreamModel, spec);
}

function deepseekGateway(options: CreateGatewayOptions, model: string, spec?: ModelSpec): ModelGateway {
  return new OpenAIModelGateway({
    ...commonGatewayOptions(options),
    provider: "deepseek",
    model,
    baseUrl: options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    apiKey: options.apiKey ?? process.env.DEEPSEEK_API_KEY,
    apiKeyName: "DEEPSEEK_API_KEY",
    wireProfile: {
      developerRole: "system",
      trailingInstructionRole: "latest_reminder",
      toolChoicePolicy: "non_thinking_only",
      thinking: "enabled",
      retryableFinishReasons: ["insufficient_system_resource"],
      ...options.wireProfile
    },
    capabilities: spec?.capabilities ?? { contextWindowTokens: 128_000, maxOutputTokens: 8_192, reasoning: true },
    pricing: spec?.pricing
  });
}

function glmGateway(options: CreateGatewayOptions, model: string, spec?: ModelSpec): ModelGateway {
  return new OpenAIModelGateway({
    ...commonGatewayOptions(options),
    provider: "glm",
    model,
    baseUrl: options.baseUrl ?? process.env.GLM_BASE_URL ?? process.env.ZAI_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
    apiKey: options.apiKey ?? process.env.GLM_API_KEY ?? process.env.ZAI_API_KEY ?? process.env.BIGMODEL_API_KEY,
    apiKeyName: "GLM_API_KEY, ZAI_API_KEY, or BIGMODEL_API_KEY",
    wireProfile: { developerRole: "system", ...options.wireProfile },
    capabilities: spec?.capabilities ?? { contextWindowTokens: 128_000, maxOutputTokens: 8_192, reasoning: true },
    pricing: spec?.pricing
  });
}

function commonGatewayOptions(options: CreateGatewayOptions) {
  return {
    maxRetries: options.maxRetries,
    requestTimeoutMs: options.requestTimeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
    activeStreamTimeoutMs: options.activeStreamTimeoutMs,
    fetchImpl: options.fetchImpl
  };
}

const defaultCapabilities: ModelCapabilities = {
  contextWindowTokens: 128_000,
  maxOutputTokens: 8_192,
  tools: true,
  parallelTools: false,
  reasoning: true,
  structuredOutput: false,
  promptCache: false,
  tokenizer: "approximate"
};

function sharedAdapter(id: SupportedProvider): Pick<
  ProviderSpiV1,
  "id" | "capabilities" | "stream" | "cancel" | "normalizeUsage" | "classifyError"
> {
  return {
    id,
    capabilities: (spec) => spec?.capabilities ?? defaultCapabilities,
    stream: (gateway, request) => gateway.stream(request),
    cancel: (controller, reason) => controller.abort(reason),
    normalizeUsage: (usage) => ({ ...usage }),
    classifyError: classifyModelFailure
  };
}

const providerAdapters: Readonly<Record<SupportedProvider, ProviderSpiV1>> = {
  deepseek: {
    ...sharedAdapter("deepseek"),
    defaultModel: (env) => env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
    prepare: deepseekGateway
  },
  glm: {
    ...sharedAdapter("glm"),
    defaultModel: (env) => env.GLM_MODEL ?? "glm-5.2",
    prepare: glmGateway
  }
};

export function providerAdapter(provider: SupportedProvider): ProviderSpiV1 {
  return providerAdapters[provider];
}
