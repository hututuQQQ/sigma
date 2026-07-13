import { createModelGateway } from "./registry.js";

export async function checkProviderHealth(input: {
  provider: "deepseek" | "glm";
  model: string;
  signal: AbortSignal;
}): Promise<string> {
  const gateway = createModelGateway({
    provider: input.provider,
    model: input.model === "auto" ? undefined : input.model,
    requestTimeoutMs: 30_000,
    idleTimeoutMs: 15_000
  });
  const response = await gateway.complete({
    messages: [{ role: "user", content: "Reply with exactly: ok" }],
    maxOutputTokens: 8,
    signal: input.signal
  });
  return response.message.content || "Provider returned an empty response.";
}
