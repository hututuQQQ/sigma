import type { ModelGateway } from "agent-protocol";
import { OpenAIModelGateway } from "./openai-gateway.js";
import { builtinModelSpec, type ModelSpec } from "./catalog.js";

export type SupportedProvider = "deepseek" | "glm";

export interface CreateGatewayOptions {
  provider: SupportedProvider;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxRetries?: number;
  requestTimeoutMs?: number;
  idleTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type CreateCatalogGatewayOptions = Omit<CreateGatewayOptions, "provider" | "model">;

export function defaultModel(provider: SupportedProvider, env: NodeJS.ProcessEnv = process.env): string {
  return provider === "deepseek" ? env.DEEPSEEK_MODEL ?? "deepseek-v4-pro" : env.GLM_MODEL ?? "glm-5.2";
}

export function createModelGateway(options: CreateGatewayOptions): ModelGateway {
  const selectedModel = options.model ?? defaultModel(options.provider);
  const spec = builtinModelSpec(options.provider, selectedModel);
  if (options.provider === "deepseek") return deepseekGateway(options, selectedModel, spec);
  return glmGateway(options, selectedModel, spec);
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
  return spec.providerId === "deepseek"
    ? deepseekGateway(gatewayOptions, spec.upstreamModel, spec)
    : glmGateway(gatewayOptions, spec.upstreamModel, spec);
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
      toolChoicePolicy: "non_thinking_only",
      thinking: "enabled",
      retryableFinishReasons: ["insufficient_system_resource"]
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
    wireProfile: { developerRole: "system" },
    capabilities: spec?.capabilities ?? { contextWindowTokens: 128_000, maxOutputTokens: 8_192, reasoning: true },
    pricing: spec?.pricing
  });
}

function commonGatewayOptions(options: CreateGatewayOptions) {
  return {
    maxRetries: options.maxRetries,
    requestTimeoutMs: options.requestTimeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
    fetchImpl: options.fetchImpl
  };
}
