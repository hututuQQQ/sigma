export interface RepositoryTransactionLeaseRequestV2 {
  protocolVersion: 2;
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

export interface RepositoryTransactionLeaseV2 extends RepositoryTransactionLeaseRequestV2 {
  leaseId: string;
  executableSha256: string;
  uses: 1;
  /** Runtime-only capability. It is retained by the broker client and is never
   * projected into model-visible tool output. Optional only for legacy V2
   * brokers, which cannot restore a sealed run baseline. */
  runBaseline?: RepositoryRunBaselineLeaseV1;
}

export interface RepositoryRunBaselineLeaseV1 {
  schemaVersion: 1;
  baselineId: string;
  restoreCapability: string;
}

export interface RepositoryRunBaselineRequestV1 {
  protocolVersion: 1;
  sessionId: string;
  runId: string;
  repositoryRoot: string;
}

/** Wire-only request. Trusted broker clients derive this from an acquired
 * lease; callers cannot supply or replace the capability. */
export interface RepositoryRunBaselineBoundRequestV1 extends RepositoryRunBaselineRequestV1 {
  baselineId: string;
  restoreCapability: string;
}

export interface RepositoryOperationV2 {
  operationClass: string;
  args: string[];
}

export interface RepositoryTransactionBeginRequestV2 {
  protocolVersion: 2 | 3;
  leaseId: string;
  operations: RepositoryOperationV2[];
  expectedPostconditions?: RepositoryExpectedPostconditionsV3;
}

export interface RepositoryExpectedPostconditionsV3 {
  schemaVersion: 3;
  selectedHead: string;
  selectedSymbolicRef: string | null;
  requiredReachableObjects: string[];
}

export interface RepositoryTransactionContinueRequestV2 {
  protocolVersion: 2;
  transactionHandle: string;
  sessionId: string;
  runId: string;
  operations?: RepositoryOperationV2[];
}

export interface RepositoryTransactionBoundRequestV2 {
  protocolVersion: 2;
  transactionHandle: string;
  sessionId: string;
  runId: string;
}

export interface RepositoryTransactionRecoverRequestV2 {
  protocolVersion: 2;
  sessionId: string;
  runId?: string;
}

export type RepositoryTransactionStatusV2 =
  | "conflicts_pending"
  | "completed_pending_seal"
  | "aborted"
  | "recovered"
  | "sealed";

export interface RepositoryTransactionResultV2 {
  /** V3 results remain assignable to the compatibility return surface while
   * callers migrate. New brokers write V3 for live transaction results. */
  protocolVersion: 2 | 3;
  status: RepositoryTransactionStatusV2;
  transactionHandle?: string;
  operation?: string | null;
  conflictCount?: number;
  output?: string;
  rollbackState?: "journaled" | "restored";
  gitAbortSucceeded?: boolean;
  recovered?: number;
  semanticAssertions?: RepositorySemanticAssertionsV3;
}

export interface RepositorySemanticAssertionsV3 {
  schemaVersion: 3;
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
  targetAssertions?: RepositoryTargetAssertionsV3;
}

export interface RepositoryTargetAssertionsV3 extends RepositoryExpectedPostconditionsV3 {
  satisfied: true;
}

export interface RepositoryTransactionResultV3 extends RepositoryTransactionResultV2 {
  protocolVersion: 3;
  semanticAssertions: RepositorySemanticAssertionsV3;
}

export interface RepositoryRunBaselineResultV1 {
  protocolVersion: 1;
  status: "restored" | "released";
  baselineId: string;
  sessionId: string;
  runId: string;
  repositoryRoot: string;
  semanticAssertions?: RepositorySemanticAssertionsV3;
}


