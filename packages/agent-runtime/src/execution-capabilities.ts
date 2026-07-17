import type { BrokerDoctorReport } from "agent-execution";
import {
  runtimeEnvironment,
  type RuntimeEnvironment,
  type ShellKind
} from "agent-platform";

const runtimePlatforms = new Map<string, NodeJS.Platform>([
  ["aix", "aix"],
  ["darwin", "darwin"],
  ["freebsd", "freebsd"],
  ["linux", "linux"],
  ["macos", "darwin"],
  ["openbsd", "openbsd"],
  ["sunos", "sunos"],
  ["win32", "win32"],
  ["windows", "win32"]
]);
const architecturePattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;

function invalidBrokerEnvironment(detail: string): Error {
  return Object.assign(new Error(`Invalid broker runtime environment: ${detail}`), {
    code: "broker_protocol_error"
  });
}

export function verifiedShellKinds(report: BrokerDoctorReport): ShellKind[] {
  if (!report.capabilities.foreground) return [];
  const verified = (report.capabilities.shells ?? [])
    .filter((shell) => shell.verified && shell.supportsChildProcesses === true);
  return [...new Set(verified.map((shell) => shell.kind))];
}

export function verifiedRuntimeCommands(report: BrokerDoctorReport): string[] {
  if (!report.capabilities.foreground && !report.capabilities.background) return [];
  return [...new Set((report.capabilities.runtimeCommands ?? [])
    .filter((command) => /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(command)))]
    .sort((left, right) => left.localeCompare(right));
}

export interface VerifiedNetworkPolicy {
  modes: Array<"none" | "full">;
  defaultMode: "none" | "full";
}

export function trustedOpenWorldAuthorization(config: {
  executionMode?: "sandboxed" | "disposable-container";
  unsafeHostExecRequested?: boolean;
  allowUnsafeHostExec?: boolean;
}): { openWorldAuthorization: "disposable-container" } | Record<string, never> {
  const disposable = config.executionMode === "disposable-container" || config.unsafeHostExecRequested === true;
  return disposable && config.allowUnsafeHostExec === true ? { openWorldAuthorization: "disposable-container" } : {};
}

export function verifiedNetworkPolicy(
  report: BrokerDoctorReport,
  configuredMode: "none" | "full"
): VerifiedNetworkPolicy {
  const brokerModes = new Set(report.capabilities.networkModes);
  const modes = (["none", "full"] as const).filter((mode) => brokerModes.has(mode));
  return {
    modes: [...modes],
    defaultMode: modes.includes(configuredMode) ? configuredMode : modes[0] ?? "none"
  };
}

export function brokerRuntimeEnvironment(report: BrokerDoctorReport): RuntimeEnvironment {
  const platform = runtimePlatforms.get(report.platform);
  if (!platform) throw invalidBrokerEnvironment(`unsupported platform '${report.platform}'.`);
  if (!architecturePattern.test(report.architecture)) {
    throw invalidBrokerEnvironment("architecture must be a short printable identifier.");
  }
  const availableShells = verifiedShellKinds(report);
  return {
    ...runtimeEnvironment(platform),
    arch: report.architecture,
    defaultShell: availableShells[0] ?? "none",
    availableShells,
    availableRuntimeCommands: verifiedRuntimeCommands(report),
    executionCapabilitiesVerified: true
  };
}
