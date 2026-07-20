import { createHash } from "node:crypto";
import {
  ContainerAttestationInvalidError,
  ContainerUnavailableError
} from "./errors.js";
import type {
  BrokerDoctorReport,
  BrokerRequestOptions,
  BrokerSandboxLeaseStatus,
  BrokerSandboxRevokeResult,
  ContainerExecutionConfig,
  ExecutionBroker,
  ExecutionRequest,
  ExecutionResult,
  ProcessHandle,
  ProcessHandoffResult,
  ProcessPollResult,
  ProcessSpawnRequest,
  RepositoryMetadataLeaseRequestV1,
  RepositoryMetadataLeaseV1,
  ScratchLeaseRequestV1, ScratchLeaseV1,
  TrustedManagedContainerAttestationV1
} from "./types.js";

export interface ContainerExecutionBrokerOptions {
  config: ContainerExecutionConfig;
  managedAttestation?: TrustedManagedContainerAttestationV1;
}

interface PinnedIdentity {
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
    throw new ContainerAttestationInvalidError(`OCI broker report is missing '${name}'.`, { field: name });
  }
  return value;
}

function identity(report: BrokerDoctorReport): PinnedIdentity {
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
    throw new ContainerAttestationInvalidError("OCI broker report has an incomplete engine or target identity.");
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
  const match = /@(sha256:[a-f0-9]{64})$/i.exec(image);
  if (!match) {
    throw new ContainerAttestationInvalidError(
      "Owned OCI targets require an immutable image reference ending in '@sha256:<64 hex>'.",
      { image }
    );
  }
  return match[1]!.toLowerCase();
}

function assertSha256(value: string, name: string): void {
  if (!/^sha256:[a-f0-9]{64}$/i.test(value)) {
    throw new ContainerAttestationInvalidError(`Trusted OCI '${name}' must be a sha256 digest.`, {
      field: name
    });
  }
}

export function managedContainerAttestationDigest(
  attestation: Omit<TrustedManagedContainerAttestationV1, "attestationDigest">
): string {
  const canonical = JSON.stringify({
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
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
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
      throw new ContainerAttestationInvalidError("Owned OCI targets cannot accept a managed target attestation.");
    }
    return;
  }
  if (!managedAttestation) {
    throw new ContainerAttestationInvalidError(
      "Managed OCI targets require a trusted launcher attestation. CLI and workspace inputs cannot provide it."
    );
  }
  if (managedAttestation.protocolVersion !== 1
    || !managedAttestation.selector
    || !managedAttestation.targetId
    || !managedAttestation.targetStartedAt
    || !managedAttestation.imageId) {
    throw new ContainerAttestationInvalidError("Managed OCI launcher attestation is incomplete.");
  }
  assertSha256(managedAttestation.labelsDigest, "labelsDigest");
  assertSha256(managedAttestation.helperDigest, "helperDigest");
  assertSha256(managedAttestation.attestationDigest, "attestationDigest");
  if (managedAttestation.imageDigest) assertSha256(managedAttestation.imageDigest, "imageDigest");
  const { attestationDigest, ...payload } = managedAttestation;
  if (managedContainerAttestationDigest(payload) !== attestationDigest) {
    throw new ContainerAttestationInvalidError("Managed OCI launcher attestation digest is invalid.");
  }
}

function sameIdentity(left: PinnedIdentity, right: PinnedIdentity): boolean {
  return left.engine === right.engine
    && left.target === right.target
    && left.targetId === right.targetId
    && left.targetStartedAt === right.targetStartedAt
    && left.imageId === right.imageId
    && left.imageDigest === right.imageDigest
    && left.helperDigest === right.helperDigest
    && left.attestationDigest === right.attestationDigest;
}

/**
 * Defense-in-depth adapter for a trusted OCI broker.
 *
 * It does not invoke an engine and cannot turn a native broker into an OCI
 * broker. The trusted launcher owns the engine socket and supplies the
 * underlying broker. This adapter pins and re-checks the authenticated target
 * identity before every operation, preventing a stale selector or replaced
 * container from silently becoming the execution target.
 */
