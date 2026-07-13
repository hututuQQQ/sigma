import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SigmaExecBrokerClient } from "./broker-client.js";
import { isSecretEnvironmentKey } from "./environment.js";
import {
  BrokerConnectionError,
  BrokerToolchainUnavailableError,
  SandboxUnavailableError
} from "./errors.js";
import { resolvePortableNodeExecutable, resolveSigmaExecBinary } from "./paths.js";
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
import {
  createWindowsAppContainerNodeCompatibilityProof,
  WINDOWS_APPCONTAINER_NODE_COMPATIBILITY
} from "./windows-node-compatibility.js";

export interface LazyExecutionBrokerOptions {
  sandboxMode: "required" | "unsafe";
  allowUnsafeHostExec: boolean;
  helperPath?: string;
  env?: NodeJS.ProcessEnv;
  trustedToolchains?: TrustedToolchainManifestEntry[];
}

export interface RuntimeNodeBinding {
  executable: string;
  source: "portable" | "current-runtime";
}

export function runtimeNodeBinding(
  packageModuleUrl: string | URL = import.meta.url,
  platform: NodeJS.Platform = process.platform,
  currentExecutable = process.execPath
): RuntimeNodeBinding {
  const portable = resolvePortableNodeExecutable(packageModuleUrl, platform);
  return portable
    ? { executable: portable, source: "portable" }
    : { executable: path.resolve(currentExecutable), source: "current-runtime" };
}

export function runtimeTrustedToolchains(
  executable = process.execPath,
  platform: NodeJS.Platform = process.platform,
  sandboxMode: "required" | "unsafe" = "required"
): TrustedToolchainManifestEntry[] {
  const resolved = path.resolve(executable);
  let windowsCompatibility: ReturnType<typeof createWindowsAppContainerNodeCompatibilityProof> | undefined;
  if (platform === "win32" && sandboxMode === "required") {
    try {
      windowsCompatibility = createWindowsAppContainerNodeCompatibilityProof(resolved, "runtime-node");
    } catch (error) {
      if (error instanceof BrokerToolchainUnavailableError) return [];
      throw error;
    }
  }
  return [{
    id: "runtime-node",
    runtime: "node",
    executable: resolved,
    aliases: platform === "win32" ? ["node", "node.exe"] : ["node"],
    executionRoots: [resolved],
    pathEntries: [],
    ...(windowsCompatibility ? {
      environment: { NODE_OPTIONS: WINDOWS_APPCONTAINER_NODE_COMPATIBILITY.requiredNodeOptions },
      compatibility: windowsCompatibility
    } : {})
  }];
}

export function runtimeTrustedToolchainsForBinding(
  binding: RuntimeNodeBinding,
  platform: NodeJS.Platform,
  sandboxMode: "required" | "unsafe"
): TrustedToolchainManifestEntry[] {
  if (binding.source !== "portable" || platform !== "win32" || sandboxMode !== "required") {
    return runtimeTrustedToolchains(binding.executable, platform, sandboxMode);
  }
  const compatibility = createWindowsAppContainerNodeCompatibilityProof(binding.executable, "runtime-node");
  return [{
    id: "runtime-node",
    runtime: "node",
    executable: binding.executable,
    aliases: ["node", "node.exe"],
    executionRoots: [binding.executable],
    pathEntries: [],
    environment: { NODE_OPTIONS: WINDOWS_APPCONTAINER_NODE_COMPATIBILITY.requiredNodeOptions },
    compatibility
  }];
}

function secretValues(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value && isSecretEnvironmentKey(key)));
}

export function defaultSigmaExecPath(
  env: NodeJS.ProcessEnv = process.env,
  packageModuleUrl: string | URL = import.meta.url
): string {
  if (env.SIGMA_EXEC_PATH) return path.resolve(env.SIGMA_EXEC_PATH);
  const sourceDirectory = path.dirname(fileURLToPath(packageModuleUrl));
  const packaged = resolveSigmaExecBinary(path.resolve(sourceDirectory, "..", "..", "..", "bin"));
  const release = resolveSigmaExecBinary(path.resolve(
    sourceDirectory, "..", "..", "..", "native", "sigma-exec", "target", "release"
  ));
  const debug = resolveSigmaExecBinary(path.resolve(
    sourceDirectory, "..", "..", "..", "native", "sigma-exec", "target", "debug"
  ));
  return [packaged, release, debug].find(existsSync) ?? packaged;
}

export class LazyExecutionBroker implements ExecutionBroker {
  private readonly client: SigmaExecBrokerClient;
  private connecting?: Promise<BrokerDoctorReport>;
  private failure?: Error;

  constructor(options: LazyExecutionBrokerOptions) {
    const env = options.env ?? process.env;
    const runtime = runtimeNodeBinding();
    this.client = new SigmaExecBrokerClient({
      helperPath: path.resolve(options.helperPath ?? defaultSigmaExecPath(env)),
      sandboxMode: options.sandboxMode,
      allowUnsafeHostExec: options.allowUnsafeHostExec,
      trustedToolchains: options.trustedToolchains
        ?? runtimeTrustedToolchainsForBinding(runtime, process.platform, options.sandboxMode),
      secrets: secretValues(env)
    });
  }

  get lostProcessHandles(): readonly ProcessHandle[] { return this.client.lostProcessHandles; }

  async connect(signal?: AbortSignal): Promise<BrokerDoctorReport> {
    if (this.failure) throw this.failure;
    this.connecting ??= this.client.connect(signal).catch((error: unknown) => {
      this.failure = error instanceof SandboxUnavailableError || error instanceof BrokerToolchainUnavailableError
        ? error
        : new SandboxUnavailableError(error instanceof Error ? error.message : "sigma-exec could not be started.");
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
