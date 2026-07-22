import path from "node:path";
import type { BrokerTransport } from "./broker-transport.js";
import {
  abortRepositoryTransaction,
  acquireRepositoryTransactionLease,
  beginRepositoryTransaction,
  continueRepositoryTransaction,
  recoverRepositoryTransactions,
  releaseRepositoryRunBaseline,
  restoreRepositoryRunBaseline,
  sealRepositoryTransaction
} from "./broker-client-repository-transaction.js";
import { BrokerError } from "./errors.js";
import { requestRepositoryMetadataLease } from "./broker-client-repository-lease.js";
import type { RepositoryOperationMethod } from "./repository-execution-broker-base.js";
import type {
  BrokerRequestOptions,
  RepositoryMetadataLeaseRequestV1,
  RepositoryRunBaselineLeaseV1,
  RepositoryRunBaselineRequestV1,
  RepositoryRunBaselineResultV1,
  RepositoryTransactionBeginRequestV2,
  RepositoryTransactionBoundRequestV2,
  RepositoryTransactionContinueRequestV2,
  RepositoryTransactionLeaseRequestV2,
  RepositoryTransactionLeaseV2,
  RepositoryTransactionRecoverRequestV2,
  RepositoryTransactionResultV2
} from "./types.js";

export async function invokeBrokerClientRepositoryOperation(
  transport: BrokerTransport,
  environment: BrokerRepositoryEnvironmentClient,
  method: RepositoryOperationMethod,
  request: unknown,
  options: BrokerRequestOptions
): Promise<unknown> {
  switch (method) {
    case "acquireRepositoryMetadataLease":
      return await requestRepositoryMetadataLease(
        transport, request as RepositoryMetadataLeaseRequestV1, options
      );
    case "acquireRepositoryTransactionLease":
      return await environment.acquireTransactionLease(
        request as RepositoryTransactionLeaseRequestV2, options
      );
    case "beginRepositoryTransaction":
      return await environment.beginTransaction(request as RepositoryTransactionBeginRequestV2, options);
    case "continueRepositoryTransaction":
      return await environment.continueTransaction(request as RepositoryTransactionContinueRequestV2, options);
    case "abortRepositoryTransaction":
      return await environment.abortTransaction(request as RepositoryTransactionBoundRequestV2, options);
    case "recoverRepositoryTransactions":
      return await environment.recoverTransactions(request as RepositoryTransactionRecoverRequestV2, options);
    case "sealRepositoryTransaction":
      return await environment.sealTransaction(request as RepositoryTransactionBoundRequestV2, options);
    case "restoreRepositoryRunBaseline":
      return await environment.restoreRunBaseline(request as RepositoryRunBaselineRequestV1, options);
    case "releaseRepositoryRunBaseline":
      return await environment.releaseRunBaseline(request as RepositoryRunBaselineRequestV1, options);
  }
}

/** Retains broker-only restore capabilities outside model-visible tool data. */
export class BrokerRepositoryEnvironmentClient {
  private readonly runBaselines = new Map<string, {
    binding: RepositoryRunBaselineLeaseV1;
    request: RepositoryRunBaselineRequestV1;
  }>();

  constructor(private readonly transport: BrokerTransport) {}

  async acquireTransactionLease(
    request: RepositoryTransactionLeaseRequestV2,
    options: BrokerRequestOptions
  ): Promise<RepositoryTransactionLeaseV2> {
    const lease = await acquireRepositoryTransactionLease(this.transport, request, options);
    if (lease.runBaseline) {
      this.runBaselines.set(this.baselineKey(request), {
        binding: lease.runBaseline,
        request: {
          protocolVersion: 1,
          sessionId: request.sessionId,
          runId: request.runId,
          repositoryRoot: path.resolve(request.repositoryRoot)
        }
      });
    }
    const { runBaseline: _brokerOnly, ...publicLease } = lease;
    return publicLease;
  }

  async beginTransaction(
    request: RepositoryTransactionBeginRequestV2,
    options: BrokerRequestOptions
  ): Promise<RepositoryTransactionResultV2> {
    return await beginRepositoryTransaction(this.transport, request, {
      ...options, timeoutMs: options.timeoutMs ?? 600_000
    });
  }

  async continueTransaction(
    request: RepositoryTransactionContinueRequestV2,
    options: BrokerRequestOptions
  ): Promise<RepositoryTransactionResultV2> {
    return await continueRepositoryTransaction(this.transport, request, {
      ...options, timeoutMs: options.timeoutMs ?? 600_000
    });
  }

  async abortTransaction(
    request: RepositoryTransactionBoundRequestV2,
    options: BrokerRequestOptions
  ): Promise<RepositoryTransactionResultV2> {
    return await abortRepositoryTransaction(this.transport, request, {
      ...options, timeoutMs: options.timeoutMs ?? 120_000
    });
  }

  async recoverTransactions(
    request: RepositoryTransactionRecoverRequestV2,
    options: BrokerRequestOptions
  ): Promise<RepositoryTransactionResultV2> {
    return await recoverRepositoryTransactions(this.transport, request, {
      ...options, timeoutMs: options.timeoutMs ?? 120_000
    });
  }

  async sealTransaction(
    request: RepositoryTransactionBoundRequestV2,
    options: BrokerRequestOptions
  ): Promise<RepositoryTransactionResultV2> {
    return await sealRepositoryTransaction(this.transport, request, options);
  }

  async restoreRunBaseline(
    request: RepositoryRunBaselineRequestV1,
    options: BrokerRequestOptions
  ): Promise<RepositoryRunBaselineResultV1> {
    return await this.consumeRunBaseline(request, "restore", options);
  }

  async releaseRunBaseline(
    request: RepositoryRunBaselineRequestV1,
    options: BrokerRequestOptions
  ): Promise<RepositoryRunBaselineResultV1> {
    return await this.consumeRunBaseline(request, "release", options);
  }

  clear(): void { this.runBaselines.clear(); }

  private async consumeRunBaseline(
    request: RepositoryRunBaselineRequestV1,
    action: "restore" | "release",
    options: BrokerRequestOptions
  ): Promise<RepositoryRunBaselineResultV1> {
    const key = this.baselineKey(request);
    const cached = this.runBaselines.get(key);
    if (!cached) {
      throw new BrokerError(
        `The broker did not issue a ${action === "restore" ? "restorable" : "releasable"} run-scoped repository baseline for this binding.`,
        "repository_atomicity_unavailable"
      );
    }
    try {
      const bound = {
        ...request,
        baselineId: cached.binding.baselineId,
        restoreCapability: cached.binding.restoreCapability
      };
      return action === "restore"
        ? await restoreRepositoryRunBaseline(this.transport, bound, {
          ...options, timeoutMs: options.timeoutMs ?? 600_000
        })
        : await releaseRepositoryRunBaseline(this.transport, bound, {
          ...options, timeoutMs: options.timeoutMs ?? 120_000
        });
    } finally {
      this.runBaselines.delete(key);
    }
  }

  private baselineKey(request: Pick<
    RepositoryRunBaselineRequestV1, "sessionId" | "runId" | "repositoryRoot"
  >): string {
    return `${request.sessionId}\0${request.runId}\0${path.resolve(request.repositoryRoot)}`;
  }
}
