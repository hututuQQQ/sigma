export type ShellKind = "powershell" | "cmd" | "bash";

export interface RuntimeEnvironment {
  platform: NodeJS.Platform;
  arch: string;
  defaultShell: ShellKind | "none";
  availableShells: ShellKind[];
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
    pathSeparator: platform === "win32" ? "\\" : "/"
  };
}

export function runtimePrompt(environment = runtimeEnvironment()): string {
  return `Runtime environment: platform=${environment.platform}; arch=${environment.arch}; defaultShell=${environment.defaultShell}; verifiedShells=${environment.availableShells.join(",") || "none"}; pathSeparator=${environment.pathSeparator}`;
}
