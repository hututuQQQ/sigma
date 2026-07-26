export type ShellKind = "powershell" | "cmd" | "bash";

export interface RuntimeEnvironment {
  platform: NodeJS.Platform;
  arch: string;
  defaultShell: ShellKind | "none";
  availableShells: ShellKind[];
  availableRuntimeCommands: string[];
  executionCapabilitiesVerified: boolean;
  directExecutableResolution?: boolean;
  executionMode?: "sandboxed" | "container";
  writeScope?: "workspace" | "enclosing-container";
  enclosingContainerAttestationDigest?: string;
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
    directExecutableResolution: false,
    executionMode: "sandboxed",
    writeScope: "workspace",
    pathSeparator: platform === "win32" ? "\\" : "/"
  };
}

function environmentWritePrompt(
  environment: RuntimeEnvironment,
  enclosingContainerAvailable: boolean
): string {
  if (enclosingContainerAvailable) {
    return `The outer environment is broker-attested as disposable (${environment.enclosingContainerAttestationDigest}). When offered, use shell with target=environment for commands that need system-level changes. Processes, sockets, and temporary files created through target=environment remain in that outer boundary; inspect or control them with later target=environment calls because workspace-target calls use a separate sandbox view. A foreground environment command may also change explicitly declared workspace expectedChanges; those paths remain checkpointed while workspace metadata stays protected. Add background=true only for a service that needs external runtime files; background environment commands cannot write the workspace. Choose lifecycle=deliverable and call process_handoff only when that verified service must survive completion. Use the default workspace target for ordinary observation and workspace-only commands.`;
  }
  if (environment.writeScope === "enclosing-container") {
    return "The outer environment requests enclosing-container writes, but no verified environment shell is available.";
  }
  return "Process writes are limited to the checkpointed workspace.";
}

export function runtimePrompt(environment = runtimeEnvironment()): string {
  const verifiedShells = environment.executionCapabilitiesVerified
    ? environment.availableShells : [];
  const verifiedRuntimeCommands = environment.executionCapabilitiesVerified
    ? environment.availableRuntimeCommands : [];
  const defaultShell = environment.executionCapabilitiesVerified
    ? environment.defaultShell : "none";
  const enclosingContainerAvailable = environment.writeScope === "enclosing-container"
    && Boolean(environment.enclosingContainerAttestationDigest);
  return [
    `Runtime environment: platform=${environment.platform}`,
    `arch=${environment.arch}`,
    `executionCapabilities=${environment.executionCapabilitiesVerified ? "broker-verified" : "unverified"}`,
    `defaultShell=${defaultShell}`,
    `verifiedShells=${verifiedShells.join(",") || "none"}`,
    `verifiedRuntimeCommands=${verifiedRuntimeCommands.join(",") || "none"}`,
    `directExecutableResolution=${environment.directExecutableResolution === true}`,
    `pathSeparator=${environment.pathSeparator}.`,
    `executionMode=${environment.executionMode ?? "sandboxed"}`,
    `writeScope=${environment.writeScope ?? "workspace"}`,
    environmentWritePrompt(environment, enclosingContainerAvailable),
    environment.executionMode === "container"
      ? "Execution uses a real OCI backend with staged workspace merge; if it is unavailable the run is blocked."
      : environment.directExecutableResolution === true
      ? "The connected sandbox resolves, pins, and authorizes executable requests; verifiedRuntimeCommands are availability hints rather than a command-name authorization list."
      : "Execution capabilities are closed-world: use shell only through a listed verified shell kind and use bare executable names only from verifiedRuntimeCommands.",
    environment.directExecutableResolution === true
      ? "Do not repeatedly retry a command after the sandbox reports it missing or unauthorized."
      : "Do not probe or retry unlisted host commands."
  ].join("; ");
}
