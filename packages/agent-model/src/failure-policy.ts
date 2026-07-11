import type { ModelFailureCategory, ModelRoute } from "./catalog.js";

const MODEL_FAILURES = new Set<ModelFailureCategory>([
  "rate_limit", "capacity", "network", "server", "timeout",
  "auth", "configuration", "content_filter", "protocol"
]);
const NETWORK_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN"
]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"
]);

function numericStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number") return status;
  const match = error instanceof Error ? /\bHTTP\s+(\d{3})\b/u.exec(error.message) : undefined;
  return match ? Number(match[1]) : undefined;
}

function classifiedObjectFailure(error: unknown): ModelFailureCategory | undefined {
  if (!error || typeof error !== "object") return undefined;
  const category = (error as { category?: unknown }).category;
  if (typeof category === "string" && MODEL_FAILURES.has(category as ModelFailureCategory)) {
    return category as ModelFailureCategory;
  }
  const code = (error as { code?: unknown }).code;
  if (code === "provider_resource_exhausted") return "capacity";
  if (typeof code === "string" && NETWORK_CODES.has(code)) return "network";
  if (typeof code === "string" && TIMEOUT_CODES.has(code)) return "timeout";
  return undefined;
}

function classifiedStatusFailure(error: unknown): ModelFailureCategory | undefined {
  const status = numericStatus(error);
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status !== undefined && status >= 500) return "server";
  return undefined;
}

export function classifyModelFailure(error: unknown): ModelFailureCategory {
  const classified = classifiedObjectFailure(error) ?? classifiedStatusFailure(error);
  if (classified) return classified;
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  if (error instanceof TypeError) return "network";
  return "protocol";
}

export function canFallback(route: ModelRoute, category: ModelFailureCategory, semanticDelta: boolean): boolean {
  return !semanticDelta && route.fallbackOn.includes(category as (typeof route.fallbackOn)[number]);
}
