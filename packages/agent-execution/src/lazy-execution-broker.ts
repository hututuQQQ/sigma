import {
  attachBrokerLifecycleFailure,
  BrokerConnectionError,
  BrokerProcessLostError
} from "./errors.js";
import {
  awaitWithSignal,
  cancellationError,
  errorIdentity,
  lifecycleFailure,
  preserveConnectionFailure,
  retireTerminalGenerationError
} from "./lazy-execution-broker-lifecycle.js";
import { defaultBrokerClientFactory } from "./lazy-execution-broker-runtime.js";
import {
  LazyExecutionHandleRegistry,
  type LazyProcessHandleOwner
} from "./lazy-execution-handles.js";
import type {
  BrokerDoctorReport,
  BrokerRequestOptions,
  ExecutionBroker,
  ExecutionRequest,
  ExecutionResult,
  ProcessHandle,
  ProcessPollResult,
  ProcessSpawnRequest,
  TrustedToolchainManifestEntry
} from "./types.js";
export {
  defaultSigmaExecPath,
  runtimeNodeBinding,
  runtimeTrustedToolchains,
  runtimeTrustedToolchainsForBinding,
  type RuntimeNodeBinding
} from "./lazy-execution-broker-runtime.js";

export interface LazyExecutionBrokerOptions {
  sandboxMode: "required" | "unsafe";
  allowUnsafeHostExec: boolean;
  helperPath?: string;
  env?: NodeJS.ProcessEnv;
  trustedToolchains?: TrustedToolchainManifestEntry[];
  clientFactory?: () => ExecutionBroker;
}

interface BrokerGeneration {
  readonly id: number;
  readonly client: ExecutionBroker;
  connecting?: Promise<BrokerDoctorReport>;
  failure?: Error;
  retiring?: boolean;
  retired?: boolean;
}

interface ConnectedGeneration {
  readonly generation: BrokerGeneration;
  readonly report: BrokerDoctorReport;
}

interface GenerationResult<T> {
  readonly generation: BrokerGeneration;
  readonly value: T;
}

/**
 * Owns replaceable broker generations. A connection failure retires only the
 * affected generation; unknown-result operations are never replayed. Calls
 * rejected before dispatch may be retried once on a fresh generation.
 */
export class LazyExecutionBroker implements ExecutionBroker {
  private readonly createClient: () => ExecutionBroker;
  private readonly clients = new WeakSet<ExecutionBroker>();
  private readonly processHandles = new LazyExecutionHandleRegistry();
  private generationSequence = 0;
  private generation: BrokerGeneration;
  private replacement?: Promise<BrokerGeneration>;
  private closePromise?: Promise<void>;
  private closed = false;

  constructor(options: LazyExecutionBrokerOptions) {
    this.createClient = options.clientFactory ?? defaultBrokerClientFactory(options);
    this.generation = this.newGeneration();
  }

  get lostProcessHandles(): readonly ProcessHandle[] {
    this.captureLost(this.generation.client);
    return this.processHandles.lostProcessHandles;
  }

  async connect(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    return (await this.ensureConnected(signal)).report;
  }

  async doctor(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    return (await this.invokeFresh((client) => client.doctor(signal), signal)).value;
  }

  async setupSandbox(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    return (await this.invokeFresh(async (client) => {
      if (!client.setupSandbox) return await client.doctor(signal);
      return await client.setupSandbox(signal);
    }, signal)).value;
  }

  async execute(request: ExecutionRequest, options?: BrokerRequestOptions): Promise<ExecutionResult> {
    return (await this.invokeFresh((client) => client.execute(request, options), options?.signal)).value;
  }

  async spawn(request: ProcessSpawnRequest, options?: BrokerRequestOptions): Promise<ProcessHandle> {
    const result = await this.invokeFresh((client) => client.spawn(request, options), options?.signal);
    const owner = this.processHandles.register(
      result.value,
      result.generation.id,
      result.generation.client
    );
    if (this.closed || result.generation !== this.generation
      || result.generation.retiring || result.generation.retired) {
      this.processHandles.lose(owner);
      throw new BrokerProcessLostError(owner.publicHandle.id);
    }
    return owner.publicHandle;
  }

  async poll(handle: ProcessHandle, options?: BrokerRequestOptions): Promise<ProcessPollResult> {
    return await this.invokeHandle(
      handle,
      async (client, owner) => await client.poll(owner.nativeHandle, options),
      options?.signal,
      (owner, result) => {
        if (result.state !== "running") this.processHandles.release(owner);
        return { ...result, handle: owner.publicHandle };
      }
    );
  }

