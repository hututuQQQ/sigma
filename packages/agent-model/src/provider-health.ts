import {
  createPiModels,
  defaultPiModel,
  sanitizePiModelError,
  type CredentialStore,
  type Models
} from "agent-pi";
import { ModelGatewayError } from "./catalog.js";
import { classifyModelFailure } from "./failure-policy.js";

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
const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 10_000;

function endpointFor(provider: "deepseek" | "glm", baseUrl?: string): string {
  return baseUrl ?? (provider === "deepseek"
    ? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com"
    : process.env.GLM_BASE_URL ?? process.env.ZAI_BASE_URL ?? process.env.BIGMODEL_BASE_URL
      ?? "https://open.bigmodel.cn/api/paas/v4");
}

function endpointHost(endpoint: string): string {
  try { return new URL(endpoint).host || "unknown"; } catch { return "invalid"; }
}

function safeErrorMessage(error: unknown, secrets: readonly string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const key of [
    ...secrets,
    process.env.DEEPSEEK_API_KEY,
    process.env.GLM_API_KEY,
    process.env.ZAI_API_KEY,
    process.env.BIGMODEL_API_KEY
  ]) {
    if (key) message = message.split(key).join("[redacted]");
  }
  return message.replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]").slice(0, 800);
}

function categoryForStatus(status: number): ModelGatewayError["category"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "protocol";
}

function completionUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/u, "")}/chat/completions`;
}

function healthProbeSignal(parent: AbortSignal, timeoutMs: number): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parent.reason);
  if (parent.aborted) abortFromParent();
  else parent.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    const error = new Error(`Provider health request timed out after ${timeoutMs} ms.`);
    error.name = "TimeoutError";
    controller.abort(error);
  }, timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener("abort", abortFromParent);
    }
  };
}

function textualOutput(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return "";
  const message = choices[0] && typeof choices[0] === "object"
    ? (choices[0] as { message?: unknown }).message
    : undefined;
  if (!message || typeof message !== "object") return "";
  const candidate = message as { content?: unknown; reasoning_content?: unknown };
  const content = typeof candidate.content === "string" ? candidate.content.trim() : "";
  const reasoning = typeof candidate.reasoning_content === "string"
    ? candidate.reasoning_content.trim()
    : "";
  return content || reasoning;
}

async function executeProbe(input: {
  endpoint: string;
  model: string;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
  headers: Record<string, string>;
}): Promise<string> {
  const response = await input.fetchImpl(completionUrl(input.endpoint), {
    method: "POST",
    headers: { "content-type": "application/json", ...input.headers },
    body: JSON.stringify({
      model: input.model,
      messages: [{ role: "user", content: "Return exactly the text OK." }],
      max_tokens: HEALTH_PROBE_MAX_OUTPUT_TOKENS,
      temperature: 0,
      stream: false
    }),
    signal: input.signal
  });
  if (!response.ok) {
    throw new ModelGatewayError(
      `Provider health request failed with HTTP ${response.status}.`,
      categoryForStatus(response.status),
      false,
      response.status
    );
  }
  const text = textualOutput(await response.json());
  if (!text) throw new ModelGatewayError("Provider returned no textual output.", "protocol");
  return text;
}

async function probeAuthentication(
  models: Models,
  provider: "deepseek" | "glm",
  fallbackEndpoint: string,
  baseUrl: string | undefined
): Promise<{
  endpoint: string;
  headers: Record<string, string>;
  secrets: string[];
}> {
  let resolved: Awaited<ReturnType<Models["getAuth"]>>;
  try {
    resolved = await models.getAuth(provider);
  } catch (error) {
    // Auth adapters can include token-exchange details in the original error.
    // Sanitize before doctor output, even when no credential was returned.
    throw sanitizePiModelError(error);
  }
  if (!resolved) throw new ModelGatewayError("Provider authentication is not configured.", "auth");
  const headers = Object.fromEntries(Object.entries(resolved.auth.headers ?? {}).map(
    ([name, value]) => [name, String(value)]
  ));
  if (resolved.auth.apiKey && !Object.keys(headers).some(
    (name) => name.toLowerCase() === "authorization")) {
    headers.authorization = `Bearer ${resolved.auth.apiKey}`;
  }
  return {
    endpoint: baseUrl ?? resolved.auth.baseUrl ?? fallbackEndpoint,
    headers,
    secrets: [
      ...(resolved.auth.apiKey ? [resolved.auth.apiKey] : []),
      ...Object.values(headers)
    ]
  };
}

function failureCategory(error: unknown): ModelGatewayError["category"] {
  if (error instanceof ModelGatewayError) return error.category;
  const classified = classifyModelFailure(error);
  // A fetch implementation can reject with a plain Error for connection
  // failures. Protocol failures raised by this module are typed above.
  return classified === "protocol" ? "network" : classified;
}

export async function checkProviderHealth(input: {
  provider: "deepseek" | "glm";
  model: string;
  signal: AbortSignal;
  baseUrl?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  credentials?: CredentialStore;
  piModels?: Models;
}): Promise<ProviderHealthReport> {
  const models = input.piModels ?? createPiModels(input.credentials);
  const selectedModel = input.model === "auto"
    ? defaultPiModel(input.provider)
    : input.model;
  const model = selectedModel;
  let endpoint = endpointFor(input.provider, input.baseUrl);
  const startedAt = performance.now();
  let secrets: string[] = [];
  const abort = healthProbeSignal(
    input.signal,
    Math.max(1, input.requestTimeoutMs ?? DEFAULT_HEALTH_PROBE_TIMEOUT_MS)
  );
  try {
    const authentication = await probeAuthentication(
      models, input.provider, endpoint, input.baseUrl
    );
    endpoint = authentication.endpoint;
    secrets = authentication.secrets;
    const text = await executeProbe({
      endpoint,
      model,
      signal: abort.signal,
      fetchImpl: input.fetchImpl ?? globalThis.fetch,
      headers: authentication.headers
    });
    return {
      ok: true,
      provider: input.provider,
      model,
      endpointHost: endpointHost(endpoint),
      latencyMs: Math.round(performance.now() - startedAt),
      message: text.slice(0, 120)
    };
  } catch (error) {
    const category = failureCategory(error);
    return {
      ok: false,
      provider: input.provider,
      model,
      endpointHost: endpointHost(endpoint),
      latencyMs: Math.round(performance.now() - startedAt),
      message: safeErrorMessage(error, secrets),
      failureKind: category === "network" || category === "timeout" ? "network_error" : "api_error",
      errorCategory: category
    };
  } finally {
    abort.dispose();
  }
}
