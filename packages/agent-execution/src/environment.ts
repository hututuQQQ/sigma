import { BrokerPolicyError } from "./errors.js";
import type { EnvironmentRequest } from "./types.js";

const COMMON_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ"];
const WINDOWS_KEYS = ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "USERPROFILE"];
const POSIX_KEYS = ["TMPDIR", "SHELL"];
const SECRET_KEY = /(?:^|_)(?:api[_-]?key|secret|token|password|passwd|credential|private[_-]?key)(?:$|_)/i;

export function isSecretEnvironmentKey(name: string): boolean {
  return SECRET_KEY.test(name.replace(/([a-z])([A-Z])/g, "$1_$2"));
}

function sourceEntry(
  source: NodeJS.ProcessEnv,
  requested: string,
  platform: NodeJS.Platform
): [string, string] | undefined {
  const exact = source[requested];
  if (exact !== undefined) return [requested, exact];
  if (platform !== "win32") return undefined;
  const found = Object.keys(source).find((key) => key.toLowerCase() === requested.toLowerCase());
  const value = found === undefined ? undefined : source[found];
  return found !== undefined && value !== undefined ? [found, value] : undefined;
}

function baselineKeys(platform: NodeJS.Platform): string[] {
  return [...COMMON_KEYS, ...(platform === "win32" ? WINDOWS_KEYS : POSIX_KEYS)];
}

function applyOverride(
  result: Record<string, string>,
  name: string,
  value: string,
  platform: NodeJS.Platform
): void {
  if (isSecretEnvironmentKey(name)) throw new BrokerPolicyError(`Secret environment key '${name}' cannot be passed.`);
  if (name.length === 0 || name.includes("=") || name.includes("\0") || value.includes("\0")) {
    throw new BrokerPolicyError(`Environment entry '${name}' is malformed.`);
  }
  if (platform === "win32") {
    const existing = Object.keys(result).find((key) => key.toLowerCase() === name.toLowerCase());
    if (existing !== undefined) delete result[existing];
  }
  result[name] = value;
}

/** Builds an allowlist-only environment. The host environment is never spread wholesale. */
export function createMinimalEnvironment(
  request: EnvironmentRequest = {},
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const result: Record<string, string> = {};
  const requestedKeys = new Set([...baselineKeys(platform), ...(request.passthrough ?? [])]);
  for (const name of requestedKeys) {
    if (isSecretEnvironmentKey(name)) throw new BrokerPolicyError(`Secret environment key '${name}' cannot be inherited.`);
    const entry = sourceEntry(source, name, platform);
    if (entry) result[entry[0]] = entry[1];
  }
  for (const [name, value] of Object.entries(request.overrides ?? {})) {
    applyOverride(result, name, value, platform);
  }
  return result;
}
