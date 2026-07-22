import type { BrokerTransport } from "./broker-transport.js";
import { BrokerPolicyError } from "./errors.js";
import {
  canonicalManagedEnvironmentRequest,
  parseManagedEnvironmentResult
} from "./managed-environment-coordinator.js";
import type {
  BrokerDoctorReport,
  BrokerRequestOptions,
  ManagedEnvironmentPrepareRequestV1,
  ManagedEnvironmentPrepareResultV1
} from "./types.js";

export async function requestManagedEnvironmentPreparation(
  transport: BrokerTransport,
  report: BrokerDoctorReport | undefined,
  request: ManagedEnvironmentPrepareRequestV1,
  options: BrokerRequestOptions
): Promise<ManagedEnvironmentPrepareResultV1> {
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
