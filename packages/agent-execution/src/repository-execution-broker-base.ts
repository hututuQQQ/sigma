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
    request: RepositoryMetadataLeaseRequestV1,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryMetadataLeaseV1> {
    return await this.repositoryOperation(
      "acquireRepositoryMetadataLease", request, options
    ) as RepositoryMetadataLeaseV1;
  }

  async acquireRepositoryTransactionLease(
    request: RepositoryTransactionLeaseRequestV2,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionLeaseV2> {
    return await this.repositoryOperation(
      "acquireRepositoryTransactionLease", request, options
    ) as RepositoryTransactionLeaseV2;
  }

  async beginRepositoryTransaction(
    request: RepositoryTransactionBeginRequestV2,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionResultV2> {
    return await this.repositoryOperation(
      "beginRepositoryTransaction", request, options
    ) as RepositoryTransactionResultV2;
  }

  async continueRepositoryTransaction(
    request: RepositoryTransactionContinueRequestV2,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionResultV2> {
    return await this.repositoryOperation(
      "continueRepositoryTransaction", request, options
    ) as RepositoryTransactionResultV2;
  }

  async abortRepositoryTransaction(
    request: RepositoryTransactionBoundRequestV2,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionResultV2> {
    return await this.repositoryOperation(
      "abortRepositoryTransaction", request, options
    ) as RepositoryTransactionResultV2;
  }

  async recoverRepositoryTransactions(
    request: RepositoryTransactionRecoverRequestV2,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionResultV2> {
    return await this.repositoryOperation(
      "recoverRepositoryTransactions", request, options
    ) as RepositoryTransactionResultV2;
  }

  async sealRepositoryTransaction(
    request: RepositoryTransactionBoundRequestV2,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryTransactionResultV2> {
    return await this.repositoryOperation(
      "sealRepositoryTransaction", request, options
    ) as RepositoryTransactionResultV2;
  }

  async restoreRepositoryRunBaseline(
    request: RepositoryRunBaselineRequestV1,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryRunBaselineResultV1> {
    return await this.repositoryOperation(
      "restoreRepositoryRunBaseline", request, options
    ) as RepositoryRunBaselineResultV1;
  }

  async releaseRepositoryRunBaseline(
    request: RepositoryRunBaselineRequestV1,
    options?: RepositoryBrokerRequestOptions
  ): Promise<RepositoryRunBaselineResultV1> {
    return await this.repositoryOperation(
      "releaseRepositoryRunBaseline", request, options
    ) as RepositoryRunBaselineResultV1;
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
