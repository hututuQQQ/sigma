import { createHash } from "node:crypto";
import path from "node:path";
import {
  ContainerAttestationInvalidError,
  ContainerUnavailableError
} from "./errors.js";
import type {
  BrokerDoctorReport,
  BrokerRuntimeClosureV1,
  ContainerExecutionConfig,
  ManagedSessionBindingRequestV1,
  TrustedManagedEnvironmentProofV1,
  TrustedManagedContainerAttestationV1
} from "./types.js";

export const MANAGED_ENVIRONMENT_PROTECTED_PATHS_V1 = [
  "/app",
  "/logs",
  "/opt/agent-cli",
  "/opt/sigma-control",
  "/opt/sigma-helper",
  "/opt/sigma-package",
  "/root/.docker",
  "/root/.ssh",
  "/run/credentials",
  "/run/secrets",
  "/run/sigma-oci",
  "/usr/local/bin/agent",
  "/usr/local/bin/bwrap"
] as const;

export interface PinnedContainerIdentity {
  engine: "docker" | "podman";
  target: "owned" | "managed";
  targetId: string;
  targetStartedAt: string;
  imageId: string;
  imageDigest?: string;
  helperDigest?: string;
  attestationDigest?: string;
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new ContainerAttestationInvalidError(
      `OCI broker report is missing '${name}'.`, { field: name }
    );
  }
  return value;
}

export function stableSha256(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(Object.keys(input as Record<string, unknown>)
      .sort()
      .filter((key) => (input as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, canonical((input as Record<string, unknown>)[key])]));
  };
  return "sha256:" + createHash("sha256")
    .update(JSON.stringify(canonical(value)), "utf8")
    .digest("hex");
}

export function containerIdentity(report: BrokerDoctorReport): PinnedContainerIdentity {
  const container = report.container;
  if (!container || container.backend !== "oci") {
    throw new ContainerUnavailableError(
      "The selected execution broker does not provide an OCI execution boundary.",
      { reportedBackend: container?.backend ?? null }
    );
  }
  if (!container.available) {
    throw new ContainerUnavailableError(
      container.reason ?? "The OCI execution backend is unavailable.",
      { engine: container.engine ?? null, target: container.target ?? null }
    );
  }
  if (!container.engine || !container.target) {
    throw new ContainerAttestationInvalidError(
      "OCI broker report has an incomplete engine or target identity."
    );
  }
  return {
    engine: container.engine,
    target: container.target,
    targetId: required(container.targetId, "targetId"),
    targetStartedAt: required(container.targetStartedAt, "targetStartedAt"),
    imageId: required(container.imageId, "imageId"),
    ...(container.imageDigest ? { imageDigest: container.imageDigest } : {}),
    ...(container.helperDigest ? { helperDigest: container.helperDigest } : {}),
    ...(container.attestationDigest ? { attestationDigest: container.attestationDigest } : {})
  };
}

export function ownedContainerImageDigest(image: string): string {
  const match = /@(sha256:[a-f0-9]{64})$/iu.exec(image);
  if (!match) {
    throw new ContainerAttestationInvalidError(
      "Owned OCI targets require an immutable image reference ending in '@sha256:<64 hex>'.",
      { image }
    );
  }
  return match[1]!.toLowerCase();
}

export function assertContainerSha256(value: string, name: string): void {
  if (!/^sha256:[a-f0-9]{64}$/iu.test(value)) {
    throw new ContainerAttestationInvalidError(
      `Trusted OCI '${name}' must be a sha256 digest.`, { field: name }
    );
  }
}

export function managedContainerAttestationDigest(
  attestation: Omit<TrustedManagedContainerAttestationV1, "attestationDigest">
): string {
  return stableSha256({
    protocolVersion: attestation.protocolVersion,
    engine: attestation.engine,
    selector: attestation.selector,
    targetId: attestation.targetId,
    targetStartedAt: attestation.targetStartedAt,
    imageId: attestation.imageId,
    imageDigest: attestation.imageDigest ?? null,
    labelsDigest: attestation.labelsDigest,
    helperDigest: attestation.helperDigest
  });
}

export function managedEnvironmentProofDigest(
  proof: Omit<TrustedManagedEnvironmentProofV1, "proofDigest">
): string {
  return stableSha256({
    protocolVersion: proof.protocolVersion,
    targetAttestationDigest: proof.targetAttestationDigest,
    targetId: proof.targetId,
    targetStartedAt: proof.targetStartedAt,
    rootKind: proof.rootKind,
    effectiveNetwork: proof.effectiveNetwork,
    disposable: proof.disposable,
    protectedPaths: proof.protectedPaths
  });
}

export function managedEnvironmentProofAvailable(
  attestation: TrustedManagedContainerAttestationV1 | undefined
): boolean {
  const proof = attestation?.managedEnvironment;
  if (!proof) return false;
  const expectedPaths = [...MANAGED_ENVIRONMENT_PROTECTED_PATHS_V1];
  return proof.protocolVersion === 1
    && proof.targetAttestationDigest === attestation!.attestationDigest
    && proof.targetId === attestation!.targetId
    && proof.targetStartedAt === attestation!.targetStartedAt
    && proof.rootKind === "container_cow"
    && proof.effectiveNetwork === "full"
    && proof.disposable === true
    && proof.protectedPaths.length === expectedPaths.length
    && proof.protectedPaths.every((item, index) => item === expectedPaths[index])
    && proof.proofDigest === managedEnvironmentProofDigest({
      protocolVersion: proof.protocolVersion,
      targetAttestationDigest: proof.targetAttestationDigest,
      targetId: proof.targetId,
      targetStartedAt: proof.targetStartedAt,
      rootKind: proof.rootKind,
      effectiveNetwork: proof.effectiveNetwork,
      disposable: proof.disposable,
      protectedPaths: proof.protectedPaths
    });
}

