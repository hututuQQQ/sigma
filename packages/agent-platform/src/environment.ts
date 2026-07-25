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
    return `The outer environment is broker-attested as disposable (${environment.enclosingContainerAttestationDigest}). When offered, use shell with target=environment for foreground system-level changes and process_spawn with target=environment for a background service that needs external runtime files; choose lifecycle=deliverable and call process_handoff only when that verified service must survive completion. The runtime supplies outer-container authority while protecting the workspace. Use shell with its default workspace target for observation and workspace write/edit/apply_patch tools for deliverables.`;
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
