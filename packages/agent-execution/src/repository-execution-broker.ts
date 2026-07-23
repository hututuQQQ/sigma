import type {
  RepositoryMetadataLeaseRequestV1,
  RepositoryMetadataLeaseV1
} from "./repository-metadata-lease-types.js";
import type {
  RepositoryRunBaselineRequestV1,
  RepositoryRunBaselineResultV1,
  RepositoryTransactionBeginRequestV2,
  RepositoryTransactionBoundRequestV2,
  RepositoryTransactionContinueRequestV2,
  RepositoryTransactionLeaseRequestV2,
  RepositoryTransactionLeaseV2,
  RepositoryTransactionRecoverRequestV2,
  RepositoryTransactionResultV2
} from "./repository-transaction-types.js";

export interface RepositoryBrokerRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Optional structured repository capabilities. Ordinary process execution
 * never inherits these authorities. */
export interface RepositoryExecutionBroker {
  acquireRepositoryMetadataLease?(
    request: RepositoryMetadataLeaseRequestV1,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryMetadataLeaseV1>;
  acquireRepositoryTransactionLease?(
    request: RepositoryTransactionLeaseRequestV2,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionLeaseV2>;
  beginRepositoryTransaction?(
    request: RepositoryTransactionBeginRequestV2,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionResultV2>;
  continueRepositoryTransaction?(
    request: RepositoryTransactionContinueRequestV2,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionResultV2>;
  abortRepositoryTransaction?(
    request: RepositoryTransactionBoundRequestV2,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionResultV2>;
  recoverRepositoryTransactions?(
    request: RepositoryTransactionRecoverRequestV2,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionResultV2>;
  sealRepositoryTransaction?(
    request: RepositoryTransactionBoundRequestV2,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionResultV2>;
  restoreRepositoryRunBaseline?(
    request: RepositoryRunBaselineRequestV1,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryRunBaselineResultV1>;
  releaseRepositoryRunBaseline?(
    request: RepositoryRunBaselineRequestV1,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryRunBaselineResultV1>;
}
