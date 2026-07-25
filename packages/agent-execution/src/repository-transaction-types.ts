export interface RepositoryTransactionLeaseRequest {
  protocolVersion: 1;
  sessionId: string;
  runId: string;
  repositoryRoot: string;
  gitDir: string;
  commonDir: string;
  executable: string;
  network: "none";
  maxSnapshotFiles?: number;
  maxSnapshotBytes?: number;
}

export interface RepositoryRunBaselineLease {
  schemaVersion: 1;
  baselineId: string;
  restoreCapability: string;
}

export interface RepositoryTransactionLease extends RepositoryTransactionLeaseRequest {
  leaseId: string;
  executableSha256: string;
  uses: 1;
}

export interface RepositoryTransactionWireLease extends RepositoryTransactionLease {
  runBaseline: RepositoryRunBaselineLease;
}

export interface RepositoryRunBaselineRequest {
  protocolVersion: 1;
  sessionId: string;
  runId: string;
  repositoryRoot: string;
}

/** Wire-only request. Trusted broker clients derive this from an acquired
 * lease; callers cannot supply or replace the capability. */
export interface RepositoryRunBaselineBoundRequest extends RepositoryRunBaselineRequest {
  baselineId: string;
  restoreCapability: string;
}

export interface RepositoryOperation {
  operationClass: string;
  args: string[];
}

export interface RepositoryExpectedPostconditions {
  schemaVersion: 1;
  selectedHead: string;
  selectedSymbolicRef: string | null;
  requiredReachableObjects: string[];
}

export interface RepositoryTransactionBeginRequest {
  protocolVersion: 1;
  leaseId: string;
  operations: RepositoryOperation[];
  expectedPostconditions?: RepositoryExpectedPostconditions;
}

export interface RepositoryTransactionContinueRequest {
  protocolVersion: 1;
  transactionHandle: string;
  sessionId: string;
  runId: string;
  operations?: RepositoryOperation[];
}

export interface RepositoryTransactionBoundRequest {
  protocolVersion: 1;
  transactionHandle: string;
  sessionId: string;
  runId: string;
}

export interface RepositoryTransactionRecoverRequest {
  protocolVersion: 1;
  sessionId: string;
  runId?: string;
}

export type RepositoryTransactionStatus =
  | "conflicts_pending"
  | "completed_pending_seal"
  | "aborted"
  | "recovered"
  | "sealed";

export interface RepositoryTargetAssertions extends RepositoryExpectedPostconditions {
  satisfied: true;
}

export interface RepositorySemanticAssertions {
  schemaVersion: 1;
  head: string | null;
  symbolicRef: string | null;
  refsDigest: string;
  reachabilityDigest: string;
  reachableObjectCount: number;
  indexDigest: string;
  conflictsDigest: string;
  conflictCount: number;
  trackedDigest: string;
  trackedCount: number;
  untrackedDigest: string;
  untrackedCount: number;
  targetAssertions?: RepositoryTargetAssertions;
}

export interface RepositoryTransactionResult {
  protocolVersion: 1;
  status: RepositoryTransactionStatus;
  transactionHandle?: string;
  operation?: string | null;
  conflictCount?: number;
  output?: string;
  rollbackState?: "journaled" | "restored";
  gitAbortSucceeded?: boolean;
  recovered?: number;
  semanticAssertions?: RepositorySemanticAssertions;
}

export interface RepositoryRunBaselineResult {
  protocolVersion: 1;
  status: "restored" | "released";
  baselineId: string;
  sessionId: string;
  runId: string;
  repositoryRoot: string;
  semanticAssertions?: RepositorySemanticAssertions;
}
