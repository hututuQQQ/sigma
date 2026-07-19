export type ShellKind = "powershell" | "cmd" | "bash";

export interface RuntimeEnvironment {
  platform: NodeJS.Platform;
  arch: string;
  defaultShell: ShellKind | "none";
  availableShells: ShellKind[];
  availableRuntimeCommands: string[];
  /** Whether absence from availableRuntimeCommands is a trusted negative result. */
  runtimeCommandSnapshotComplete: boolean;
  /** Trusted launcher-discovered language-server presets that are actually executable. */
  availableLanguageServers?: string[];
  executionCapabilitiesVerified: boolean;
  executionMode?: "sandboxed" | "container";
  pathSeparator: string;
}

export function runtimeEnvironment(platform: NodeJS.Platform = process.platform): RuntimeEnvironment {
  const defaultShell = platform === "win32" ? "cmd" : "bash";
  return {
    platform,
    arch: process.arch,
    // The Windows sandbox self-test exercises cmd.exe. Windows PowerShell is not
    // assumed here because its binary, output encoding, and AppContainer access
    // vary by host and are not currently part of the verified broker contract.
    defaultShell,
    availableShells: [defaultShell],
    availableRuntimeCommands: [],
    runtimeCommandSnapshotComplete: false,
    executionCapabilitiesVerified: false,
    executionMode: "sandboxed",
    pathSeparator: platform === "win32" ? "\\" : "/"
  };
}

export function runtimePrompt(environment = runtimeEnvironment()): string {
  const verifiedShells = environment.executionCapabilitiesVerified
    ? environment.availableShells : [];
  const verifiedRuntimeCommands = environment.executionCapabilitiesVerified
    ? environment.availableRuntimeCommands : [];
  const defaultShell = environment.executionCapabilitiesVerified
    ? environment.defaultShell : "none";
  return [
    `Runtime environment: platform=${environment.platform}`,
    `arch=${environment.arch}`,
    `executionCapabilities=${environment.executionCapabilitiesVerified ? "broker-verified" : "unverified"}`,
    `defaultShell=${defaultShell}`,
    `verifiedShells=${verifiedShells.join(",") || "none"}`,
    `verifiedRuntimeCommands=${verifiedRuntimeCommands.join(",") || "none"}`,
    `runtimeCommandSnapshot=${environment.runtimeCommandSnapshotComplete ? "complete" : "unknown"}`,
    `pathSeparator=${environment.pathSeparator}.`,
    `executionMode=${environment.executionMode ?? "sandboxed"}`,
    environment.executionMode === "container"
      ? "Execution uses an attested OCI target and a shared target workspace; bare commands resolve against target PATH, never control or host PATH, and target capability failures do not fall back to the host."
      : "Execution capabilities are closed-world: use shell only through a listed verified shell kind and use bare executable names only from verifiedRuntimeCommands. Do not probe or retry unlisted host commands."
  ].join("; ");
}
