export type ShellKind = "powershell" | "cmd" | "bash";

export interface RuntimeEnvironment {
  platform: NodeJS.Platform;
  arch: string;
  defaultShell: ShellKind | "none";
  availableShells: ShellKind[];
  availableRuntimeCommands: string[];
  executionCapabilitiesVerified: boolean;
  executionMode?: "sandboxed" | "disposable-container";
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
    executionCapabilitiesVerified: false,
    executionMode: "sandboxed",
    pathSeparator: platform === "win32" ? "\\" : "/"
  };
}

export function runtimePrompt(environment = runtimeEnvironment()): string {
  const disposableContainer = environment.executionMode === "disposable-container";
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
    `pathSeparator=${environment.pathSeparator}.`,
    `executionMode=${environment.executionMode ?? "sandboxed"}`,
    disposableContainer
      ? "Execution capabilities are open-world inside this user-declared disposable container: native container commands and package managers may be used when required by the task."
      : "Execution capabilities are closed-world: use shell only through a listed verified shell kind and use bare executable names only from verifiedRuntimeCommands.",
    disposableContainer
      ? "Writes outside the workspace are not covered by workspace checkpoint rollback; keep them limited to the disposable container."
      : "Do not probe or retry unlisted host commands."
  ].join("; ");
}
