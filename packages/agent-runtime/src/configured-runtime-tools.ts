import { defaultBundledLanguageServerRoot, discoverLanguageServers } from "agent-code-intel";
import type { BrokerDoctorReport, ExecutionBroker } from "agent-execution";
import type { AgentSupervisor } from "agent-supervisor";
import { EffectToolRegistry, registerBuiltinTools, registerSupervisorTools } from "agent-tools";
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
  networkMode?: "none" | "loopback" | "full";
  processHandoff?: "allow" | "deny";
  checkpoint?: { maxFiles: number; maxBytes: number };
}

export function createConfiguredTools(
  config: ConfiguredToolOptions,
  execution: ExecutionBroker,
  supervisor: AgentSupervisor,
  executionReport: BrokerDoctorReport,
  storeRootDir: string
): EffectToolRegistry {
  const network = verifiedNetworkPolicy(executionReport, config.networkMode ?? "none");
  const executionBackend = executionReport.container?.available === true ? "oci" : "native";
  const builtins = registerBuiltinTools(new EffectToolRegistry(), {
    broker: execution,
    executionBackend,
    executionPlatform: brokerRuntimeEnvironment(executionReport).platform,
    managedEnvironment: executionReport.capabilities.managedEnvironment?.prepare === true,
    atomicPatchStateRootDir: storeRootDir,
    sandboxMode: "required",
    readScope: config.readScope ?? "workspace",
    processHandoff: config.processHandoff ?? "allow",
    networkMode: network.defaultMode,
    networkModes: network.modes,
    shells: verifiedShellKinds(executionReport),
    runtimeCommands: verifiedRuntimeCommands(executionReport),
    foreground: executionReport.capabilities.foreground,
    background: executionReport.capabilities.background,
    stdin: executionReport.capabilities.stdin,
    pty: executionReport.capabilities.pty,
    handoff: config.processHandoff !== "deny"
      && executionReport.capabilities.processHandoff === true
      && typeof execution.handoff === "function",
    ...repositoryRuntimeProviders,
    ...(executionReport.capabilities.background
      && executionReport.capabilities.stdin
      && network.modes.includes("none") ? {
      codeIntel: {
        presets: discoverLanguageServers(),
        additionalReadRoots: [defaultBundledLanguageServerRoot()]
          .filter((value): value is string => Boolean(value))
      }
    } : {})
  });
  builtins.register(repositoryTransactionTool(execution, {
    maxFiles: config.checkpoint?.maxFiles,
    maxBytes: config.checkpoint?.maxBytes
  }));
  return registerSupervisorTools(builtins, supervisor);
}
