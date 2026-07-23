export interface ScratchLeaseRequestV1 {
  protocolVersion: 1;
  sessionId: string;
}

/** Broker-issued RuntimeSession scratch. Observable paths are sandbox
 * destinations; callers cannot select or enlarge the host capability. */
export interface ScratchLeaseV1 extends ScratchLeaseRequestV1 {
  leaseId: string;
  lifetime: "runtime_session";
  isolation: "private";
  persistentAcrossCalls: true;
  home: string;
  temp: string;
}
