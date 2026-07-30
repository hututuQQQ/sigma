import { spawnSync } from "node:child_process";
import * as http from "node:http";
import * as path from "node:path";

const LOOPBACK_BYPASSES = ["localhost", "127.0.0.1", "::1"] as const;
const WINDOWS_INTERNET_SETTINGS_KEY =
  String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`;

interface ProxyCapableHttpModule {
  setGlobalProxyFromEnv?: (environment?: NodeJS.ProcessEnv) => () => void;
}

export interface OutboundSystemProxy {
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
  NO_PROXY?: string;
}

export interface OutboundProxyEnvironment extends NodeJS.ProcessEnv {
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
  NO_PROXY: string;
}

export interface ConfigureOutboundProxyOptions {
  platform?: NodeJS.Platform;
  systemProxy?: OutboundSystemProxy | false;
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

function noProxyValue(
  environment: NodeJS.ProcessEnv,
  systemProxy: OutboundSystemProxy | undefined
): string {
  const configured = [
    firstNonEmpty(environment, ["no_proxy", "NO_PROXY"])[0],
    systemProxy?.NO_PROXY
  ].filter((value): value is string => Boolean(value));
  if (configured.some((value) => value.trim() === "*")) return "*";
  const entries = configured
    .join(",")
    .split(/[\s,]+/u)
    .filter(Boolean);
  const seen = new Set(entries.map((entry) => entry.toLowerCase()));
  for (const bypass of LOOPBACK_BYPASSES) {
    if (!seen.has(bypass)) entries.push(bypass);
  }
  return entries.join(",");
}

function normalizedSystemProxy(systemProxy: OutboundSystemProxy | undefined): {
  httpProxy: string | undefined;
  httpsProxy: string | undefined;
} {
  return {
    httpProxy: normalizeProxyUrl(systemProxy?.HTTP_PROXY ?? ""),
    httpsProxy: normalizeProxyUrl(systemProxy?.HTTPS_PROXY ?? "")
  };
}

/**
 * Resolves conventional proxy variables without letting one malformed value
 * disable unrelated protocols. ALL_PROXY is accepted as a fallback even though
 * Node's built-in proxy dispatcher only reads HTTP_PROXY and HTTPS_PROXY.
 */
export function resolveOutboundProxyEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  systemProxy?: OutboundSystemProxy
): OutboundProxyEnvironment | undefined {
  const allProxy = firstValidProxy(environment, ["all_proxy", "ALL_PROXY"]);
  const explicitHttpProxy = firstValidProxy(environment, ["http_proxy", "HTTP_PROXY"]);
  const explicitHttpsProxy = firstValidProxy(environment, ["https_proxy", "HTTPS_PROXY"]);
  const system = normalizedSystemProxy(systemProxy);
  const httpProxy = explicitHttpProxy ?? allProxy ?? system.httpProxy ?? system.httpsProxy;
  const httpsProxy = explicitHttpsProxy ?? explicitHttpProxy ?? allProxy
    ?? system.httpsProxy ?? system.httpProxy;
  if (!httpProxy && !httpsProxy) return undefined;
  return {
    ...(httpProxy ? { HTTP_PROXY: httpProxy } : {}),
    ...(httpsProxy ? { HTTPS_PROXY: httpsProxy } : {}),
    NO_PROXY: noProxyValue(environment, systemProxy)
  };
}

function proxyOverrideValue(value: string | undefined): string | undefined {
  const entries = (value ?? "")
    .split(/[;,\s]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith("<"));
  return entries.length > 0 ? entries.join(",") : undefined;
}

function windowsProxyServerEntries(proxyServer: string | undefined): {
  shared: string | undefined;
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  let shared: string | undefined;
  const segments = (proxyServer ?? "").split(";").map((value) => value.trim()).filter(Boolean);
  for (const segment of segments) {
    const separator = segment.indexOf("=");
    if (separator < 0) {
      shared ??= segment;
      continue;
    }
    const key = segment.slice(0, separator).trim().toLowerCase();
    const value = segment.slice(separator + 1).trim();
    if ((key === "http" || key === "https") && value) values.set(key, value);
  }
  return { shared, values };
}

/**
 * Parses the static proxy syntax used by Windows Internet Settings. Scheme
 * keys describe the request protocol; an unqualified host:port is shared.
 */
export function resolveWindowsStaticProxy(
  proxyServer: string | undefined,
  proxyOverride?: string
): OutboundSystemProxy | undefined {
  const { shared, values } = windowsProxyServerEntries(proxyServer);
  const httpProxy = normalizeProxyUrl(values.get("http") ?? shared ?? "");
  const httpsProxy = normalizeProxyUrl(values.get("https") ?? values.get("http") ?? shared ?? "");
  if (!httpProxy && !httpsProxy) return undefined;
  const noProxy = proxyOverrideValue(proxyOverride);
  return {
    ...(httpProxy ? { HTTP_PROXY: httpProxy } : {}),
    ...(httpsProxy ? { HTTPS_PROXY: httpsProxy } : {}),
    ...(noProxy ? { NO_PROXY: noProxy } : {})
  };
}

function queryWindowsInternetSetting(
  name: "ProxyEnable" | "ProxyServer" | "ProxyOverride",
  environment: NodeJS.ProcessEnv
): string | undefined {
  const windowsDirectory = environment.SystemRoot?.trim()
    || environment.WINDIR?.trim()
    || process.env.SystemRoot?.trim()
    || process.env.WINDIR?.trim();
  const executable = windowsDirectory
    ? path.join(windowsDirectory, "System32", "reg.exe")
    : "reg.exe";
  try {
    const result = spawnSync(executable, [
      "query", WINDOWS_INTERNET_SETTINGS_KEY, "/v", name
    ], {
      encoding: "utf8",
      env: environment,
      maxBuffer: 64 * 1024,
      timeout: 2_000,
      windowsHide: true
    });
    if (result.status !== 0 || !result.stdout) return undefined;
    const line = result.stdout
      .split(/\r?\n/u)
      .find((candidate) => candidate.trimStart().toLowerCase().startsWith(name.toLowerCase()));
    return line?.match(/\s+REG_(?:DWORD|SZ|EXPAND_SZ)\s+(.+?)\s*$/iu)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function resolveWindowsSystemProxy(environment: NodeJS.ProcessEnv): OutboundSystemProxy | undefined {
  const enabledValue = queryWindowsInternetSetting("ProxyEnable", environment);
  const enabled = enabledValue?.toLowerCase().startsWith("0x")
    ? Number.parseInt(enabledValue.slice(2), 16)
    : Number.parseInt(enabledValue ?? "", 10);
  if (!Number.isFinite(enabled) || enabled === 0) return undefined;
  return resolveWindowsStaticProxy(
    queryWindowsInternetSetting("ProxyServer", environment),
    queryWindowsInternetSetting("ProxyOverride", environment)
  );
}

/**
 * Makes Node's global fetch and HTTP clients honor the resolved proxy policy.
 * Reconfiguration is synchronous and idempotent so CLI embedding tests and
 * long-lived ACP processes do not stack dispatchers.
 */
export function configureOutboundProxy(
  environment: NodeJS.ProcessEnv = process.env,
  options: ConfigureOutboundProxyOptions = {}
): void {
  const configuredSystemProxy = options.systemProxy === false
    ? undefined
    : options.systemProxy;
  let resolved = resolveOutboundProxyEnvironment(environment, configuredSystemProxy);
  if (
    !resolved
    && options.systemProxy === undefined
    && (options.platform ?? process.platform) === "win32"
  ) {
    resolved = resolveOutboundProxyEnvironment(
      environment,
      resolveWindowsSystemProxy(environment)
    );
  }
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
