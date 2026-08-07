import type { ModelReasoningEffort } from "agent-model";
import type { BrokerDoctorReport } from "agent-execution";
import type { ModelGateway, RunMode } from "agent-protocol";
import { isToolAllowed } from "agent-tools";
import type { RuntimeCustomization } from "./customization.js";
import type { createConfiguredTools } from "./configured-runtime-tools.js";
import { modelTools } from "./effect-helpers.js";
import { configuredRuntimeEnvironment } from "./execution-capabilities.js";
import {
  compileHarnessBuild,
  type FrozenHarnessBuild,
  type HarnessReasoningEffort
} from "./harness-compiler.js";
import {
  projectModelToolDescriptors,
  sessionSkillProjectionCapabilities
} from "./model-tool-projection.js";
import { withReadBatchDescriptor } from "./read-batch-tool.js";

interface HarnessInspectionConfig {
  reasoningEffort?: ModelReasoningEffort;
  executionMode?: "sandboxed" | "container";
  writeScope?: "workspace" | "enclosing-container";
  managedEnvironmentMode?: "disabled" | "required";
  networkMode?: "none" | "loopback" | "full";
}

interface HarnessInspectionOptions {
  interactiveApprovals?: boolean;
  surface?: "cli" | "tui" | "acp";
}

export function createConfiguredHarnessInspector(input: {
  config: HarnessInspectionConfig;
  customization: RuntimeCustomization;
  tools: ReturnType<typeof createConfiguredTools>;
  gateways: { orchestrator: ModelGateway };
  executionReport: BrokerDoctorReport;
  options: HarnessInspectionOptions;
}): (mode: RunMode) => FrozenHarnessBuild {
  const { config, customization, tools, gateways, executionReport, options } = input;
  return (mode: RunMode): FrozenHarnessBuild => {
    const profile = customization.profile.profile;
    const sourceDescriptors = tools.modelDescriptors?.() ?? tools.descriptors();
    const skillCapabilities = sessionSkillProjectionCapabilities({
      frozenCustomization: { skills: customization.skills.descriptors },
      profileSkillNames: profile.skills
    });
    const capabilities = {
      ...skillCapabilities,
      environmentMutationAvailable: mode === "change",
      processControlsAvailable: false,
      childControlsAvailable: false,
      planReadRequired: false
    };
    const allowed = sourceDescriptors.filter((descriptor) =>
      isToolAllowed(descriptor, mode)
      && !profile.toolDeny.includes(descriptor.name)
      && (profile.toolAllow === null || profile.toolAllow.includes(descriptor.name))
    );
    const projected = projectModelToolDescriptors(
      withReadBatchDescriptor(projectModelToolDescriptors(allowed, capabilities)),
      capabilities
    );
    const gateway = gateways.orchestrator;
    return compileHarnessBuild({
      provider: gateway.provider,
      model: gateway.model,
      reasoningEffort: (config.reasoningEffort ?? "provider_default") as HarnessReasoningEffort,
      modelRole: "orchestrator",
      runMode: mode,
      modelCapabilities: gateway.capabilities,
      runtimeCapabilities: {
        tools: modelTools(projected),
        executionMode: config.executionMode ?? "sandboxed",
        writeScope: config.writeScope ?? "workspace",
        managedEnvironment: (config.managedEnvironmentMode ?? "disabled") === "required",
        network: config.networkMode ?? "full",
        interactiveApprovals: options.interactiveApprovals ?? options.surface !== "cli",
        environment: configuredRuntimeEnvironment(executionReport, config)
      },
      resolvedAgentProfile: profile
    });
  };
}
