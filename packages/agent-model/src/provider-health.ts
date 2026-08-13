import {
  createPiModels,
  defaultPiModel,
  getPiModel,
  getPiProvider,
  PiModelGateway,
  sanitizePiModelError,
  type CredentialStore,
  type Models
} from "agent-pi";
import { ModelGatewayError } from "./catalog.js";
import { classifyModelFailure } from "./failure-policy.js";

export interface ProviderHealthReport {
  ok: boolean;
  provider: string;
  model: string;
  endpointHost: string;
  latencyMs: number;
  message: string;
  failureKind?: "api_error" | "network_error";
  errorCategory?: string;
}

const HEALTH_PROBE_MAX_OUTPUT_TOKENS = 32;
const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 10_000;

function endpointFor(
  models: Models,
  provider: string,
  model: string,
  baseUrl?: string
): string {
  const definition = getPiModel(provider, model, models)
    ?? getPiProvider(provider, models)?.getModels()[0];
  return baseUrl ?? definition?.baseUrl ?? getPiProvider(provider, models)?.baseUrl ?? "unknown";
}

function endpointHost(endpoint: string): string {
  try { return new URL(endpoint).host || "unknown"; } catch { return "invalid"; }
}

function safeErrorMessage(error: unknown, secrets: readonly string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const key of secrets) {
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
  provider: string
): Promise<{
  endpoint?: string;
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
    ...(resolved.auth.baseUrl ? { endpoint: resolved.auth.baseUrl } : {}),
    headers,
    secrets: [
      ...(resolved.auth.apiKey ? [resolved.auth.apiKey] : []),
      ...Object.values(headers)
    ]
  };
}

async function executeGatewayProbe(input: {
  provider: string;
  model: string;
  endpoint?: string;
  signal: AbortSignal;
  timeoutMs: number;
  models: Models;
}): Promise<string> {
  const gateway = new PiModelGateway({
    provider: input.provider,
    model: input.model,
    models: input.models,
    ...(input.endpoint && input.endpoint !== "unknown" ? { baseUrl: input.endpoint } : {}),
    requestTimeoutMs: input.timeoutMs,
    idleTimeoutMs: input.timeoutMs,
    activeStreamTimeoutMs: input.timeoutMs
  });
  const response = await gateway.complete({
    messages: [{ role: "user", content: "Return exactly the text OK." }],
    maxOutputTokens: HEALTH_PROBE_MAX_OUTPUT_TOKENS,
    temperature: 0,
    signal: input.signal
  });
  const text = response.message.content.trim() || response.message.reasoningContent?.trim() || "";
  if (!text) throw new ModelGatewayError("Provider returned no textual output.", "protocol");
  return text;
}

async function executeProviderProbe(input: {
  provider: string;
  model: string;
  endpoint: string;
  signal: AbortSignal;
  timeoutMs: number;
  models: Models;
  authenticationHeaders: Record<string, string>;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const definition = getPiModel(input.provider, input.model, input.models)
    ?? getPiProvider(input.provider, input.models)?.getModels()[0];
  // The injected fetch path keeps the low-level HTTP contract testable.
  // Production probes always use Pi's provider transport so OAuth, ambient
  // credentials, headers and API-specific payloads remain provider-owned.
  if (input.fetchImpl && definition?.api === "openai-completions") {
    return executeProbe({
      endpoint: input.endpoint,
      model: input.model,
      signal: input.signal,
      fetchImpl: input.fetchImpl,
      headers: input.authenticationHeaders
    });
  }
  return executeGatewayProbe({
    provider: input.provider,
    model: input.model,
    endpoint: input.endpoint,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    models: input.models
  });
}

function failureCategory(error: unknown): ModelGatewayError["category"] {
  if (error instanceof ModelGatewayError) return error.category;
  const classified = classifyModelFailure(error);
  // A fetch implementation can reject with a plain Error for connection
  // failures. Protocol failures raised by this module are typed above.
  return classified === "protocol" ? "network" : classified;
}

export async function checkProviderHealth(input: {
  provider: string;
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
    ? defaultPiModel(input.provider, process.env, models)
    : input.model;
  const model = selectedModel;
  let endpoint = input.baseUrl ?? "unknown";
  const startedAt = performance.now();
  let secrets: string[] = [];
  const timeoutMs = Math.max(1, input.requestTimeoutMs ?? DEFAULT_HEALTH_PROBE_TIMEOUT_MS);
  const abort = healthProbeSignal(input.signal, timeoutMs);
  try {
    const authentication = await probeAuthentication(models, input.provider);
    endpoint = input.baseUrl
      ?? authentication.endpoint
      ?? endpointFor(models, input.provider, model);
    secrets = authentication.secrets;
    const text = await executeProviderProbe({
      provider: input.provider,
      model,
      endpoint,
      signal: abort.signal,
      timeoutMs,
      models,
      authenticationHeaders: authentication.headers,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
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
