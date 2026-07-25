export interface ScratchLeaseRequest {
  protocolVersion: 1;
  sessionId: string;
}

/** Broker-issued RuntimeSession scratch. Observable paths are sandbox
 * destinations; callers cannot select or enlarge the host capability. */
export interface ScratchLease extends ScratchLeaseRequest {
  leaseId: string;
  lifetime: "runtime_session";
  isolation: "private";
  persistentAcrossCalls: true;
  home: string;
  temp: string;
}
