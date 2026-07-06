import type { ProviderOptions } from "../types.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(options: ProviderOptions = {}) {
    super({
      provider: "deepseek",
      baseUrl: options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: options.apiKey ?? process.env.DEEPSEEK_API_KEY,
      apiKeyEnvName: "DEEPSEEK_API_KEY",
      model: options.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
      maxRetries: options.maxRetries,
      fetchImpl: options.fetchImpl
    });
  }
}
