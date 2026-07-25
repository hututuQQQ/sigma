import type {
  RepositoryMetadataLeaseRequest,
  RepositoryMetadataLease
} from "./repository-metadata-lease-types.js";
import type {
  RepositoryRunBaselineRequest,
  RepositoryRunBaselineResult,
  RepositoryTransactionBeginRequest,
  RepositoryTransactionBoundRequest,
  RepositoryTransactionContinueRequest,
  RepositoryTransactionLeaseRequest,
  RepositoryTransactionLease,
  RepositoryTransactionRecoverRequest,
  RepositoryTransactionResult
} from "./repository-transaction-types.js";

export interface RepositoryBrokerRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Optional structured repository capabilities. Ordinary process execution
 * never inherits these authorities. */
export interface RepositoryExecutionBroker {
  acquireRepositoryMetadataLease?(
    request: RepositoryMetadataLeaseRequest,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryMetadataLease>;
  acquireRepositoryTransactionLease?(
    request: RepositoryTransactionLeaseRequest,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionLease>;
  beginRepositoryTransaction?(
    request: RepositoryTransactionBeginRequest,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionResult>;
  continueRepositoryTransaction?(
    request: RepositoryTransactionContinueRequest,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionResult>;
  abortRepositoryTransaction?(
    request: RepositoryTransactionBoundRequest,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionResult>;
  recoverRepositoryTransactions?(
    request: RepositoryTransactionRecoverRequest,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionResult>;
  sealRepositoryTransaction?(
    request: RepositoryTransactionBoundRequest,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionResult>;
  restoreRepositoryRunBaseline?(
    request: RepositoryRunBaselineRequest,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryRunBaselineResult>;
  releaseRepositoryRunBaseline?(
    request: RepositoryRunBaselineRequest,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryRunBaselineResult>;
}
