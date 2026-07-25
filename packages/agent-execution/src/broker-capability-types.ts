export interface BrokerVerifiedShell {
  kind: "powershell" | "cmd" | "bash";
  executable: string;
  verified: true;
  /** The sandbox proved that the shell can launch separately trusted executables. */
  supportsChildProcesses?: boolean;
}

export interface BrokerEnclosingContainerRootCapability {
  available: boolean;
  rootKind: "container_cow" | "unavailable";
  attestationDigest?: string;
  reason?: string;
}

export interface BrokerManagedEnvironmentCapability {
  available: boolean;
  prepare: boolean;
}
