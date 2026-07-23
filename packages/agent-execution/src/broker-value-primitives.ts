import { BrokerProtocolError } from "./errors.js";

const brokerPlatforms = new Set([
  "aix", "darwin", "freebsd", "linux", "macos", "openbsd", "sunos", "win32", "windows"
]);
const architecturePattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;

export function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new BrokerProtocolError(`${label} must be a string.`);
  return value;
}

export function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new BrokerProtocolError(`${label} must be boolean.`);
  return value;
}

export function brokerPlatform(value: unknown): string {
  const platform = stringValue(value, "Broker platform");
  if (!brokerPlatforms.has(platform)) {
    throw new BrokerProtocolError(`Broker platform '${platform}' is unsupported.`);
  }
  return platform;
}

export function brokerArchitecture(value: unknown): string {
  const architecture = stringValue(value, "Broker architecture");
  if (!architecturePattern.test(architecture)) {
    throw new BrokerProtocolError("Broker architecture must be a short printable identifier.");
  }
  return architecture;
}
