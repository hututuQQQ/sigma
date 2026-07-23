import { BrokerTransport } from "./broker-transport.js";
import { BrokerPolicyError, BrokerProtocolError } from "./errors.js";
import type {
  BrokerRequestOptions,
  ScratchLeaseRequestV1,
  ScratchLeaseV1
} from "./types.js";
import { parseScratchLease } from "./values.js";

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/u.test(sessionId)) {
    throw new BrokerPolicyError("Scratch sessionId must be a bounded runtime identifier.");
  }
}

export async function requestScratchLease(
  transport: BrokerTransport,
  request: ScratchLeaseRequestV1,
  options: BrokerRequestOptions
): Promise<ScratchLeaseV1> {
  if (request.protocolVersion !== 1) {
    throw new BrokerPolicyError("Scratch lease requests must use protocol V1.");
  }
  assertSessionId(request.sessionId);
  const lease = parseScratchLease(await transport.request("scratch.acquire", {
    protocolVersion: 1,
    sessionId: request.sessionId
  }, options));
  if (lease.sessionId !== request.sessionId) {
    throw new BrokerProtocolError("Broker returned a scratch lease for another runtime session.");
  }
  return lease;
}

export async function releaseScratchLease(
  transport: BrokerTransport,
  lease: ScratchLeaseV1,
  options: BrokerRequestOptions
): Promise<void> {
  assertSessionId(lease.sessionId);
  const value = await transport.request("scratch.release", {
    protocolVersion: 1,
    sessionId: lease.sessionId,
    leaseId: lease.leaseId
  }, options);
  if (value === null || typeof value !== "object"
    || typeof (value as { released?: unknown }).released !== "boolean") {
    throw new BrokerProtocolError("Broker returned an invalid scratch release receipt.");
  }
}

export class BrokerScratchLeaseClient {
  private readonly leases = new Map<string, ScratchLeaseV1>();

  constructor(private readonly transport: BrokerTransport) {}

  clear(): void { this.leases.clear(); }

  async acquire(request: ScratchLeaseRequestV1,
    options: BrokerRequestOptions): Promise<ScratchLeaseV1> {
    const existing = this.leases.get(request.sessionId);
    if (existing) return existing;
    const lease = await requestScratchLease(this.transport, request, options);
    const racing = this.leases.get(request.sessionId);
    if (racing && racing.leaseId !== lease.leaseId) {
      throw new BrokerProtocolError("Broker changed a live RuntimeSession scratch lease.");
    }
    this.leases.set(request.sessionId, racing ?? lease);
    return racing ?? lease;
  }

  async release(sessionId: string, options: BrokerRequestOptions): Promise<void> {
    const lease = this.leases.get(sessionId);
    if (!lease) return;
    await releaseScratchLease(this.transport, lease, options);
    if (this.leases.get(sessionId)?.leaseId === lease.leaseId) this.leases.delete(sessionId);
  }
}