export class AttestedContainerExecutionBroker implements ExecutionBroker {
  private pinned?: PinnedIdentity;

  constructor(
    private readonly broker: ExecutionBroker,
    private readonly options: ContainerExecutionBrokerOptions
  ) {
    assertContainerExecutionConfig(options.config, options.managedAttestation);
  }

  get lostProcessHandles(): readonly ProcessHandle[] { return this.broker.lostProcessHandles; }
  async connect(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    return this.accept(await this.broker.connect(signal));
  }

  async doctor(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    return this.accept(await this.broker.doctor(signal));
  }

  async setupSandbox(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    const report = this.broker.setupSandbox
      ? await this.broker.setupSandbox(signal)
      : await this.broker.connect(signal);
    return this.accept(report);
  }

  async repairSandbox(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    const report = this.broker.repairSandbox
      ? await this.broker.repairSandbox(signal)
      : this.broker.setupSandbox
        ? await this.broker.setupSandbox(signal)
        : await this.broker.connect(signal);
    return this.accept(report);
  }

  async sandboxLeaseStatus(workspacePath: string, signal?: AbortSignal): Promise<BrokerSandboxLeaseStatus> {
    await this.verify(signal);
    if (!this.broker.sandboxLeaseStatus) {
      throw new ContainerUnavailableError("OCI broker does not expose sandbox lease status.");
    }
    return await this.broker.sandboxLeaseStatus(workspacePath, signal);
  }

  async revokeSandboxLease(workspacePath: string, signal?: AbortSignal): Promise<BrokerSandboxRevokeResult> {
    await this.verify(signal);
    if (!this.broker.revokeSandboxLease) {
      throw new ContainerUnavailableError("OCI broker does not expose sandbox lease revocation.");
    }
    return await this.broker.revokeSandboxLease(workspacePath, signal);
  }

  async acquireRepositoryMetadataLease(
    request: RepositoryMetadataLeaseRequestV1,
    options?: BrokerRequestOptions
  ): Promise<RepositoryMetadataLeaseV1> {
    await this.verify(options?.signal);
    if (!this.broker.acquireRepositoryMetadataLease) {
      throw new ContainerUnavailableError("OCI broker does not expose repository metadata leases.");
    }
    return await this.broker.acquireRepositoryMetadataLease(request, options);
  }

  async acquireScratchLease(
    request: ScratchLeaseRequestV1,
    options?: BrokerRequestOptions
  ): Promise<ScratchLeaseV1> {
    await this.verify(options?.signal);
    if (!this.broker.acquireScratchLease) {
      throw new ContainerUnavailableError("OCI broker does not expose RuntimeSession scratch leases.");
    }
    return await this.broker.acquireScratchLease(request, options);
  }

  async releaseScratchLease(sessionId: string, options?: BrokerRequestOptions): Promise<void> {
    await this.verify(options?.signal);
    if (!this.broker.releaseScratchLease) {
      throw new ContainerUnavailableError("OCI broker does not expose RuntimeSession scratch lease release.");
    }
    await this.broker.releaseScratchLease(sessionId, options);
  }

  async execute(request: ExecutionRequest, options?: BrokerRequestOptions): Promise<ExecutionResult> {
    await this.verify(options?.signal);
    return await this.broker.execute(request, options);
  }

  async spawn(request: ProcessSpawnRequest, options?: BrokerRequestOptions): Promise<ProcessHandle> {
    await this.verify(options?.signal);
    return await this.broker.spawn(request, options);
  }

  async poll(handle: ProcessHandle, options?: BrokerRequestOptions): Promise<ProcessPollResult> {
    await this.verify(options?.signal);
    return await this.broker.poll(handle, options);
  }

  async write(handle: ProcessHandle, data: string, options?: BrokerRequestOptions): Promise<void> {
    await this.verify(options?.signal);
    await this.broker.write(handle, data, options);
  }

