import { BrokerProtocolError } from "./errors.js";
import { protocolRecord } from "./protocol.js";
import type { BrokerSandboxLeaseStatus, BrokerSandboxRevokeResult } from "./types.js";

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new BrokerProtocolError(`${label} must be a string.`);
  return value;
}

export function parseSandboxLeaseStatus(input: unknown): BrokerSandboxLeaseStatus {
  const value = protocolRecord(input, "Broker sandbox lease status");
  const roots = value.roots;
  if (!Array.isArray(roots) || roots.some((item) => typeof item !== "string" || !item)) {
    throw new BrokerProtocolError("Broker sandbox lease roots are invalid.");
  }
  if (!Number.isSafeInteger(value.generation) || Number(value.generation) < 1) {
    throw new BrokerProtocolError("Broker sandbox lease generation is invalid.");
  }
  if (value.access !== "read" && value.access !== "write") {
    throw new BrokerProtocolError("Broker sandbox lease access is invalid.");
  }
  if (!["preparing", "active", "revoking", "retired", "tainted"].includes(String(value.state))) {
    throw new BrokerProtocolError("Broker sandbox lease state is invalid.");
  }
  return {
    leaseId: stringValue(value.leaseId, "sandbox leaseId"),
    workspaceIdentity: stringValue(value.workspaceIdentity, "sandbox workspaceIdentity"),
    generation: Number(value.generation),
    principalId: stringValue(value.principalId, "sandbox principalId"),
    access: value.access,
    roots: roots as string[],
    state: value.state as BrokerSandboxLeaseStatus["state"]
  };
}

export function parseSandboxRevokeResult(input: unknown): BrokerSandboxRevokeResult {
  const value = protocolRecord(input, "Broker sandbox revoke result");
  if (typeof value.revoked !== "boolean" || !Number.isSafeInteger(value.generation)
    || Number(value.generation) < 1) {
    throw new BrokerProtocolError("Broker sandbox revoke result is invalid.");
  }
  return {
    revoked: value.revoked,
    retiredPrincipalId: stringValue(value.retiredPrincipalId, "sandbox retiredPrincipalId"),
    generation: Number(value.generation)
  };
}
