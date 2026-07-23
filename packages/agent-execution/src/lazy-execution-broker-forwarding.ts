import type {
  BrokerRequestOptions,
  BrokerSandboxLeaseStatus,
  BrokerSandboxRevokeResult,
  ExecutionBroker,
  ScratchLeaseRequestV1,
  ScratchLeaseV1
} from "./types.js";

export async function forwardSandboxLeaseStatus(
  client: ExecutionBroker,
  workspacePath: string,
  signal?: AbortSignal
): Promise<BrokerSandboxLeaseStatus> {
  if (!client.sandboxLeaseStatus) {
    throw Object.assign(new Error("Sandbox lease status is unavailable."), {
      code: "sandbox_recovery_required"
    });
  }
  return await client.sandboxLeaseStatus(workspacePath, signal);
}

export async function forwardScratchLease(
  client: ExecutionBroker,
  request: ScratchLeaseRequestV1,
  options?: BrokerRequestOptions
): Promise<ScratchLeaseV1> {
  if (!client.acquireScratchLease || !client.releaseScratchLease) {
    throw Object.assign(new Error("RuntimeSession scratch leases are unavailable."), {
      code: "scratch_lease_unavailable"
    });
  }
  return await client.acquireScratchLease(request, options);
}

export async function forwardScratchLeaseRelease(
  client: ExecutionBroker,
  sessionId: string,
  options?: BrokerRequestOptions
): Promise<void> {
  if (!client.releaseScratchLease) {
    throw Object.assign(new Error("RuntimeSession scratch lease release is unavailable."), {
      code: "scratch_lease_unavailable"
    });
  }
  await client.releaseScratchLease(sessionId, options);
}

export async function forwardSandboxLeaseRevoke(
  client: ExecutionBroker,
  workspacePath: string,
  signal?: AbortSignal
): Promise<BrokerSandboxRevokeResult> {
  if (!client.revokeSandboxLease) {
    throw Object.assign(new Error("Sandbox lease revoke is unavailable."), {
      code: "sandbox_recovery_required"
    });
  }
  return await client.revokeSandboxLease(workspacePath, signal);
}
