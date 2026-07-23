import type { ScratchLeaseV1 } from "./scratch-lease-types.js";

export type ContainerEngine = "auto" | "docker" | "podman";
export type ResolvedContainerEngine = Exclude<ContainerEngine, "auto">;
export type ContainerTarget = "owned" | "managed";

/** Authenticated OCI identity returned by the broker. A report is diagnostic;
 * the broker must independently re-attest the target before every launch. */
export interface BrokerContainerReport {
  available: boolean;
  backend: "oci";
  engine?: ResolvedContainerEngine;
  target?: ContainerTarget;
  targetId?: string;
  targetStartedAt?: string;
  imageId?: string;
  imageDigest?: string;
  helperDigest?: string;
  attestationDigest?: string;
  reason?: string;
}

export interface ContainerExecutionConfig {
  engine: ContainerEngine;
  target: ContainerTarget;
  /** Maximum network capability granted to the target container. */
  network?: "none" | "loopback" | "full";
  /** Immutable digest reference. Required for an owned target. */
  image?: string;
}

/** Launcher-owned proof. It is deliberately absent from CLI/config types so a
 * workspace, model, or evaluator cannot select a managed engine target. */
export interface TrustedManagedContainerAttestationV1 {
  protocolVersion: 1;
  engine: ResolvedContainerEngine;
  selector: string;
  targetId: string;
  targetStartedAt: string;
  imageId: string;
  imageDigest?: string;
  labelsDigest: string;
  /** Digest of the exact root-owned, read-only helper tree executed in the managed target. */
  helperDigest: string;
  attestationDigest: string;
  /** Optional launcher proof required only when managed environment mutation
   * is enabled. Legacy read-only managed targets remain valid without it. */
  managedEnvironment?: TrustedManagedEnvironmentProofV1;
}

export interface TrustedManagedEnvironmentProofV1 {
  protocolVersion: 1;
  targetAttestationDigest: string;
  targetId: string;
  targetStartedAt: string;
  rootKind: "container_cow";
  effectiveNetwork: "full";
  disposable: true;
  protectedPaths: string[];
  proofDigest: string;
}

export interface BrokerRuntimeClosureV1 {
  protocolVersion: 1;
  digest: string;
  complete: boolean;
  platform: string;
  architecture: string;
  executableSearchPathsDigest: string;
  runtimeCommandsDigest: string;
  runtimeDataDigest?: string;
  targetAttestationDigest: string;
}

export interface ManagedSessionBindingRequestV1 {
  protocolVersion: 1;
  sessionId: string;
  workspace: string;
  network: "none" | "loopback" | "full";
  protectedPaths: string[];
}

/** Runtime-issued session capability. Model and workspace data cannot create
 * or widen it; observable paths are target paths, never host mount sources. */
export interface ManagedSessionBindingV1 extends ManagedSessionBindingRequestV1 {
  bindingId: string;
  lifetime: "runtime_session";
  targetId: string;
  targetStartedAt: string;
  targetAttestationDigest: string;
  protectedPathsDigest: string;
  runtimeClosure: BrokerRuntimeClosureV1;
  scratchLease: ScratchLeaseV1;
}
