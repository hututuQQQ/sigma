import type { BrokerDoctorReport } from "agent-execution";
import type { LanguageServerPreset } from "agent-code-intel";
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

export function verifiedRuntimeCommandSnapshotComplete(report: BrokerDoctorReport): boolean {
  const ociTarget = report.container?.available === true && report.container.backend === "oci";
  return (report.capabilities.foreground || report.capabilities.background)
    && report.capabilities.runtimeCommands !== undefined
    && report.capabilities.runtimeCommandSnapshotComplete === true
    && (!ociTarget || report.capabilities.executableSearchPaths !== undefined);
}

export interface VerifiedNetworkPolicy {
  modes: Array<"none" | "loopback" | "full">;
  defaultMode: "none" | "loopback" | "full";
}

export function verifiedNetworkPolicy(
  report: BrokerDoctorReport,
  configuredMode: "none" | "loopback" | "full"
): VerifiedNetworkPolicy {
  const brokerModes = new Set(report.capabilities.networkModes);
  const modes = (["none", "loopback", "full"] as const).filter((mode) => brokerModes.has(mode));
  if (!modes.includes(configuredMode)) {
    throw Object.assign(new Error(
      `Configured network mode '${configuredMode}' is not supported by the connected execution broker.`
    ), {
      code: "network_capability_unavailable",
      requestedMode: configuredMode,
      availableModes: [...modes]
    });
  }
  return {
    modes: [...modes],
    defaultMode: configuredMode
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
    runtimeCommandSnapshotComplete: verifiedRuntimeCommandSnapshotComplete(report),
    executionCapabilitiesVerified: true
  };
}

export function verifiedExecutionBackend(report: BrokerDoctorReport): "native" | "oci" {
  return report.container?.available === true && report.container.backend === "oci"
    ? "oci" : "native";
}

export function configuredRuntimeEnvironment(
  report: BrokerDoctorReport,
  executionMode: "sandboxed" | "container",
  languageServers: readonly LanguageServerPreset[]
): RuntimeEnvironment {
  const environment = brokerRuntimeEnvironment(report);
  return {
    ...environment,
    executionMode,
    availableLanguageServers: languageServers.filter((preset) => preset.available).map((preset) => preset.id)
  };
}
