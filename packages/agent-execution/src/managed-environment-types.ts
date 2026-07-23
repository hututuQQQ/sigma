import type { BrokerRuntimeClosureV1 } from "./types.js";

export interface ManagedEnvironmentPrepareRequestV1 {
  protocolVersion: 1;
  sessionId: string;
  requestedExecutable: string;
  packages: string[];
}

export interface ManagedEnvironmentPrepareResultV1 {
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
  runtimeClosure: BrokerRuntimeClosureV1;
  receiptDigest: string;
}

export interface RuntimeDependencyObservationV1 {
  protocolVersion: 1;
  requestedExecutable: string;
  status: "available" | "unavailable";
  source: "broker_launch";
  runtimeClosureDigest: string;
  managedRecoveryAvailable: boolean;
}
