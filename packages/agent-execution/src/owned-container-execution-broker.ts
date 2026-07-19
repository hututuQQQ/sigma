import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import {
  attachBrokerLifecycleFailure,
  BrokerCancelledError,
  BrokerConnectionError,
  ContainerAttestationInvalidError,
  ContainerCapabilityUnavailableError,
  ContainerUnavailableError
} from "./errors.js";
import { ownedContainerImageDigest } from "./container-execution-broker.js";
import { OciEngineCapabilityError } from "./owned-oci-engine.js";
import {
  OWNED_CLEANUP_TIMEOUT_MS,
  withOwnedCleanupDeadline
} from "./owned-container-cleanup.js";
import {
  attestOwnedContainer,
  ownedNetworkEnvelope,
  patchOwnedContainerReport,
  type OwnedPinnedIdentity
} from "./owned-container-attestation.js";
import type {
  OwnedOciCreateSpec,
  OwnedOciEngineCapabilities
} from "./owned-oci-engine.js";
import {
  defaultOwnedClient,
  ownedContainerFailure,
  ownedProofLabels,
  ownedTargetName,
  type OwnedContainerExecutionBrokerOptions
} from "./owned-container-broker-support.js";
import type {
  BrokerDoctorReport,
  BrokerRequestOptions,
  BrokerSandboxLeaseStatus,
  BrokerSandboxRevokeResult,
  ExecutionBroker,
  ExecutionRequest,
  ExecutionResult,
  NetworkPolicy,
  ProcessHandle,
  ProcessHandoffResult,
  ProcessPollResult,
  ProcessSpawnRequest
} from "./types.js";

export const OWNED_OCI_HELPER_TARGET = "/opt/sigma-helper/sigma-exec";
export const OWNED_OCI_SANDBOX_HELPER_TARGET = "/usr/local/bin/bwrap";
export type { OwnedContainerExecutionBrokerOptions } from "./owned-container-broker-support.js";

/** Owns exactly one digest-pinned OCI target and its sigma-exec connection. */
export class OwnedContainerExecutionBroker implements ExecutionBroker {
  private readonly targetName: string;
  private readonly proofLabels: Record<string, string>;
  private readonly clientFactory: (stream: Duplex, artifactParent: string) => ExecutionBroker;
  private readonly lifecycle = new AbortController();
  private connection?: Promise<BrokerDoctorReport>;
  private closePromise?: Promise<void>;
  private cleanupPromise?: Promise<void>;
  private artifactParent?: string;
  private targetId?: string;
  private pinned?: OwnedPinnedIdentity;
  private client?: ExecutionBroker;
  private createAttempted = false;
  private closed = false;
  private retired = false;

