import type { BrokerRuntimeClosure } from "./types.js";

export interface ManagedEnvironmentPrepareRequest {
  protocolVersion: 1;
  sessionId: string;
  requestedExecutable: string;
  packages: string[];
}

export interface ManagedEnvironmentPrepareResult {
  protocolVersion: 1;
  status: "prepared";
  sessionId: string;
  requestedExecutable: string;
  packages: string[];
  installedPackages: Array<{
    name: string;
    version: string;
    source: string;
    digest: string;
  }>;
  packageManager: "apt-get" | "apk" | "dnf" | "microdnf" | "yum";
  signaturePolicy: "trusted-system-package-manager-defaults";
  attemptDigest: string;
  installedEvidenceDigest: string;
  previousRuntimeClosureDigest: string;
  runtimeClosure: BrokerRuntimeClosure;
  receiptDigest: string;
}

export interface RuntimeDependencyObservation {
  protocolVersion: 1;
  requestedExecutable: string;
  status: "available" | "unavailable";
  source: "broker_launch";
  runtimeClosureDigest: string;
  managedRecoveryAvailable: boolean;
}
