import type { BrokerDoctorReport } from "agent-execution";
import {
  runtimeEnvironment,
  type RuntimeEnvironment,
  type ShellKind
} from "agent-platform";

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

export function verifiedNetworkPolicy(
  report: BrokerDoctorReport,
  configuredMode: "none" | "full"
): VerifiedNetworkPolicy {
  const brokerModes = new Set(report.capabilities.networkModes);
  const configuredModes: Array<"none" | "full"> = configuredMode === "full"
    ? ["none", "full"] : ["none"];
  const modes = configuredModes.filter((mode) => brokerModes.has(mode));
  return {
    modes,
    defaultMode: modes.includes(configuredMode) ? configuredMode : modes[0] ?? "none"
  };
}

export function brokerRuntimeEnvironment(report: BrokerDoctorReport): RuntimeEnvironment {
  const reported = report.platform === "windows" ? "win32"
    : report.platform === "macos" ? "darwin" : report.platform;
  const platform = ["aix", "darwin", "freebsd", "linux", "openbsd", "sunos", "win32"]
    .includes(reported) ? reported as NodeJS.Platform : process.platform;
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
