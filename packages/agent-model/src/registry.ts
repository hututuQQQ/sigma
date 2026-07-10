import type { ModelGateway } from "agent-protocol";
import { OpenAIModelGateway } from "./openai-gateway.js";

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

export function defaultModel(provider: SupportedProvider, env: NodeJS.ProcessEnv = process.env): string {
  return provider === "deepseek" ? env.DEEPSEEK_MODEL ?? "deepseek-v4-pro" : env.GLM_MODEL ?? "glm-5.2";
}

export function createModelGateway(options: CreateGatewayOptions): ModelGateway {
  if (options.provider === "deepseek") {
    return new OpenAIModelGateway({
      provider: "deepseek",
      model: options.model ?? defaultModel("deepseek"),
      baseUrl: options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: options.apiKey ?? process.env.DEEPSEEK_API_KEY,
      apiKeyName: "DEEPSEEK_API_KEY",
      maxRetries: options.maxRetries,
      requestTimeoutMs: options.requestTimeoutMs,
      idleTimeoutMs: options.idleTimeoutMs,
      fetchImpl: options.fetchImpl,
      wireProfile: {
        developerRole: "system",
        supportsToolChoice: false,
        thinking: "enabled",
        retryableFinishReasons: ["insufficient_system_resource"]
      },
      capabilities: { contextWindowTokens: 128_000, maxOutputTokens: 8_192, reasoning: true }
    });
  }
  return new OpenAIModelGateway({
    provider: "glm",
    model: options.model ?? defaultModel("glm"),
    baseUrl: options.baseUrl ?? process.env.GLM_BASE_URL ?? process.env.ZAI_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
    apiKey: options.apiKey ?? process.env.GLM_API_KEY ?? process.env.ZAI_API_KEY ?? process.env.BIGMODEL_API_KEY,
    apiKeyName: "GLM_API_KEY, ZAI_API_KEY, or BIGMODEL_API_KEY",
    maxRetries: options.maxRetries,
    requestTimeoutMs: options.requestTimeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
    fetchImpl: options.fetchImpl,
    wireProfile: { developerRole: "system" },
    capabilities: { contextWindowTokens: 128_000, maxOutputTokens: 8_192, reasoning: true }
  });
}