  async terminate(handle: ProcessHandle, options?: BrokerRequestOptions): Promise<ProcessPollResult> {
    await this.verify(options?.signal);
    return await this.broker.terminate(handle, options);
  }

  async handoff(handle: ProcessHandle, options?: BrokerRequestOptions): Promise<ProcessHandoffResult> {
    await this.verify(options?.signal);
    if (!this.broker.handoff) {
      throw new ContainerUnavailableError("OCI broker does not support process handoff.");
    }
    return await this.broker.handoff(handle, options);
  }

  async releaseOutputArtifacts(artifactIds: string[]): Promise<void> {
    // Artifact acknowledgement is control-plane cleanup and never launches a
    // target process. It must remain possible after a target disappears.
    await this.broker.releaseOutputArtifacts?.(artifactIds);
  }

  async close(): Promise<void> { await this.broker.close(); }

  private async verify(signal?: AbortSignal): Promise<void> {
    this.accept(await this.broker.doctor(signal));
  }

  private accept(report: BrokerDoctorReport): BrokerDoctorReport {
    this.assertSandbox(report);
    const observed = identity(report);
    if (observed.imageDigest) assertSha256(observed.imageDigest, "reported imageDigest");
    if (observed.helperDigest) assertSha256(observed.helperDigest, "reported helperDigest");
    if (observed.attestationDigest) assertSha256(observed.attestationDigest, "reported attestationDigest");
    this.assertConfiguredIdentity(observed);
    this.assertPinnedIdentity(observed);
    this.pinned ??= observed;
    return report;
  }

  private assertSandbox(report: BrokerDoctorReport): void {
    if (report.sandbox.backend === "oci" && report.sandbox.available && report.sandbox.selfTestPassed) return;
    throw new ContainerUnavailableError(
      report.sandbox.reason ?? "OCI broker sandbox self-test did not pass.",
      { sandboxBackend: report.sandbox.backend }
    );
  }

  private assertConfiguredIdentity(observed: PinnedIdentity): void {
    const configured = this.options.config;
    if (configured.engine !== "auto" && observed.engine !== configured.engine) {
      throw new ContainerAttestationInvalidError("OCI engine differs from the configured engine.", {
        expected: configured.engine, observed: observed.engine
      });
    }
    if (observed.target !== configured.target) {
      throw new ContainerAttestationInvalidError("OCI target mode differs from the configured target mode.", {
        expected: configured.target, observed: observed.target
      });
    }
    if (configured.target === "owned") {
      const configuredDigest = ownedContainerImageDigest(configured.image!);
      if (observed.imageDigest !== configuredDigest) {
        throw new ContainerAttestationInvalidError("Owned OCI target image digest differs from the pinned image.", {
          expected: configuredDigest, observed: observed.imageDigest ?? null
        });
      }
    } else {
      this.assertManagedAttestation(observed, this.options.managedAttestation!);
    }
  }

  private assertPinnedIdentity(observed: PinnedIdentity): void {
    if (this.pinned && !sameIdentity(this.pinned, observed)) {
      throw new ContainerAttestationInvalidError("OCI target identity changed after connection.", {
        expected: this.pinned, observed
      });
    }
  }

  private assertManagedAttestation(
    observed: PinnedIdentity,
    attestation: TrustedManagedContainerAttestationV1
  ): void {
    if (attestation.protocolVersion !== 1
      || observed.engine !== attestation.engine
      || observed.targetId !== attestation.targetId
      || observed.targetStartedAt !== attestation.targetStartedAt
      || observed.imageId !== attestation.imageId
      || observed.imageDigest !== attestation.imageDigest
      || observed.helperDigest !== attestation.helperDigest
      || observed.attestationDigest !== attestation.attestationDigest) {
      throw new ContainerAttestationInvalidError("OCI managed target does not match its trusted launcher attestation.", {
        expectedTargetId: attestation.targetId,
        observedTargetId: observed.targetId
      });
    }
  }
}