  constructor(private readonly options: OwnedContainerExecutionBrokerOptions) {
    ownedContainerImageDigest(options.config.image);
    if (!path.isAbsolute(options.workspace) || !path.isAbsolute(options.helperPath)
      || !path.isAbsolute(options.sandboxHelperPath)) {
      throw new ContainerAttestationInvalidError("Owned OCI workspace and helper paths must be absolute.");
    }
    this.targetName = ownedTargetName(options.nameFactory);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(this.targetName)) {
      throw new ContainerAttestationInvalidError("Owned OCI target name is invalid.");
    }
    this.proofLabels = ownedProofLabels();
    this.clientFactory = options.clientFactory ?? defaultOwnedClient;
  }

  get lostProcessHandles(): readonly ProcessHandle[] { return this.client?.lostProcessHandles ?? []; }

  async connect(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    this.connection ??= this.connectOnce(this.combinedSignal(signal));
    return await this.connection;
  }

  async doctor(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    const client = await this.activeClient(signal);
    await this.reattest(signal);
    return this.patchReport(await this.guard(() => client.doctor(signal)));
  }

  async setupSandbox(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    const client = await this.activeClient(signal);
    await this.reattest(signal);
    const report = client.setupSandbox ? await this.guard(() => client.setupSandbox!(signal))
      : await this.guard(() => client.doctor(signal));
    return this.patchReport(report);
  }

  async repairSandbox(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    const client = await this.activeClient(signal);
    await this.reattest(signal);
    const report = client.repairSandbox ? await this.guard(() => client.repairSandbox!(signal))
      : client.setupSandbox ? await this.guard(() => client.setupSandbox!(signal))
        : await this.guard(() => client.doctor(signal));
    return this.patchReport(report);
  }

  async sandboxLeaseStatus(workspacePath: string, signal?: AbortSignal): Promise<BrokerSandboxLeaseStatus> {
    const client = await this.activeClient(signal);
    await this.reattest(signal);
    if (!client.sandboxLeaseStatus) throw new ContainerUnavailableError("Owned OCI sandbox lease status is unavailable.");
    return await this.guard(() => client.sandboxLeaseStatus!(workspacePath, signal));
  }

  async revokeSandboxLease(workspacePath: string, signal?: AbortSignal): Promise<BrokerSandboxRevokeResult> {
    const client = await this.activeClient(signal);
    await this.reattest(signal);
    if (!client.revokeSandboxLease) throw new ContainerUnavailableError("Owned OCI sandbox lease revoke is unavailable.");
    return await this.guard(() => client.revokeSandboxLease!(workspacePath, signal));
  }

  async execute(request: ExecutionRequest, options?: BrokerRequestOptions): Promise<ExecutionResult> {
    this.assertNetwork(request.policy.network);
    const client = await this.attestedClient(options?.signal);
    return await this.guard(() => client.execute(request, options));
  }

  async spawn(request: ProcessSpawnRequest, options?: BrokerRequestOptions): Promise<ProcessHandle> {
    this.assertNetwork(request.policy.network);
    const client = await this.attestedClient(options?.signal);
    return await this.guard(() => client.spawn(request, options));
  }

  async poll(handle: ProcessHandle, options?: BrokerRequestOptions): Promise<ProcessPollResult> {
    const client = await this.attestedClient(options?.signal);
    return await this.guard(() => client.poll(handle, options));
  }

  async write(handle: ProcessHandle, data: string, options?: BrokerRequestOptions): Promise<void> {
    const client = await this.attestedClient(options?.signal);
    await this.guard(() => client.write(handle, data, options));
  }

  async terminate(handle: ProcessHandle, options?: BrokerRequestOptions): Promise<ProcessPollResult> {
    const client = await this.attestedClient(options?.signal);
    return await this.guard(() => client.terminate(handle, options));
  }

  async handoff(handle: ProcessHandle, options?: BrokerRequestOptions): Promise<ProcessHandoffResult> {
    const client = await this.attestedClient(options?.signal);
    if (!client.handoff) throw new ContainerUnavailableError("Owned OCI process handoff is unavailable.");
    return await this.guard(() => client.handoff!(handle, options));
  }

  async releaseOutputArtifacts(artifactIds: string[]): Promise<void> {
    await this.client?.releaseOutputArtifacts?.(artifactIds);
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    await this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    this.lifecycle.abort(new BrokerCancelledError("Owned OCI broker is closing."));
    if (this.connection) await this.connection.catch(() => undefined);
    await this.cleanup();
  }

  private async connectOnce(signal: AbortSignal): Promise<BrokerDoctorReport> {
    try {
      const capabilities = await this.options.engine.probe(signal);
      this.assertEngineCapabilities(capabilities);
      const digest = ownedContainerImageDigest(this.options.config.image);
      const image = await this.options.engine.inspectImage(this.options.config.image, digest, signal);
      this.artifactParent = await mkdtemp(path.join(os.tmpdir(), "sigma-oci-owned-artifacts-"));
      const spec = this.createSpec();
      this.createAttempted = true;
      this.targetId = await this.createTarget(spec, signal);
      await this.options.engine.startContainer(this.targetId, signal);
      this.pinned = attestOwnedContainer(
        this.options.engine.engine,
        this.targetId,
        this.proofLabels,
        await this.options.engine.inspectContainer(this.targetId, signal),
        image,
        spec
      );
      const stream = await this.options.engine.attachContainer(this.targetId, signal);
      stream.once("close", () => { void this.cleanup(true).catch(() => undefined); });
      this.client = this.clientFactory(stream, this.artifactParent);
      return this.patchReport(await this.client.connect(signal));
    } catch (error) {
      const failure = ownedContainerFailure(error, "Owned OCI target provisioning failed.");
      try { await this.cleanup(true); } catch (cleanupError) {
        attachBrokerLifecycleFailure(failure, cleanupError, "Owned OCI provisioning cleanup failed.");
      }
      throw failure;
    }
  }

  private createSpec(): OwnedOciCreateSpec {
    if (!this.artifactParent) throw new ContainerUnavailableError("Owned OCI artifact parent is unavailable.");
    return {
      name: this.targetName,
      image: this.options.config.image,
      workspace: this.options.workspace,
      helperPath: this.options.helperPath,
      helperTarget: OWNED_OCI_HELPER_TARGET,
      sandboxHelperPath: this.options.sandboxHelperPath,
      sandboxHelperTarget: OWNED_OCI_SANDBOX_HELPER_TARGET,
      artifactParent: this.artifactParent,
      network: this.options.config.network ?? "none",
      labels: this.proofLabels
    };
  }

  private async createTarget(spec: OwnedOciCreateSpec, signal: AbortSignal): Promise<string> {
    try {
      return await this.options.engine.createContainer(spec, signal);
    } catch (error) {
      if (error instanceof OciEngineCapabilityError) {
        throw new ContainerCapabilityUnavailableError(
          error.capability,
          `The ${this.options.engine.engine} engine cannot provide required OCI capability '${error.capability}'.`,
          { engine: this.options.engine.engine, statusCode: error.statusCode ?? null },
          { cause: error }
        );
      }
      throw error;
    }
  }

  private async reattest(signal?: AbortSignal): Promise<void> {
    if (!this.pinned || !this.targetId) throw new ContainerUnavailableError("Owned OCI target is not connected.");
    try {
      const observed = await this.options.engine.inspectContainer(this.targetId, this.combinedSignal(signal));
      const current = attestOwnedContainer(
        this.options.engine.engine,
        this.targetId,
        this.proofLabels,
        observed,
        { imageId: this.pinned.imageId, imageDigest: this.pinned.imageDigest },
        this.createSpec()
      );
      if (!observed.running || JSON.stringify(current) !== JSON.stringify(this.pinned)) {
        throw new ContainerAttestationInvalidError("Owned OCI target identity changed after creation.");
      }
    } catch (error) {
      const failure = error instanceof ContainerAttestationInvalidError ? error
        : new ContainerAttestationInvalidError("Owned OCI target could not be re-attested.", undefined, {
            cause: error instanceof Error ? error : undefined
          });
      try { await this.cleanup(true); } catch (cleanupError) {
        attachBrokerLifecycleFailure(failure, cleanupError, "Owned OCI attestation cleanup failed.");
      }
      throw failure;
    }
  }

  private patchReport(report: BrokerDoctorReport): BrokerDoctorReport {
    if (!this.pinned) throw new ContainerUnavailableError("Owned OCI identity is unavailable.");
    return patchOwnedContainerReport(report, this.pinned, this.options.config.network ?? "none");
  }

  private async activeClient(signal?: AbortSignal): Promise<ExecutionBroker> {
    await this.connect(signal);
    if (!this.client || this.closed || this.retired) {
      throw new ContainerUnavailableError("Owned OCI broker is closed.");
    }
    return this.client;
  }

  private async attestedClient(signal?: AbortSignal): Promise<ExecutionBroker> {
    const client = await this.activeClient(signal);
    await this.reattest(signal);
    return client;
  }

  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BrokerConnectionError) {
        try { await this.cleanup(true); } catch (cleanupError) {
          attachBrokerLifecycleFailure(error, cleanupError, "Owned OCI disconnect cleanup failed.");
        }
      }
      throw error;
    }
  }

  private assertEngineCapabilities(capabilities: OwnedOciEngineCapabilities): void {
    const network = this.options.config.network ?? "none";
    if (!capabilities.networkModes.includes(network)) {
      throw new ContainerCapabilityUnavailableError(
        `network.${network}`,
        `The ${this.options.engine.engine} engine cannot provide owned OCI network mode '${network}'.`,
        { engine: this.options.engine.engine }
      );
    }
  }

  private assertNetwork(requested: NetworkPolicy): void {
    const configured = this.options.config.network ?? "none";
    if (!ownedNetworkEnvelope(configured).includes(requested)) {
      throw new ContainerCapabilityUnavailableError(
        `network.${requested}`,
        `Owned OCI target was created with '${configured}' network capability and cannot grant '${requested}'.`
      );
    }
  }

  private combinedSignal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
  }

  private async cleanup(forceFirst = false): Promise<void> {
    this.cleanupPromise ??= this.cleanupOnce(forceFirst);
    await this.cleanupPromise;
  }

  private async cleanupOnce(forceFirst: boolean): Promise<void> {
    this.retired = true;
    const failures: unknown[] = [];
    if (forceFirst) await this.removeTarget(failures);
    try { await withOwnedCleanupDeadline(this.client?.close() ?? Promise.resolve()); }
    catch (error) { failures.push(error); }
    if (!forceFirst) await this.removeTarget(failures);
    if (this.artifactParent) {
      try { await rm(this.artifactParent, { recursive: true, force: true }); }
      catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      throw new ContainerUnavailableError("Owned OCI target cleanup failed.", {
        failureCount: failures.length
      }, { cause: failures.length === 1 ? failures[0] as Error : new AggregateError(failures) });
    }
  }

  private async removeTarget(failures: unknown[]): Promise<void> {
    if (!this.createAttempted) return;
    const target = this.targetId ?? this.targetName;
    try { await this.options.engine.removeContainer(target, AbortSignal.timeout(OWNED_CLEANUP_TIMEOUT_MS)); }
    catch (error) { failures.push(error); }
  }
}
