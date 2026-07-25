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
import type {
  RepositoryBrokerRequestOptions,
  RepositoryExecutionBroker
} from "./repository-execution-broker.js";

export type RepositoryOperationMethod = keyof RepositoryExecutionBroker;

/** Keeps capability forwarding out of lifecycle-heavy broker adapters. */
export abstract class RepositoryExecutionBrokerBase implements RepositoryExecutionBroker {
  protected abstract repositoryOperation(
    method: RepositoryOperationMethod,
    request: unknown,
    options?: RepositoryBrokerRequestOptions
  ): Promise<unknown>;

  async acquireRepositoryMetadataLease(
    request: RepositoryMetadataLeaseRequest,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryMetadataLease> {
    return await this.repositoryOperation(
      "acquireRepositoryMetadataLease", request, options
    ) as RepositoryMetadataLease;
  }

  async acquireRepositoryTransactionLease(
    request: RepositoryTransactionLeaseRequest,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionLease> {
    return await this.repositoryOperation(
      "acquireRepositoryTransactionLease", request, options
    ) as RepositoryTransactionLease;
  }

  async beginRepositoryTransaction(
    request: RepositoryTransactionBeginRequest,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionResult> {
    return await this.repositoryOperation(
      "beginRepositoryTransaction", request, options
    ) as RepositoryTransactionResult;
  }

  async continueRepositoryTransaction(
    request: RepositoryTransactionContinueRequest,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionResult> {
    return await this.repositoryOperation(
      "continueRepositoryTransaction", request, options
    ) as RepositoryTransactionResult;
  }

  async abortRepositoryTransaction(
    request: RepositoryTransactionBoundRequest,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionResult> {
    return await this.repositoryOperation(
      "abortRepositoryTransaction", request, options
    ) as RepositoryTransactionResult;
  }

  async recoverRepositoryTransactions(
    request: RepositoryTransactionRecoverRequest,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionResult> {
    return await this.repositoryOperation(
      "recoverRepositoryTransactions", request, options
    ) as RepositoryTransactionResult;
  }

  async sealRepositoryTransaction(
    request: RepositoryTransactionBoundRequest,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionResult> {
    return await this.repositoryOperation(
      "sealRepositoryTransaction", request, options
    ) as RepositoryTransactionResult;
  }

  async restoreRepositoryRunBaseline(
    request: RepositoryRunBaselineRequest,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryRunBaselineResult> {
    return await this.repositoryOperation(
      "restoreRepositoryRunBaseline", request, options
    ) as RepositoryRunBaselineResult;
  }

  async releaseRepositoryRunBaseline(
    request: RepositoryRunBaselineRequest,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryRunBaselineResult> {
    return await this.repositoryOperation(
      "releaseRepositoryRunBaseline", request, options
    ) as RepositoryRunBaselineResult;
  }
}

export async function invokeRepositoryOperation(
  broker: RepositoryExecutionBroker,
  method: RepositoryOperationMethod,
  request: unknown,
  options: RepositoryBrokerRequestOptions | undefined,
  unavailableMessage: string
): Promise<unknown> {
  const operation = broker[method] as ((
    value: unknown, requestOptions?: RepositoryBrokerRequestOptions
  ) => Promise<unknown>) | undefined;
  if (!operation) throw Object.assign(new Error(unavailableMessage), {
    code: method === "acquireRepositoryMetadataLease"
      ? "repository_metadata_lease_unavailable"
      : "repository_atomicity_unavailable"
  });
  return await operation.call(broker, request, options);
}
