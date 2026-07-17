import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SigmaExecBrokerClient } from "./broker-client.js";
import { isSecretEnvironmentKey } from "./environment.js";
import { BrokerToolchainUnavailableError } from "./errors.js";
import { resolvePortableNodeExecutable, resolveSigmaExecBinary } from "./paths.js";
import { trustedToolchainCommandAliases } from "./trusted-toolchains.js";
import type {
  BrokerDoctorReport,
  ExecutionBroker,
  ExecutionRequest,
  ProcessHandle,
  ProcessPollResult,
  ProcessSpawnRequest,
  TrustedToolchainManifestEntry
} from "./types.js";
import {
  createWindowsAppContainerNodeCompatibilityProof,
  WINDOWS_APPCONTAINER_NODE_COMPATIBILITY
} from "./windows-node-compatibility.js";

export interface RuntimeNodeBinding {
  executable: string;
  source: "portable" | "configured" | "current-runtime";
}

export interface DefaultBrokerClientFactoryOptions {
  sandboxMode: "required" | "unsafe";
  allowUnsafeHostExec: boolean;
  helperPath?: string;
  env?: NodeJS.ProcessEnv;
  trustedToolchains?: TrustedToolchainManifestEntry[];
}

function reportWithRuntimeCommands(
  report: BrokerDoctorReport,
  runtimeCommands: readonly string[],
  processHandoffAvailable: boolean
): BrokerDoctorReport {
  return {
    ...report,
    capabilities: {
      ...report.capabilities,
      // The native doctor report does not own package toolchain trust. Replace
      // any lower-layer claim with aliases from this connection's manifest.
      runtimeCommands: [...runtimeCommands],
      processHandoff: report.capabilities.processHandoff === true && processHandoffAvailable
    }
  };
}

/** Adds no capability before connection succeeds and exposes aliases only,
 * never the trusted manifest's absolute host paths. */
export function withTrustedRuntimeCapabilities(
  broker: ExecutionBroker,
  trustedToolchains: TrustedToolchainManifestEntry[] | undefined
): ExecutionBroker {
  const runtimeCommands = trustedToolchainCommandAliases(trustedToolchains);
  const processHandoffAvailable = typeof broker.handoff === "function";
  return {
    get lostProcessHandles(): readonly ProcessHandle[] { return broker.lostProcessHandles; },
    connect: async (signal) => reportWithRuntimeCommands(
      await broker.connect(signal), runtimeCommands, processHandoffAvailable
    ),
    doctor: async (signal) => reportWithRuntimeCommands(
      await broker.doctor(signal), runtimeCommands, processHandoffAvailable
    ),
    ...(broker.setupSandbox ? {
      setupSandbox: async (signal?: AbortSignal) => reportWithRuntimeCommands(
        await broker.setupSandbox!(signal), runtimeCommands, processHandoffAvailable
      )
    } : {}),
    execute: async (request: ExecutionRequest, options) => await broker.execute(request, options),
    spawn: async (request: ProcessSpawnRequest, options) => await broker.spawn(request, options),
    poll: async (handle, options): Promise<ProcessPollResult> => await broker.poll(handle, options),
    write: async (handle, data, options) => await broker.write(handle, data, options),
    terminate: async (handle, options): Promise<ProcessPollResult> => await broker.terminate(handle, options),
    ...(broker.handoff ? {
      handoff: async (handle, options) => await broker.handoff!(handle, options)
    } : {}),
    ...(broker.releaseOutputArtifacts ? {
      releaseOutputArtifacts: async (artifactIds: string[]) => await broker.releaseOutputArtifacts!(artifactIds)
    } : {}),
    close: async () => await broker.close()
  };
}

export function runtimeNodeBinding(
  packageModuleUrl: string | URL = import.meta.url,
  platform: NodeJS.Platform = process.platform,
  currentExecutable = process.execPath,
  env: NodeJS.ProcessEnv = process.env
): RuntimeNodeBinding {
  const portable = resolvePortableNodeExecutable(packageModuleUrl, platform);
  if (portable) return { executable: portable, source: "portable" };
  const configured = env.SIGMA_RUNTIME_NODE_PATH;
  if (configured !== undefined) {
    if (configured.length === 0 || !path.isAbsolute(configured)) {
      throw new BrokerToolchainUnavailableError(
        "runtime-node",
        "SIGMA_RUNTIME_NODE_PATH must be a non-empty absolute path"
      );
    }
    return { executable: path.resolve(configured), source: "configured" };
  }
  return { executable: path.resolve(currentExecutable), source: "current-runtime" };
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
  if (binding.source === "portable" && platform === "linux") {
    const toolchains = runtimeTrustedToolchains(binding.executable, platform, sandboxMode);
    const runtimeRoot = path.resolve(path.dirname(binding.executable), "..", "lib");
    return existsSync(runtimeRoot)
      ? toolchains.map((toolchain) => ({ ...toolchain, runtimeRoots: [runtimeRoot] }))
      : toolchains;
  }
  if (binding.source === "current-runtime" || platform !== "win32" || sandboxMode !== "required") {
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

export function defaultSigmaExecPath(
  env: NodeJS.ProcessEnv = process.env,
  packageModuleUrl: string | URL = import.meta.url
): string {
  if (env.SIGMA_EXEC_PATH) return path.resolve(env.SIGMA_EXEC_PATH);
  const sourceDirectory = path.dirname(fileURLToPath(packageModuleUrl));
  const roots = ["bin", path.join("native", "sigma-exec", "target", "release"),
    path.join("native", "sigma-exec", "target", "debug")];
  const candidates = roots.map((root) => resolveSigmaExecBinary(path.resolve(
    sourceDirectory, "..", "..", "..", root
  )));
  return candidates.find(existsSync) ?? candidates[0]!;
}

export function defaultBrokerClientFactory(
  options: DefaultBrokerClientFactoryOptions
): () => ExecutionBroker {
  const env = options.env ?? process.env;
  const runtime = runtimeNodeBinding(import.meta.url, process.platform, process.execPath, env);
  const trustedToolchains = options.trustedToolchains
    ?? runtimeTrustedToolchainsForBinding(runtime, process.platform, options.sandboxMode);
  const secrets = Object.fromEntries(
    Object.entries(env).filter(([key, value]) => value && isSecretEnvironmentKey(key))
  );
  const helperPath = path.resolve(options.helperPath ?? defaultSigmaExecPath(env));
  return () => withTrustedRuntimeCapabilities(
    new SigmaExecBrokerClient({
      helperPath,
      sandboxMode: options.sandboxMode,
      allowUnsafeHostExec: options.allowUnsafeHostExec,
      trustedToolchains,
      secrets
    }),
    trustedToolchains
  );
}
