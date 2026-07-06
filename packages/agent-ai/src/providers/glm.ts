import type { ProviderOptions } from "../types.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

function resolveApiKey(explicit?: string): string | undefined {
  return explicit ?? process.env.GLM_API_KEY ?? process.env.ZAI_API_KEY ?? process.env.BIGMODEL_API_KEY;
}

export class GlmProvider extends OpenAICompatibleProvider {
  constructor(options: ProviderOptions = {}) {
    super({
      provider: "glm",
      baseUrl:
        options.baseUrl ??
        process.env.GLM_BASE_URL ??
        process.env.ZAI_BASE_URL ??
        "https://open.bigmodel.cn/api/paas/v4",
      apiKey: resolveApiKey(options.apiKey),
      apiKeyEnvName: "GLM_API_KEY, ZAI_API_KEY, or BIGMODEL_API_KEY",
      model: options.model ?? process.env.GLM_MODEL ?? "glm-5.2",
      maxRetries: options.maxRetries,
      fetchImpl: options.fetchImpl
    });
  }
}
