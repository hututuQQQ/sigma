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
  ManagedEnvironmentPrepareRequestV1,
  ManagedEnvironmentPrepareResultV1,
  ManagedSessionBindingRequestV1,
  ManagedSessionBindingV1,
  ProcessHandle,
  ProcessHandoffResult,
  ProcessPollResult,
  ProcessSpawnRequest,
  ScratchLeaseRequestV1, ScratchLeaseV1,
  TrustedManagedContainerAttestationV1
} from "./types.js";
import {
  assertContainerExecutionConfig,
  assertContainerSha256,
  canonicalManagedBindingRequest,
  containerIdentity,
  containerRuntimeClosure,
  managedEnvironmentProofAvailable,
  ownedContainerImageDigest,
  sameContainerIdentity,
  stableSha256,
  type PinnedContainerIdentity
} from "./container-attestation.js";
import { ManagedEnvironmentCoordinator } from "./managed-environment-coordinator.js";
import {
  invokeRepositoryOperation,
  RepositoryExecutionBrokerBase,
  type RepositoryOperationMethod
} from "./repository-execution-broker-base.js";
export {
  assertContainerExecutionConfig,
  MANAGED_ENVIRONMENT_PROTECTED_PATHS_V1,
  managedContainerAttestationDigest,
  managedEnvironmentProofDigest,
  ownedContainerImageDigest
} from "./container-attestation.js";

export interface ContainerExecutionBrokerOptions {
  config: ContainerExecutionConfig;
  managedAttestation?: TrustedManagedContainerAttestationV1;
  workspace?: string;
  managedEnvironmentMode?: "disabled" | "required";
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
export class AttestedContainerExecutionBroker extends RepositoryExecutionBrokerBase implements ExecutionBroker {
  private pinned?: PinnedContainerIdentity;
  private readonly managedBindings = new Map<string, ManagedSessionBindingV1>();
  private readonly managedEnvironment = new ManagedEnvironmentCoordinator();

