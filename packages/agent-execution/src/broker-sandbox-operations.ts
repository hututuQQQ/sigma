import {
  assertRequiredSandbox, containPostDispatchFailure, parsePostDispatchValue
} from "./broker-client-support.js";
import type { BrokerTransport } from "./broker-transport.js";
import { BrokerConnectionError } from "./errors.js";
import { parseSandboxLeaseStatus, parseSandboxRevokeResult } from "./sandbox-values.js";
import type {
  BrokerDoctorReport, BrokerSandboxLeaseStatus, BrokerSandboxRevokeResult
} from "./types.js";
import { parseDoctor } from "./values.js";

export async function requestSandboxReport(
  transport: BrokerTransport,
  method: "doctor" | "sandbox.setup" | "sandbox.repair",
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onInvalid?: () => Promise<void>
): Promise<BrokerDoctorReport> {
  const value = await transport.request(method, {}, { signal, timeoutMs });
  return onInvalid ? await parsePostDispatchValue(value, parseDoctor, onInvalid) : parseDoctor(value);
}

export async function requestVerifiedSandboxReport(options: {
  transport: BrokerTransport;
  method: "doctor" | "sandbox.setup" | "sandbox.repair";
  timeoutMs: number;
  signal: AbortSignal | undefined;
  closeRequested: () => boolean;
  close: () => Promise<void>;
  closedMessage: string;
}): Promise<BrokerDoctorReport> {
  const report = await requestSandboxReport(
    options.transport, options.method, options.timeoutMs, options.signal, options.close
  );
  try {
    assertRequiredSandbox(report, "required");
  } catch (error) {
    return await containPostDispatchFailure(error, options.close);
  }
  if (options.closeRequested()) throw new BrokerConnectionError(options.closedMessage);
  return report;
}

export async function requestSandboxLeaseStatus(
  transport: BrokerTransport,
  workspacePath: string,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined
): Promise<BrokerSandboxLeaseStatus> {
  return parseSandboxLeaseStatus(await transport.request(
    "sandbox.status", { workspacePath }, { signal, timeoutMs }
  ));
}

export async function requestSandboxLeaseRevoke(
  transport: BrokerTransport,
  workspacePath: string,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined
): Promise<BrokerSandboxRevokeResult> {
  return parseSandboxRevokeResult(await transport.request(
    "sandbox.revoke", { workspacePath }, { signal, timeoutMs }
  ));
}
