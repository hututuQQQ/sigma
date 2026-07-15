import { createModelGateway } from "./registry.js";
import { ModelGatewayError } from "./catalog.js";

export interface ProviderHealthReport {
  ok: boolean;
  provider: "deepseek" | "glm";
  model: string;
  endpointHost: string;
  latencyMs: number;
  message: string;
  failureKind?: "api_error" | "network_error";
  errorCategory?: string;
}

const HEALTH_PROBE_MAX_OUTPUT_TOKENS = 32;

function endpointFor(provider: "deepseek" | "glm", baseUrl?: string): string {
  return baseUrl ?? (provider === "deepseek"
    ? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com"
    : process.env.GLM_BASE_URL ?? process.env.ZAI_BASE_URL ?? process.env.BIGMODEL_BASE_URL
      ?? "https://open.bigmodel.cn/api/paas/v4");
}

function endpointHost(endpoint: string): string {
  try { return new URL(endpoint).host || "unknown"; } catch { return "invalid"; }
}

function safeErrorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const key of [
    process.env.DEEPSEEK_API_KEY,
    process.env.GLM_API_KEY,
    process.env.ZAI_API_KEY,
    process.env.BIGMODEL_API_KEY
  ]) {
    if (key) message = message.split(key).join("[redacted]");
  }
  return message.replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]").slice(0, 800);
}

export async function checkProviderHealth(input: {
  provider: "deepseek" | "glm";
  model: string;
  signal: AbortSignal;
  baseUrl?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<ProviderHealthReport> {
  const endpoint = endpointFor(input.provider, input.baseUrl);
  const selectedModel = input.model === "auto" ? undefined : input.model;
  const startedAt = performance.now();
  const gateway = createModelGateway({
    provider: input.provider,
    model: selectedModel,
    baseUrl: endpoint,
    maxRetries: 0,
    requestTimeoutMs: input.requestTimeoutMs ?? 10_000,
    idleTimeoutMs: Math.min(input.requestTimeoutMs ?? 10_000, 5_000),
    fetchImpl: input.fetchImpl,
    wireProfile: { thinking: "disabled" }
  });
  const model = gateway.model;
  try {
    const response = await gateway.complete({
      messages: [{ role: "user", content: "Return exactly the text OK." }],
      maxOutputTokens: HEALTH_PROBE_MAX_OUTPUT_TOKENS,
      temperature: 0,
      signal: input.signal
    });
    const content = response.message.content.trim();
    const reasoning = response.message.reasoningContent?.trim() ?? "";
    const text = content || reasoning;
    if (!text) {
      throw new ModelGatewayError(
        `Provider returned no textual output in the assistant message (finish_reason=${response.finishReason}).`,
        "protocol"
      );
    }
    return {
      ok: true,
      provider: input.provider,
      model,
      endpointHost: endpointHost(endpoint),
      latencyMs: Math.round(performance.now() - startedAt),
      message: text.slice(0, 120)
    };
  } catch (error) {
    const category = error instanceof ModelGatewayError ? error.category : "network";
    return {
      ok: false,
      provider: input.provider,
      model,
      endpointHost: endpointHost(endpoint),
      latencyMs: Math.round(performance.now() - startedAt),
      message: safeErrorMessage(error),
      failureKind: category === "network" || category === "timeout" ? "network_error" : "api_error",
      errorCategory: category
    };
  }
}
