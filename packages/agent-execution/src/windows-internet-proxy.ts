import { spawnSync } from "node:child_process";
import path from "node:path";
import { createMinimalEnvironment } from "./environment.js";

const WINDOWS_INTERNET_SETTINGS_KEY =
  String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`;
export interface WindowsInternetProxySettings {
  ProxyEnable?: string;
  ProxyServer?: string;
  ProxyOverride?: string;
}

function windowsDirectory(environment: NodeJS.ProcessEnv): string | undefined {
  return environment.SystemRoot?.trim()
    || environment.WINDIR?.trim()
    || process.env.SystemRoot?.trim()
    || process.env.WINDIR?.trim();
}

function internetSettingName(value: string): keyof WindowsInternetProxySettings | undefined {
  switch (value.toLowerCase()) {
    case "proxyenable": return "ProxyEnable";
    case "proxyserver": return "ProxyServer";
    case "proxyoverride": return "ProxyOverride";
    default: return undefined;
  }
}

function parseInternetSettings(stdout: string): WindowsInternetProxySettings | undefined {
  const values: WindowsInternetProxySettings = {};
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^\s*(ProxyEnable|ProxyServer|ProxyOverride)\s+REG_(?:DWORD|SZ|EXPAND_SZ)\s+(.+?)\s*$/iu
      .exec(line);
    const name = match?.[1] ? internetSettingName(match[1]) : undefined;
    if (name) values[name] = match?.[2]?.trim();
  }
  return Object.keys(values).length > 0 ? values : undefined;
}

/**
 * Read the fixed per-user Internet Settings key through the system reg.exe.
 * Process creation stays inside agent-execution and no caller controls the
 * executable, registry key, or command shape.
 */
export function readWindowsInternetProxySettings(
  environment: NodeJS.ProcessEnv = process.env
): WindowsInternetProxySettings | undefined {
  const directory = windowsDirectory(environment);
  if (!directory || !path.win32.isAbsolute(directory)) return undefined;
  const executable = path.win32.join(directory, "System32", "reg.exe");
  try {
    const result = spawnSync(executable, ["query", WINDOWS_INTERNET_SETTINGS_KEY], {
      encoding: "utf8",
      env: createMinimalEnvironment({}, environment, "win32"),
      maxBuffer: 64 * 1024,
      timeout: 2_000,
      windowsHide: true
    });
    if (result.status !== 0 || !result.stdout) return undefined;
    return parseInternetSettings(result.stdout);
  } catch {
    return undefined;
  }
}
