import type { ModelGateway, ModelRequest } from "agent-protocol";

/**
 * Request deterministic auxiliary output only when the provider accepts an
 * explicit temperature. Some reasoning endpoints reject the field instead of
 * ignoring it, so `false` must omit the property entirely.
 */
export function deterministicSamplingOptions(
  gateway: ModelGateway
): Partial<Pick<ModelRequest, "temperature">> {
  return gateway.capabilities.temperatureControl === false
    ? {}
    : { temperature: 0 };
}