export function assertContainerExecutionConfig(
  config: ContainerExecutionConfig,
  managedAttestation?: TrustedManagedContainerAttestationV1
): void {
  if (config.target === "owned") {
    if (!config.image) {
      throw new ContainerAttestationInvalidError("Owned OCI targets require containerImage.");
    }
    ownedContainerImageDigest(config.image);
    if (managedAttestation) {
      throw new ContainerAttestationInvalidError(
        "Owned OCI targets cannot accept a managed target attestation."
      );
    }
    return;
  }
  if (!managedAttestation) {
    throw new ContainerAttestationInvalidError(
      "Managed OCI targets require a trusted launcher attestation. CLI and workspace inputs cannot provide it."
    );
  }
  if (managedAttestation.protocolVersion !== 1 || !managedAttestation.selector
    || !managedAttestation.targetId || !managedAttestation.targetStartedAt
    || !managedAttestation.imageId) {
    throw new ContainerAttestationInvalidError(
      "Managed OCI launcher attestation is incomplete."
    );
  }
  assertContainerSha256(managedAttestation.labelsDigest, "labelsDigest");
  assertContainerSha256(managedAttestation.helperDigest, "helperDigest");
  assertContainerSha256(managedAttestation.attestationDigest, "attestationDigest");
  if (managedAttestation.imageDigest) {
    assertContainerSha256(managedAttestation.imageDigest, "imageDigest");
  }
  const { attestationDigest, ...payload } = managedAttestation;
  if (managedContainerAttestationDigest(payload) !== attestationDigest) {
    throw new ContainerAttestationInvalidError(
      "Managed OCI launcher attestation digest is invalid."
    );
  }
  if (managedAttestation.managedEnvironment
    && !managedEnvironmentProofAvailable(managedAttestation)) {
    throw new ContainerAttestationInvalidError(
      "Managed environment launcher proof is invalid."
    );
  }
}

export function sameContainerIdentity(
  left: PinnedContainerIdentity,
  right: PinnedContainerIdentity
): boolean {
  return left.engine === right.engine && left.target === right.target
    && left.targetId === right.targetId && left.targetStartedAt === right.targetStartedAt
    && left.imageId === right.imageId && left.imageDigest === right.imageDigest
    && left.helperDigest === right.helperDigest
    && left.attestationDigest === right.attestationDigest;
}

export function containerRuntimeClosure(
  report: BrokerDoctorReport,
  observed: PinnedContainerIdentity
): BrokerRuntimeClosureV1 {
  const searchPaths = [...new Set(report.capabilities.executableSearchPaths ?? [])].sort();
  const runtimeCommands = [...new Set(report.capabilities.runtimeCommands ?? [])].sort();
  const targetAttestationDigest = observed.attestationDigest ?? stableSha256(observed);
  const runtimeDataDigest = report.capabilities.runtimeDataDigest;
  const payload = {
    protocolVersion: 1 as const,
    platform: report.platform,
    architecture: report.architecture,
    executableSearchPathsDigest: stableSha256(searchPaths),
    runtimeCommandsDigest: stableSha256(runtimeCommands),
    ...(runtimeDataDigest ? { runtimeDataDigest } : {}),
    targetAttestationDigest,
    complete: report.capabilities.runtimeCommandSnapshotComplete === true
      && searchPaths.length > 0
  };
  return { ...payload, digest: stableSha256(payload) };
}

export function canonicalManagedBindingRequest(
  request: ManagedSessionBindingRequestV1,
  options: { config: ContainerExecutionConfig; workspace?: string },
  observed: PinnedContainerIdentity
): ManagedSessionBindingRequestV1 {
  const targetPath = path.posix;
  if (request.protocolVersion !== 1
    || !/^[A-Za-z0-9_.-]{1,128}$/u.test(request.sessionId)
    || !targetPath.isAbsolute(request.workspace)
    || request.protectedPaths.some((item) => !targetPath.isAbsolute(item))) {
    throw new ContainerAttestationInvalidError("Managed session binding request is invalid.");
  }
  if (observed.target !== "managed") {
    throw new ContainerAttestationInvalidError(
      "Managed session binding is available only for launcher-attested managed targets."
    );
  }
  const configuredWorkspace = options.workspace && targetPath.normalize(options.workspace);
  if (!configuredWorkspace || targetPath.normalize(request.workspace) !== configuredWorkspace) {
    throw new ContainerAttestationInvalidError(
      "Managed session workspace differs from the launcher-bound workspace."
    );
  }
  if (request.network !== (options.config.network ?? "none")) {
    throw new ContainerAttestationInvalidError(
      "Managed session network differs from the launcher-bound network envelope."
    );
  }
  return {
    ...request,
    workspace: configuredWorkspace,
    protectedPaths: [...new Set(
      request.protectedPaths.map((item) => targetPath.normalize(item))
    )].sort()
  };
}
