import * as http from "node:http";

const LOOPBACK_BYPASSES = ["localhost", "127.0.0.1", "::1"] as const;

interface ProxyCapableHttpModule {
  setGlobalProxyFromEnv?: (environment?: NodeJS.ProcessEnv) => () => void;
}

export interface OutboundProxyEnvironment extends NodeJS.ProcessEnv {
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
  NO_PROXY: string;
}

let appliedFingerprint: string | undefined;
let restoreGlobalProxy: (() => void) | undefined;

function firstNonEmpty(
  environment: NodeJS.ProcessEnv,
  names: readonly string[]
): string[] {
  return names
    .map((name) => environment[name]?.trim())
    .filter((value): value is string => Boolean(value));
}

function normalizeProxyUrl(value: string): string | undefined {
  const candidate = value.includes("://") ? value : `http://${value}`;
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      return undefined;
    }
    return candidate;
  } catch {
    return undefined;
  }
}

function firstValidProxy(
  environment: NodeJS.ProcessEnv,
  names: readonly string[]
): string | undefined {
  for (const value of firstNonEmpty(environment, names)) {
    const normalized = normalizeProxyUrl(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function noProxyValue(environment: NodeJS.ProcessEnv): string {
  const configured = firstNonEmpty(environment, ["no_proxy", "NO_PROXY"])[0];
  if (configured === "*") return configured;
  const entries = (configured ?? "")
    .split(/[\s,]+/u)
    .filter(Boolean);
  const seen = new Set(entries.map((entry) => entry.toLowerCase()));
  for (const bypass of LOOPBACK_BYPASSES) {
    if (!seen.has(bypass)) entries.push(bypass);
  }
  return entries.join(",");
}

/**
 * Resolves conventional proxy variables without letting one malformed value
 * disable unrelated protocols. ALL_PROXY is accepted as a fallback even though
 * Node's built-in proxy dispatcher only reads HTTP_PROXY and HTTPS_PROXY.
 */
export function resolveOutboundProxyEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): OutboundProxyEnvironment | undefined {
  const allProxy = firstValidProxy(environment, ["all_proxy", "ALL_PROXY"]);
  const explicitHttpProxy = firstValidProxy(environment, ["http_proxy", "HTTP_PROXY"]);
  const explicitHttpsProxy = firstValidProxy(environment, ["https_proxy", "HTTPS_PROXY"]);
  const httpProxy = explicitHttpProxy ?? allProxy;
  const httpsProxy = explicitHttpsProxy ?? explicitHttpProxy ?? allProxy;
  if (!httpProxy && !httpsProxy) return undefined;
  return {
    ...(httpProxy ? { HTTP_PROXY: httpProxy } : {}),
    ...(httpsProxy ? { HTTPS_PROXY: httpsProxy } : {}),
    NO_PROXY: noProxyValue(environment)
  };
}

/**
 * Makes Node's global fetch and HTTP clients honor the resolved proxy policy.
 * Reconfiguration is synchronous and idempotent so CLI embedding tests and
 * long-lived ACP processes do not stack dispatchers.
 */
export function configureOutboundProxy(
  environment: NodeJS.ProcessEnv = process.env
): void {
  const resolved = resolveOutboundProxyEnvironment(environment);
  const fingerprint = resolved ? JSON.stringify(resolved) : undefined;
  if (fingerprint === appliedFingerprint) return;

  restoreGlobalProxy?.();
  restoreGlobalProxy = undefined;
  appliedFingerprint = undefined;
  if (!resolved) return;

  const setGlobalProxyFromEnv = (http as ProxyCapableHttpModule).setGlobalProxyFromEnv;
  if (!setGlobalProxyFromEnv) return;
  try {
    restoreGlobalProxy = setGlobalProxyFromEnv(resolved);
    appliedFingerprint = fingerprint;
  } catch {
    restoreGlobalProxy = undefined;
    appliedFingerprint = undefined;
  }
}
