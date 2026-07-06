import type { ModelClient, ProviderName, ProviderOptions } from "./types.js";
import { DeepSeekProvider } from "./providers/deepseek.js";
import { GlmProvider } from "./providers/glm.js";

export function createModelClient(provider: ProviderName, options: ProviderOptions = {}): ModelClient {
  if (provider === "deepseek") {
    return new DeepSeekProvider(options);
  }

  if (provider === "glm") {
    return new GlmProvider(options);
  }

  const exhaustive: never = provider;
  throw new Error(`Unsupported provider: ${exhaustive}`);
}
