export type PiModelErrorCode =
  | "auth_required"
  | "allowance_exhausted"
  | "rate_limited"
  | "network"
  | "timeout"
  | "server"
  | "protocol";

export type PiModelFailureCategory =
  | "auth"
  | "capacity"
  | "rate_limit"
  | "network"
  | "timeout"
  | "server"
  | "protocol";

export type PiProviderEventType = "error" | "response_failed";

export interface PiModelErrorDiagnostics {
  provider?: string;
  model?: string;
  category?: PiModelFailureCategory;
  httpStatus?: number;
  totalDurationMs?: number;
  doneReceived?: boolean;
  transportEnded?: boolean;
  lastEventType?: string;
  hasContent?: boolean;
  hasReasoning?: boolean;
  hasToolCall?: boolean;
  providerErrorCode?: string;
  providerEventType?: PiProviderEventType;
}

interface PiModelErrorDetails extends ErrorOptions {
  providerErrorCode?: string;
  providerEventType?: PiProviderEventType;
  diagnostics?: PiModelErrorDiagnostics;
}

const SAFE_MESSAGES: Readonly<Record<PiModelErrorCode, string>> = {
  auth_required: "Model provider authentication is required. Sign in or configure credentials and retry.",
  allowance_exhausted: "The model provider allowance is currently exhausted.",
  rate_limited: "The model provider is rate limited. Retry later.",
  network: "Could not reach the model provider.",
  timeout: "The model provider request timed out.",
  server: "The model provider returned a server error.",
  protocol: "The model provider response could not be processed."
};

export class PiModelError extends Error {
  readonly name = "PiModelError";

  constructor(
    readonly code: PiModelErrorCode,
    readonly category: PiModelFailureCategory,
    readonly status?: number,
    details: PiModelErrorDetails = {}
  ) {
    super(SAFE_MESSAGES[code], details);
    this.providerErrorCode = details.providerErrorCode;
    this.providerEventType = details.providerEventType;
    this.diagnostics = details.diagnostics;
  }

  readonly providerErrorCode?: string;
  readonly providerEventType?: PiProviderEventType;
  readonly diagnostics?: PiModelErrorDiagnostics;
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

function providerFailureMetadata(error: unknown): {
  providerErrorCode?: string;
  providerEventType?: PiProviderEventType;
} {
  if (!error || typeof error !== "object") return {};
  const providerErrorCode = (error as { providerErrorCode?: unknown }).providerErrorCode;
  const providerEventType = (error as { providerEventType?: unknown }).providerEventType;
  return {
    ...(typeof providerErrorCode === "string" && /^[a-z0-9_.-]{1,128}$/iu.test(providerErrorCode)
      ? { providerErrorCode }
      : {}),
    ...(providerEventType === "error" || providerEventType === "response_failed"
      ? { providerEventType }
      : {})
  };
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

const AUTH_CODES = new Set([
  "authentication_error",
  "invalid_api_key",
  "unauthorized"
]);
const ALLOWANCE_CODES = new Set([
  "insufficient_quota",
  "usage_not_included"
]);
const RATE_LIMIT_CODES = new Set([
  "rate_limit",
  "rate_limit_exceeded"
]);
const NON_RETRYABLE_RESPONSE_CODES = new Set([
  "bio_policy",
  "content_filter",
  "context_length_exceeded",
  "cyber_policy",
  "invalid_prompt"
]);
const SERVER_CODES = new Set([
  "internal_error",
  "model_error",
  "server_error",
  "server_is_overloaded",
  "slow_down"
]);

type PiFailureClassification = readonly [PiModelErrorCode, PiModelFailureCategory];

function codeFailure(providerCode: string | undefined): PiFailureClassification | undefined {
  if (providerCode === undefined) return undefined;
  if (ALLOWANCE_CODES.has(providerCode)) return ["allowance_exhausted", "capacity"];
  if (AUTH_CODES.has(providerCode)) return ["auth_required", "auth"];
  if (RATE_LIMIT_CODES.has(providerCode)) return ["rate_limited", "rate_limit"];
  if (SERVER_CODES.has(providerCode)) return ["server", "server"];
  if (NON_RETRYABLE_RESPONSE_CODES.has(providerCode)) return ["protocol", "protocol"];
  return undefined;
}

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
    || containsAny(text, [
      "fetch failed",
      "network",
      "econn",
      "enotfound",
      "socket hang up",
      "unexpected eof",
      "premature close",
      "websocket stream closed",
      "stream closed before response.completed",
      "connection closed before response.completed",
      "stream ended before a terminal response event",
      "stream ended without a stop reason"
    ]);
}

function fallbackFailure(
  error: unknown,
  text: string,
  status: number | undefined,
  providerEventType: PiProviderEventType | undefined
): PiFailureClassification {
  if (containsAny(text, ALLOWANCE_MARKERS)) return ["allowance_exhausted", "capacity"];
  if (isAuthFailure(status, text)) return ["auth_required", "auth"];
  if (isRateLimitFailure(status, text)) return ["rate_limited", "rate_limit"];
  if (isTimeoutFailure(text)) return ["timeout", "timeout"];
  if (isServerFailure(status, text)) return ["server", "server"];
  if (isNetworkFailure(error, text)) return ["network", "network"];
  if (providerEventType === "response_failed") return ["server", "server"];
  return ["protocol", "protocol"];
}

export function sanitizePiModelError(
  error: unknown,
  additionalDiagnostics?: PiModelErrorDiagnostics
): PiModelError {
  const sanitized = sanitizePiModelErrorBase(error);
  if (!additionalDiagnostics) return sanitized;
  return new PiModelError(sanitized.code, sanitized.category, sanitized.status, {
    ...(sanitized.providerErrorCode
      ? { providerErrorCode: sanitized.providerErrorCode }
      : {}),
    ...(sanitized.providerEventType
      ? { providerEventType: sanitized.providerEventType }
      : {}),
    diagnostics: {
      ...sanitized.diagnostics,
      ...additionalDiagnostics,
      category: sanitized.category
    }
  });
}

function sanitizePiModelErrorBase(error: unknown): PiModelError {
  if (error instanceof PiModelError) return error;
  const text = errorText(error);
  const status = errorStatus(error);
  const metadata = providerFailureMetadata(error);
  const providerCode = metadata.providerErrorCode?.toLowerCase();
  const details = {
    ...metadata,
    diagnostics: {
      ...(status !== undefined && status >= 400 ? { httpStatus: status } : {}),
      ...(metadata.providerErrorCode ? { providerErrorCode: metadata.providerErrorCode } : {}),
      ...(metadata.providerEventType ? { providerEventType: metadata.providerEventType } : {})
    }
  };
  // Subscription exhaustion can arrive as either 403 or 429. Structured
  // provider codes take precedence over generic status or message markers.
  const [code, category] = codeFailure(providerCode)
    ?? fallbackFailure(error, text, status, metadata.providerEventType);
  return new PiModelError(code, category, status, details);
}