  constructor(
    private readonly broker: ExecutionBroker,
    private readonly options: ContainerExecutionBrokerOptions
  ) {
    super();
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

  async bindManagedSession(
    request: ManagedSessionBindingRequestV1,
    options?: BrokerRequestOptions
  ): Promise<ManagedSessionBindingV1> {
    const report = await this.verify(options?.signal);
    const observed = containerIdentity(report);
    if (this.options.managedEnvironmentMode === "required"
      && (!managedEnvironmentProofAvailable(this.options.managedAttestation)
        || report.capabilities.managedEnvironment?.prepare !== true)) {
      throw Object.assign(new ContainerUnavailableError(
        "Managed session requires a disposable COW launcher proof and an authenticated preparation port."
      ), { code: "managed_environment_required_unavailable" });
    }
    const canonicalRequest = canonicalManagedBindingRequest(request, this.options, observed);
    const closure = report.capabilities.runtimeClosure;
    if (!closure?.complete) {
      throw Object.assign(new ContainerUnavailableError(
        "Managed runtime closure is incomplete; session execution cannot start."
      ), { code: "managed_environment_required_unavailable" });
    }
    const existing = this.managedBindings.get(canonicalRequest.sessionId);
    if (existing) {
      const requestedDigest = stableSha256(canonicalRequest);
      const existingDigest = stableSha256({
        protocolVersion: existing.protocolVersion,
        sessionId: existing.sessionId,
        workspace: existing.workspace,
        network: existing.network,
        protectedPaths: [...new Set(existing.protectedPaths)].sort()
      });
      if (requestedDigest !== existingDigest) {
        throw new ContainerAttestationInvalidError(
          "Managed session binding cannot be widened or rebound."
        );
      }
      return existing;
    }
    if (!this.broker.acquireScratchLease) {
      throw Object.assign(new ContainerUnavailableError(
        "Managed target does not expose RuntimeSession scratch."
      ), { code: "managed_environment_required_unavailable" });
    }
    const scratchLease = await this.broker.acquireScratchLease({
      protocolVersion: 1,
      sessionId: canonicalRequest.sessionId
    }, options);
    const payload = {
      ...canonicalRequest,
      lifetime: "runtime_session" as const,
      targetId: observed.targetId,
      targetStartedAt: observed.targetStartedAt,
      targetAttestationDigest: closure.targetAttestationDigest,
      protectedPathsDigest: stableSha256(canonicalRequest.protectedPaths),
      runtimeClosure: closure,
      scratchLease
    };
    const binding = { ...payload, bindingId: stableSha256(payload) };
    this.managedBindings.set(canonicalRequest.sessionId, binding);
    return binding;
  }

  async releaseScratchLease(sessionId: string, options?: BrokerRequestOptions): Promise<void> {
    await this.verify(options?.signal);
    if (!this.broker.releaseScratchLease) {
      throw new ContainerUnavailableError("OCI broker does not expose RuntimeSession scratch lease release.");
    }
    try {
      await this.broker.releaseScratchLease(sessionId, options);
    } finally {
      this.managedBindings.delete(sessionId);
      this.managedEnvironment.release(sessionId);
    }
  }

  protected async repositoryOperation(
    method: RepositoryOperationMethod,
    request: unknown,
    options?: BrokerRequestOptions
  ): Promise<unknown> {
    await this.verify(options?.signal);
    return await invokeRepositoryOperation(
      this.broker, method, request, options,
      "OCI broker does not expose broker-journaled repository transactions."
    );
  }

  async prepareManagedEnvironment(
    request: ManagedEnvironmentPrepareRequestV1,
    options?: BrokerRequestOptions
  ): Promise<ManagedEnvironmentPrepareResultV1> {
    const before = await this.verify(options?.signal);
    if (!managedEnvironmentProofAvailable(this.options.managedAttestation)) {
      throw Object.assign(new ContainerUnavailableError(
        "Managed environment preparation lacks a disposable COW launcher proof."
      ), { code: "managed_environment_required_unavailable" });
    }
    const binding = this.managedBindings.get(request.sessionId);
    if (!binding) {
      throw Object.assign(new ContainerUnavailableError(
        "Managed environment preparation requires a current session binding."
      ), { code: "managed_environment_required_unavailable" });
    }
    if (before.capabilities.managedEnvironment?.prepare !== true
      || !this.broker.prepareManagedEnvironment) {
      throw Object.assign(new ContainerUnavailableError(
        "Managed target does not expose authenticated environment preparation."
      ), { code: "managed_environment_required_unavailable" });
    }
    const previousRuntimeClosureDigest = before.capabilities.runtimeClosure!.digest;
    const canonical = this.managedEnvironment.authorize(binding, request);
    const result = await this.broker.prepareManagedEnvironment(canonical, options);
    const after = this.accept(await this.broker.doctor(options?.signal));
    const closure = after.capabilities.runtimeClosure!;
    const accepted = this.managedEnvironment.accept(
      canonical, previousRuntimeClosureDigest, result, closure
    );
    const refreshedPayload = {
      protocolVersion: binding.protocolVersion,
      sessionId: binding.sessionId,
      workspace: binding.workspace,
      network: binding.network,
      protectedPaths: binding.protectedPaths,
      lifetime: binding.lifetime,
      targetId: binding.targetId,
      targetStartedAt: binding.targetStartedAt,
      targetAttestationDigest: binding.targetAttestationDigest,
      protectedPathsDigest: binding.protectedPathsDigest,
      runtimeClosure: accepted.runtimeClosure,
      scratchLease: binding.scratchLease
    };
    // The runtime session holds this broker-issued object by reference. Update
    // it only after the target doctor and signed preparation receipt agree, so
    // subsequent tool policy observes the refreshed closure without creating
    // a second session capability.
    Object.assign(binding, refreshedPayload, {
      bindingId: stableSha256(refreshedPayload)
    });
    return accepted;
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

  async close(): Promise<void> {
    try {
      await this.broker.close();
    } finally {
      this.managedBindings.clear();
      this.managedEnvironment.clear();
    }
  }

  private async verify(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    return this.accept(await this.broker.doctor(signal));
  }

  private accept(report: BrokerDoctorReport): BrokerDoctorReport {
    this.assertSandbox(report);
    const observed = containerIdentity(report);
    if (observed.imageDigest) assertContainerSha256(observed.imageDigest, "reported imageDigest");
    if (observed.helperDigest) assertContainerSha256(observed.helperDigest, "reported helperDigest");
    if (observed.attestationDigest) {
      assertContainerSha256(observed.attestationDigest, "reported attestationDigest");
    }
    this.assertConfiguredIdentity(observed);
    this.assertPinnedIdentity(observed);
    this.pinned ??= observed;
    const accepted = {
      ...report,
      capabilities: {
        ...report.capabilities,
        runtimeClosure: containerRuntimeClosure(
          report, observed
        ),
        managedEnvironment: {
          available: observed.target === "managed"
            && this.options.config.network === "full"
            && managedEnvironmentProofAvailable(this.options.managedAttestation)
            && report.capabilities.managedEnvironment?.available === true,
          prepare: observed.target === "managed"
            && this.options.config.network === "full"
            && managedEnvironmentProofAvailable(this.options.managedAttestation)
            && report.capabilities.managedEnvironment?.prepare === true
            && typeof this.broker.prepareManagedEnvironment === "function"
        }
      }
    };
    return accepted;
  }

  private assertSandbox(report: BrokerDoctorReport): void {
    if (report.sandbox.backend === "oci" && report.sandbox.available && report.sandbox.selfTestPassed) return;
    throw new ContainerUnavailableError(
      report.sandbox.reason ?? "OCI broker sandbox self-test did not pass.",
      { sandboxBackend: report.sandbox.backend }
    );
  }

  private assertConfiguredIdentity(observed: PinnedContainerIdentity): void {
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

  private assertPinnedIdentity(observed: PinnedContainerIdentity): void {
    if (this.pinned && !sameContainerIdentity(this.pinned, observed)) {
      throw new ContainerAttestationInvalidError("OCI target identity changed after connection.", {
        expected: this.pinned, observed
      });
    }
  }

  private assertManagedAttestation(
    observed: PinnedContainerIdentity,
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
