import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BrokerConnectionError,
  isSecretEnvironmentKey,
  resolveSigmaExecBinary,
  SandboxUnavailableError,
  SigmaExecBrokerClient,
  type BrokerDoctorReport,
  type BrokerRequestOptions,
  type ExecutionBroker,
  type ExecutionRequest,
  type ExecutionResult,
  type ProcessHandle,
  type ProcessPollResult,
  type ProcessSpawnRequest
} from "agent-execution";

export interface ExecutionCompositionOptions {
  sandboxMode: "required" | "unsafe";
  allowUnsafeHostExec: boolean;
  helperPath?: string;
  env?: NodeJS.ProcessEnv;
}

function secretValues(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value && isSecretEnvironmentKey(key)));
}

export function defaultSigmaExecPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SIGMA_EXEC_PATH) return path.resolve(env.SIGMA_EXEC_PATH);
  const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
  const packaged = resolveSigmaExecBinary(path.resolve(sourceDirectory, "..", "..", "..", "bin"));
  const development = resolveSigmaExecBinary(path.resolve(
    sourceDirectory, "..", "..", "..", "native", "sigma-exec", "target", "release"
  ));
  return [packaged, development].find(existsSync) ?? packaged;
}

export class LazyExecutionBroker implements ExecutionBroker {
  private readonly client: SigmaExecBrokerClient;
  private connecting?: Promise<BrokerDoctorReport>;
  private failure?: Error;

  constructor(options: ExecutionCompositionOptions) {
    const env = options.env ?? process.env;
    this.client = new SigmaExecBrokerClient({
      helperPath: path.resolve(options.helperPath ?? defaultSigmaExecPath(env)),
      sandboxMode: options.sandboxMode,
      allowUnsafeHostExec: options.allowUnsafeHostExec,
      secrets: secretValues(env)
    });
  }

  get lostProcessHandles(): readonly ProcessHandle[] { return this.client.lostProcessHandles; }

  async connect(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    if (this.failure) throw this.failure;
    this.connecting ??= this.client.connect(signal).catch((error: unknown) => {
      this.failure = error instanceof SandboxUnavailableError ? error : new SandboxUnavailableError(
        error instanceof Error ? error.message : "sigma-exec could not be started."
      );
      throw this.failure;
    });
    return await this.connecting;
  }

  async doctor(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    await this.connect(signal);
    return await this.client.doctor(signal);
  }

  async setupSandbox(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    await this.connect(signal);
    return await this.client.setupSandbox(signal);
  }

  async execute(request: ExecutionRequest, options?: BrokerRequestOptions): Promise<ExecutionResult> {
    await this.connect(options?.signal);
    return await this.client.execute(request, options);
  }

  async spawn(request: ProcessSpawnRequest, options?: BrokerRequestOptions): Promise<ProcessHandle> {
    await this.connect(options?.signal);
    return await this.client.spawn(request, options);
  }

  async poll(handle: ProcessHandle, options?: BrokerRequestOptions): Promise<ProcessPollResult> {
    await this.connect(options?.signal);
    return await this.client.poll(handle, options);
  }

  async write(handle: ProcessHandle, data: string, options?: BrokerRequestOptions): Promise<void> {
    await this.connect(options?.signal);
    await this.client.write(handle, data, options);
  }

  async terminate(handle: ProcessHandle, options?: BrokerRequestOptions): Promise<ProcessPollResult> {
    await this.connect(options?.signal);
    return await this.client.terminate(handle, options);
  }

  async releaseOutputArtifacts(artifactIds: string[]): Promise<void> {
    await this.connect();
    await this.client.releaseOutputArtifacts(artifactIds);
  }

  async close(): Promise<void> {
    await this.client.close().catch((error) => {
      if (!(error instanceof BrokerConnectionError)) throw error;
    });
  }
}
