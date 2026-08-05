import type { ModelGateway, ModelRequest } from "agent-protocol";

/**
 * Ask for deterministic auxiliary output only when the provider's wire
 * profile supports an explicit temperature. Some reasoning/Codex endpoints
 * reject the field rather than ignoring it, so `false` must remove the key
 * instead of serializing `undefined` or a default value.
 */
export function deterministicSamplingOptions(
  gateway: ModelGateway
): Partial<Pick<ModelRequest, "temperature">> {
  return gateway.capabilities.temperatureControl === false
    ? {}
    : { temperature: 0 };
}
