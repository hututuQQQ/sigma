export type ShellKind = "powershell" | "cmd" | "bash";

export interface RuntimeEnvironment {
  platform: NodeJS.Platform;
  arch: string;
  defaultShell: ShellKind;
  pathSeparator: string;
}

export function runtimeEnvironment(platform: NodeJS.Platform = process.platform): RuntimeEnvironment {
  return {
    platform,
    arch: process.arch,
    defaultShell: platform === "win32" ? "powershell" : "bash",
    pathSeparator: platform === "win32" ? "\\" : "/"
  };
}

export function runtimePrompt(environment = runtimeEnvironment()): string {
  return `Runtime environment: platform=${environment.platform}; arch=${environment.arch}; defaultShell=${environment.defaultShell}; pathSeparator=${environment.pathSeparator}`;
}
