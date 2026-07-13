import type { JsonValue } from "agent-protocol";
import type { RuntimeCompositionConfig } from "./configured-runtime.js";

export function subjectConfigurationV1(config: RuntimeCompositionConfig): JsonValue {
  const {
    workspace: _workspace,
    workspaceMcpTrust,
    workspaceCustomizationTrust,
    ...settings
  } = config;
  return JSON.parse(JSON.stringify({
    ...settings,
    workspaceMcpTrust: workspaceMcpTrust ? {
      required: workspaceMcpTrust.required,
      trusted: workspaceMcpTrust.trusted,
      configDigest: workspaceMcpTrust.configDigest
    } : null,
    workspaceCustomizationTrust: workspaceCustomizationTrust ? {
      required: workspaceCustomizationTrust.required,
      trusted: workspaceCustomizationTrust.trusted,
      customizationDigest: workspaceCustomizationTrust.customizationDigest
    } : null
  })) as JsonValue;
}
