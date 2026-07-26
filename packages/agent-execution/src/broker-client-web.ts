import { BrokerPolicyError, BrokerProtocolError } from "./errors.js";
import type { BrokerTransport } from "./broker-transport.js";
import type {
  BrokerRequestOptions,
  WebNetworkTarget,
  WebRequest,
  WebResponse
} from "./types.js";
import type { SecretRedactor } from "./redaction.js";

const MAX_REQUEST_BYTES = 256 * 1_024;
const MAX_RESPONSE_BYTES = 5 * 1_024 * 1_024;
const PAGE_HEADERS = new Set([
  "accept",
  "user-agent"
]);
const PROVIDER_HEADERS = new Set([
  ...PAGE_HEADERS,
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "x-api-key"
]);

function allowedPort(url: URL): boolean {
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return port === "80" || port === "443";
}

function canonicalOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrokerPolicyError(`${label} must be an absolute HTTP(S) URL.`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || !allowedPort(url) || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) {
    throw new BrokerPolicyError(`${label} must be a canonical HTTP(S) origin.`);
  }
  return url.origin;
}

function requestUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrokerPolicyError("Web request URL must be absolute.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || !allowedPort(url) || url.username || url.password || url.hash) {
    throw new BrokerPolicyError("Web request URL is outside the public HTTP(S) transport.");
  }
  return url;
}

function targets(value: readonly WebNetworkTarget[]): WebNetworkTarget[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new BrokerPolicyError("Web request requires 1..8 approved network targets.");
  }
  return value.map((target) => ({
    origin: canonicalOrigin(target.origin, "Approved Web target"),
    method: target.method
  }));
}

function providerPost(url: URL, method: string): boolean {
  return method === "POST" && url.protocol === "https:" && url.hostname === "mcp.exa.ai"
    && (url.port === "" || url.port === "443") && url.pathname === "/mcp"
    && (url.search === ""
      || url.search === "?tools=web_search_advanced_exa");
}

function headers(
  value: Record<string, string> | undefined,
  allowed: ReadonlySet<string>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value ?? {})) {
    const name = rawName.toLowerCase();
    if (!allowed.has(name) || name !== rawName.trim().toLowerCase()
      || typeof rawValue !== "string" || /[\r\n\0]/u.test(rawValue)
      || rawValue.length > 8_192) {
      throw new BrokerPolicyError(`Web request header '${rawName}' is not allowed.`);
    }
    result[name] = rawValue;
  }
  return result;
}

function positiveLimit(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) {
    throw new BrokerPolicyError(`${label} must be a positive integer no greater than ${maximum}.`);
  }
  return result;
}

function wireRequest(request: WebRequest): Record<string, unknown> {
  const url = requestUrl(request.url);
  if (request.method !== "GET" && request.method !== "POST") {
    throw new BrokerPolicyError("Web request method must be GET or POST.");
  }
  const isProviderPost = providerPost(url, request.method);
  if (request.method === "POST" && !isProviderPost) {
    throw new BrokerPolicyError("Web POST is restricted to the fixed Exa MCP endpoint.");
  }
  const approved = targets(request.networkTargets);
  if (request.networkApproved !== true
    || !approved.some((target) => target.origin === url.origin && target.method === request.method)) {
    throw new BrokerPolicyError("Web request URL and method require an exact per-call network approval.");
  }
  const body = Buffer.from(request.body ?? []);
  if (body.byteLength > MAX_REQUEST_BYTES) {
    throw new BrokerPolicyError("Web request body exceeds 256 KiB.");
  }
  if (request.method === "GET" && body.byteLength > 0) {
    throw new BrokerPolicyError("Web GET requests cannot include a body.");
  }
  return {
    url: url.href,
    method: request.method,
    headers: headers(request.headers, isProviderPost ? PROVIDER_HEADERS : PAGE_HEADERS),
    bodyBase64: body.toString("base64"),
    networkTargets: approved,
    networkApproved: true,
    timeoutMs: positiveLimit(request.timeoutMs, 30_000, 60_000, "Web request timeoutMs"),
    maxResponseBytes: positiveLimit(
      request.maxResponseBytes, MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES, "Web maxResponseBytes"
    )
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerProtocolError(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function responseHeaders(value: unknown): Record<string, string> {
  const input = record(value, "Web response headers");
  if (Object.values(input).some((item) => typeof item !== "string")) {
    throw new BrokerProtocolError("Web response headers are invalid.");
  }
  return input as Record<string, string>;
}

function base64Character(code: number): boolean {
  return (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || (code >= 48 && code <= 57)
    || code === 43
    || code === 47;
}

function validBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    if (!base64Character(value.charCodeAt(index))) return false;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  return true;
}

function bodyBytes(value: unknown): Buffer {
  const maximumEncodedLength = Math.ceil(MAX_RESPONSE_BYTES / 3) * 4;
  if (typeof value !== "string" || value.length > maximumEncodedLength || !validBase64(value)) {
    throw new BrokerProtocolError("Web response bodyBase64 is invalid.");
  }
  const body = Buffer.from(value, "base64");
  if (body.byteLength > MAX_RESPONSE_BYTES) {
    throw new BrokerProtocolError("Web response exceeds the protocol maximum.");
  }
  return body;
}

function parseResponse(value: unknown, redactor: SecretRedactor): WebResponse {
  const input = record(value, "Web response");
  if (!Number.isInteger(input.status) || Number(input.status) < 100 || Number(input.status) > 599
    || typeof input.finalUrl !== "string" || typeof input.truncated !== "boolean"
    || typeof input.redacted !== "boolean") {
    throw new BrokerProtocolError("Web response metadata is invalid.");
  }
  return {
    status: Number(input.status),
    finalUrl: input.finalUrl,
    headers: responseHeaders(input.headers),
    body: redactor.redactBytes(bodyBytes(input.bodyBase64)),
    ...(typeof input.redirectUrl === "string" ? { redirectUrl: input.redirectUrl } : {}),
    truncated: input.truncated,
    redacted: true
  };
}

export async function requestBrokerWeb(
  transport: BrokerTransport,
  redactor: SecretRedactor,
  request: WebRequest,
  options: BrokerRequestOptions
): Promise<WebResponse> {
  const timeoutMs = positiveLimit(
    request.timeoutMs ?? options.timeoutMs, 30_000, 60_000, "Web request timeoutMs"
  );
  const value = await transport.request(
    "web.request",
    wireRequest({ ...request, timeoutMs }),
    { ...options, timeoutMs }
  );
  return parseResponse(value, redactor);
}
