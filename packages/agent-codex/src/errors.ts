export type OpenAICodexErrorCode =
  | "auth_required"
  | "allowance_exhausted"
  | "rate_limited"
  | "network"
  | "timeout"
  | "server"
  | "protocol";

export type OpenAICodexFailureCategory =
  | "auth"
  | "capacity"
  | "rate_limit"
  | "network"
  | "timeout"
  | "server"
  | "protocol";

const SAFE_MESSAGES: Readonly<Record<OpenAICodexErrorCode, string>> = {
  auth_required: "ChatGPT authentication is required. Sign in again and retry.",
  allowance_exhausted: "The ChatGPT Codex subscription allowance is currently exhausted.",
  rate_limited: "ChatGPT Codex is rate limited. Retry later.",
  network: "Could not reach the ChatGPT Codex service.",
  timeout: "The ChatGPT Codex request timed out.",
  server: "The ChatGPT Codex service returned a server error.",
  protocol: "The ChatGPT Codex response could not be processed."
};

export class OpenAICodexError extends Error {
  readonly name = "OpenAICodexError";

  constructor(
    readonly code: OpenAICodexErrorCode,
    readonly category: OpenAICodexFailureCategory,
    readonly status?: number
  ) {
    super(SAFE_MESSAGES[code]);
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.toLowerCase();
  if (typeof error === "string") return error.toLowerCase();
  return "";
}

function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  const match = /\b(?:http|status|failed \()\s*(\d{3})\b/u.exec(errorText(error));
  return match?.[1] ? Number(match[1]) : undefined;
}

const AUTH_MARKERS = [
  "not configured",
  "authentication",
  "oauth",
  "unauthorized",
  "forbidden",
  "no api key",
  "access token",
  "sign in",
  "accountid"
] as const;

const ALLOWANCE_MARKERS = [
  "usage limit",
  "quota",
  "allowance",
  "available balance",
  "out of budget",
  "billing"
] as const;

function containsAny(text: string, markers: readonly string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}

function isAuthFailure(status: number | undefined, text: string): boolean {
  return status === 401 || status === 403 || containsAny(text, AUTH_MARKERS);
}

function isRateLimitFailure(status: number | undefined, text: string): boolean {
  return status === 429 || text.includes("rate limit") || text.includes("rate_limit");
}

function isTimeoutFailure(text: string): boolean {
  return text.includes("timeout") || text.includes("timed out");
}

function isServerFailure(status: number | undefined, text: string): boolean {
  return Boolean((status !== undefined && status >= 500)
    || containsAny(text, ["service unavailable", "upstream connect", "overloaded"]));
}

function isNetworkFailure(error: unknown, text: string): boolean {
  return error instanceof TypeError
    || containsAny(text, ["fetch failed", "network", "econn", "enotfound"]);
}

export function sanitizeOpenAICodexError(error: unknown): OpenAICodexError {
  if (error instanceof OpenAICodexError) return error;
  const text = errorText(error);
  const status = errorStatus(error);
  // Subscription exhaustion can be returned as either 403 or 429. Prefer the
  // explicit allowance signal over the generic status-code classification.
  if (containsAny(text, ALLOWANCE_MARKERS)) {
    return new OpenAICodexError("allowance_exhausted", "capacity", status);
  }
  if (isAuthFailure(status, text)) {
    return new OpenAICodexError("auth_required", "auth", status);
  }
  if (isRateLimitFailure(status, text)) {
    return new OpenAICodexError("rate_limited", "rate_limit", status);
  }
  if (isTimeoutFailure(text)) {
    return new OpenAICodexError("timeout", "timeout", status);
  }
  if (isServerFailure(status, text)) {
    return new OpenAICodexError("server", "server", status);
  }
  if (isNetworkFailure(error, text)) {
    return new OpenAICodexError("network", "network", status);
  }
  return new OpenAICodexError("protocol", "protocol", status);
}
