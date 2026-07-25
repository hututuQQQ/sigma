import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultBundledLanguageServerRoot, discoverLanguageServers } from "agent-code-intel";
import type { BrokerDoctorReport, ExecutionBroker } from "agent-execution";
import type { AgentSupervisor } from "agent-supervisor";
import {
  EffectToolRegistry,
  registerBuiltinTools,
  registerSupervisorTools,
  repositoryInspectTool,
  RepositoryRecoverySelectionStore
} from "agent-tools";
import {
  brokerRuntimeEnvironment,
  verifiedNetworkPolicy,
  verifiedRuntimeCommands,
  verifiedShellKinds
} from "./execution-capabilities.js";
import { repositoryRuntimeProviders } from "./repository-statistics-provider.js";
import { repositoryTransactionTool } from "./repository-transaction-tool.js";

export interface ConfiguredToolOptions {
  readScope?: "workspace" | "host";
  writeScope?: "workspace" | "enclosing-container";
  networkMode?: "none" | "loopback" | "full";
  processHandoff?: "allow" | "deny";
  checkpoint?: { maxFiles: number; maxBytes: number };
}

function runtimeProtectedPaths(storeRootDir: string): string[] {
  const moduleFile = fileURLToPath(import.meta.url);
  const marker = `${path.sep}node_modules${path.sep}`;
  const markerIndex = moduleFile.indexOf(marker);
  const installRoot = markerIndex >= 0
    ? path.dirname(moduleFile.slice(0, markerIndex))
    : path.resolve(path.dirname(moduleFile), "../../..");
  return [...new Set([
    path.resolve(storeRootDir),
    path.resolve(installRoot),
    ...(process.argv[1] ? [path.dirname(path.resolve(process.argv[1]))] : [])
  ])].filter((item) => path.parse(item).root !== item);
}

function configuredToolPolicy(config: ConfiguredToolOptions) {
  return {
    readScope: config.readScope ?? "workspace",
    writeScope: config.writeScope ?? "workspace",
    processHandoff: config.processHandoff ?? "allow",
    networkMode: config.networkMode ?? "full"
  } as const;
}

function brokerAllowsHandoff(
  config: ConfiguredToolOptions,
  execution: ExecutionBroker,
  report: BrokerDoctorReport
): boolean {
  return config.processHandoff !== "deny"
    && report.capabilities.processHandoff === true
    && typeof execution.handoff === "function";
}

function brokerToolCapabilities(
  config: ConfiguredToolOptions,
  execution: ExecutionBroker,
  report: BrokerDoctorReport
) {
  const capabilities = report.capabilities;
  return {
    executionBackend: report.container?.available === true ? "oci" as const : "native" as const,
    executionPlatform: brokerRuntimeEnvironment(report).platform,
    managedEnvironment: capabilities.managedEnvironment?.prepare === true,
    enclosingContainerRoot: capabilities.enclosingContainerRoot?.available === true,
    enclosingContainerAttestationDigest:
      capabilities.enclosingContainerRoot?.attestationDigest,
    shells: verifiedShellKinds(report),
    runtimeCommands: verifiedRuntimeCommands(report),
    directExecutableResolution: capabilities.directExecutableResolution === true,
    foreground: capabilities.foreground,
    background: capabilities.background,
    stdin: capabilities.stdin,
    pty: capabilities.pty,
    handoff: brokerAllowsHandoff(config, execution, report)
  };
}

function configuredCodeIntel(
  report: BrokerDoctorReport,
  networkModes: readonly string[]
) {
  if (!report.capabilities.background
    || !report.capabilities.stdin
    || !networkModes.includes("none")) return {};
  return {
    codeIntel: {
      presets: discoverLanguageServers(),
      additionalReadRoots: [defaultBundledLanguageServerRoot()]
        .filter((value): value is string => Boolean(value))
    }
  };
}

export function createConfiguredTools(
  config: ConfiguredToolOptions,
  execution: ExecutionBroker,
  supervisor: AgentSupervisor,
  executionReport: BrokerDoctorReport,
  storeRootDir: string
): EffectToolRegistry {
  const recoverySelections = new RepositoryRecoverySelectionStore();
  const policy = configuredToolPolicy(config);
  const network = verifiedNetworkPolicy(executionReport, policy.networkMode);
  const builtins = registerBuiltinTools(new EffectToolRegistry(), {
    broker: execution,
    atomicPatchStateRootDir: storeRootDir,
    sandboxMode: "required",
    readScope: policy.readScope,
    writeScope: policy.writeScope,
    protectedPaths: runtimeProtectedPaths(storeRootDir),
    processHandoff: policy.processHandoff,
    networkMode: network.defaultMode,
    networkModes: network.modes,
    ...brokerToolCapabilities(config, execution, executionReport),
    ...repositoryRuntimeProviders,
    ...configuredCodeIntel(executionReport, network.modes)
  });
  builtins.register(repositoryInspectTool(execution, recoverySelections));
  builtins.register(repositoryTransactionTool(execution, {
    maxFiles: config.checkpoint?.maxFiles,
    maxBytes: config.checkpoint?.maxBytes,
    recoverySelections
  }));
  return registerSupervisorTools(builtins, supervisor);
}
