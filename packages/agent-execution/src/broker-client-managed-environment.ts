import type { BrokerTransport } from "./broker-transport.js";
import { BrokerPolicyError } from "./errors.js";
import {
  canonicalManagedEnvironmentRequest,
  parseManagedEnvironmentResult
} from "./managed-environment-coordinator.js";
import type {
  BrokerDoctorReport,
  BrokerRequestOptions,
  ManagedEnvironmentPrepareRequest,
  ManagedEnvironmentPrepareResult
} from "./types.js";

export async function requestManagedEnvironmentPreparation(
  transport: BrokerTransport,
  report: BrokerDoctorReport | undefined,
  request: ManagedEnvironmentPrepareRequest,
  options: BrokerRequestOptions
): Promise<ManagedEnvironmentPrepareResult> {
  if (report?.capabilities.managedEnvironment?.prepare !== true) {
    throw new BrokerPolicyError("Broker does not advertise managed environment preparation.");
  }
  const canonical = canonicalManagedEnvironmentRequest(request);
  return parseManagedEnvironmentResult(await transport.request(
    "environment.prepare",
    { ...canonical },
    { ...options, timeoutMs: options.timeoutMs ?? 600_000 }
  ));
}