  async write(handle: ProcessHandle, data: string, options?: BrokerRequestOptions): Promise<void> {
    await this.invokeHandle(handle, async (client, owner) => {
      await client.write(owner.nativeHandle, data, options);
    }, options?.signal);
  }

  async terminate(handle: ProcessHandle, options?: BrokerRequestOptions): Promise<ProcessPollResult> {
    return await this.invokeHandle(
      handle,
      async (client, owner) => await client.terminate(owner.nativeHandle, options),
      options?.signal,
      (owner, result) => {
        if (result.state !== "running") this.processHandles.release(owner);
        return { ...result, handle: owner.publicHandle };
      }
    );
  }

  async releaseOutputArtifacts(artifactIds: string[]): Promise<void> {
    const generation = (await this.ensureConnected()).generation;
    try {
      this.assertGenerationUsable(generation);
      await generation.client.releaseOutputArtifacts?.(artifactIds);
    } catch (error) {
      const terminalRetirement = retireTerminalGenerationError(error, async (terminalError) => {
        this.markGenerationFailed(generation, terminalError); await this.replaceGeneration(generation);
      });
      if (terminalRetirement) await terminalRetirement;
      if (!(error instanceof BrokerConnectionError)) throw error;
      this.markGenerationFailed(generation, error);
      try {
        await this.replaceGeneration(generation);
      } catch (retirementFailure) {
        throw preserveConnectionFailure(error, retirementFailure);
      }
      // Artifact acknowledgement is cleanup, but its dispatch result is still
      // unknown after a connection loss. Retire the generation without replay.
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    await this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    this.processHandles.loseAll();
    const replacement = this.replacement;
    let replacementFailure: unknown;
    if (replacement) {
      try { await replacement; } catch (error) { replacementFailure = error; }
    }
    const closeFailures: unknown[] = [];
    const client = this.generation.client;
    this.captureLost(client);
    try { await client.close(); } catch (error) { closeFailures.push(error); }
    finally { this.captureLost(client); }
    if (replacementFailure !== undefined) closeFailures.unshift(replacementFailure);
    if (closeFailures.length === 1) throw closeFailures[0];
    if (closeFailures.length > 1) throw new AggregateError(closeFailures, "Execution broker shutdown failed.");
  }

  private newGeneration(): BrokerGeneration {
    const client = this.createClient();
    if (this.clients.has(client)) {
      throw new BrokerConnectionError("Execution broker clientFactory must return a fresh client for every generation.");
    }
    this.clients.add(client);
    return { id: ++this.generationSequence, client };
  }

  private async connectGeneration(
    generation: BrokerGeneration,
    signal?: AbortSignal
  ): Promise<BrokerDoctorReport> {
    if (this.closed) throw new BrokerConnectionError("Execution broker is closed.", { retrySafe: true });
    if (signal?.aborted) throw cancellationError(signal);
    if (generation.retiring || generation.retired) {
      throw generation.failure ?? new BrokerConnectionError("Execution broker generation is retiring.");
    }
    if (generation.failure) throw generation.failure;
    generation.connecting ??= generation.client.connect().catch((error: unknown) => {
      generation.failure = error instanceof Error
        ? error
        : new BrokerConnectionError("sigma-exec could not be started.", {
          diagnostic: { thrown: typeof error }
        });
      throw generation.failure;
    });
    const report = await awaitWithSignal(generation.connecting, signal);
    this.assertGenerationUsable(generation);
    return report;
  }

  private async invokeFresh<T>(
    operation: (client: ExecutionBroker) => Promise<T>,
    signal?: AbortSignal
  ): Promise<GenerationResult<T>> {
    let generation = (await this.ensureConnected(signal)).generation;
    for (let attempt = 0; ; attempt += 1) {
      try {
        this.assertGenerationUsable(generation);
        return { generation, value: await operation(generation.client) };
      } catch (error) {
        const terminalRetirement = retireTerminalGenerationError(error, async (terminalError) => {
          this.markGenerationFailed(generation, terminalError);
          await this.replaceGeneration(generation);
        });
        if (terminalRetirement) await terminalRetirement;
        if (!(error instanceof BrokerConnectionError)) throw error;
        this.markGenerationFailed(generation, error);
        let replacement: BrokerGeneration;
        try {
          replacement = await this.replaceGeneration(generation);
        } catch (retirementFailure) {
          throw preserveConnectionFailure(error, retirementFailure);
        }
        if (!error.retrySafe || attempt >= 1) throw error;
        generation = replacement;
        await this.connectGeneration(generation, signal);
      }
    }
  }

  private async invokeHandle<T>(
    handle: ProcessHandle,
    operation: (client: ExecutionBroker, owner: LazyProcessHandleOwner) => Promise<T>,
    signal?: AbortSignal,
    commit?: (owner: LazyProcessHandleOwner, value: T) => T
  ): Promise<T> {
    const generation = this.generation;
    const owner = this.processHandles.owner(handle);
    if (!owner || owner.generationId !== generation.id || owner.client !== generation.client) {
      if (owner) this.processHandles.lose(owner);
      throw new BrokerProcessLostError(handle.id);
    }
    try {
      await this.connectGeneration(generation, signal);
      this.assertGenerationUsable(generation);
      const value = await operation(generation.client, owner);
      if (!this.handleOwnerUsable(generation, owner)) {
        if (this.processHandles.owner(owner.publicHandle) === owner) this.processHandles.lose(owner);
        throw new BrokerProcessLostError(handle.id);
      }
      return commit ? commit(owner, value) : value;
    } catch (error) {
      const terminalRetirement = retireTerminalGenerationError(error, async (terminalError) => {
        this.markGenerationFailed(generation, terminalError); this.processHandles.lose(owner);
        await this.replaceGeneration(generation);
      });
      if (terminalRetirement) await terminalRetirement;
      if (!(error instanceof BrokerConnectionError)) throw error;
      this.markGenerationFailed(generation, error);
      this.processHandles.lose(owner);
      try {
        await this.replaceGeneration(generation);
      } catch (retirementFailure) {
        attachBrokerLifecycleFailure(
          error, retirementFailure, "Background process generation retirement failed."
        );
        throw new BrokerProcessLostError(handle.id, { cause: error });
      }
      throw new BrokerProcessLostError(handle.id, { cause: error });
    }
  }

  private async ensureConnected(signal?: AbortSignal): Promise<ConnectedGeneration> {
    let generation = this.generation;
    try {
      return { generation, report: await this.connectGeneration(generation, signal) };
    } catch (error) {
      const terminalRetirement = retireTerminalGenerationError(error, async (terminalError) => {
        this.markGenerationFailed(generation, terminalError); await this.replaceGeneration(generation);
      });
      if (terminalRetirement) await terminalRetirement;
      if (!lifecycleFailure(error) || this.closed) throw error;
      try {
        generation = await this.replaceGeneration(generation);
      } catch (retirementFailure) {
        throw preserveConnectionFailure(error, retirementFailure);
      }
      return { generation, report: await this.connectGeneration(generation, signal) };
    }
  }

  private async replaceGeneration(failed: BrokerGeneration): Promise<BrokerGeneration> {
    if (this.closed) throw new BrokerConnectionError("Execution broker is closed.", { retrySafe: true });
    if (this.generation !== failed) return this.generation;
    if (this.replacement) return await this.replacement;
    this.markGenerationFailed(
      failed,
      failed.failure ?? new BrokerConnectionError("Execution broker generation was disconnected.")
    );
    const replacement = (async (): Promise<BrokerGeneration> => {
      this.processHandles.loseGeneration(failed.id);
      this.captureLost(failed.client);
      if (!failed.retired) {
        try {
          await failed.client.close();
        } catch (error) {
          this.captureLost(failed.client);
          throw new BrokerConnectionError("Failed to retire the disconnected execution broker.", {
            cause: error,
            diagnostic: { retirement: errorIdentity(error) }
          });
        }
        failed.retired = true;
        this.captureLost(failed.client);
      }
      // close() may have started while the old client was shutting down. The
      // old generation is now contained, so do not create another process.
      if (this.closed) return failed;
      if (this.generation === failed) this.generation = this.newGeneration();
      return this.generation;
    })();
    this.replacement = replacement;
    try {
      return await replacement;
    } finally {
      if (this.replacement === replacement) this.replacement = undefined;
    }
  }

  private markGenerationFailed(generation: BrokerGeneration, error: Error): void {
    generation.failure ??= error;
    generation.retiring = true;
  }

  private handleOwnerUsable(generation: BrokerGeneration, owner: LazyProcessHandleOwner): boolean {
    return !this.closed && generation === this.generation && !generation.failure
      && !generation.retiring && !generation.retired
      && this.processHandles.owner(owner.publicHandle) === owner;
  }

  private assertGenerationUsable(generation: BrokerGeneration): void {
    if (this.closed) {
      throw new BrokerConnectionError("Execution broker is closed.", { retrySafe: true });
    }
    if (generation !== this.generation || generation.failure
      || generation.retiring || generation.retired) {
      throw new BrokerConnectionError("Execution broker generation is not accepting new requests.", {
        cause: generation.failure,
        retrySafe: true,
        diagnostic: { generationId: generation.id }
      });
    }
  }

  private captureLost(client: ExecutionBroker): void {
    this.processHandles.captureClientLost(client);
  }
}
