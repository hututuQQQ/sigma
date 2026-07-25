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
  RepositoryMetadataLeaseRequest,
  RepositoryRunBaselineLease,
  RepositoryRunBaselineRequest,
  RepositoryRunBaselineResult,
  RepositoryTransactionBeginRequest,
  RepositoryTransactionBoundRequest,
  RepositoryTransactionContinueRequest,
  RepositoryTransactionLeaseRequest,
  RepositoryTransactionLease,
  RepositoryTransactionRecoverRequest,
  RepositoryTransactionResult
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
        transport, request as RepositoryMetadataLeaseRequest, options
      );
    case "acquireRepositoryTransactionLease":
      return await environment.acquireTransactionLease(
        request as RepositoryTransactionLeaseRequest, options
      );
    case "beginRepositoryTransaction":
      return await environment.beginTransaction(request as RepositoryTransactionBeginRequest, options);
    case "continueRepositoryTransaction":
      return await environment.continueTransaction(request as RepositoryTransactionContinueRequest, options);
    case "abortRepositoryTransaction":
      return await environment.abortTransaction(request as RepositoryTransactionBoundRequest, options);
    case "recoverRepositoryTransactions":
      return await environment.recoverTransactions(request as RepositoryTransactionRecoverRequest, options);
    case "sealRepositoryTransaction":
      return await environment.sealTransaction(request as RepositoryTransactionBoundRequest, options);
    case "restoreRepositoryRunBaseline":
      return await environment.restoreRunBaseline(request as RepositoryRunBaselineRequest, options);
    case "releaseRepositoryRunBaseline":
      return await environment.releaseRunBaseline(request as RepositoryRunBaselineRequest, options);
  }
}

/** Retains broker-only restore capabilities outside model-visible tool data. */
export class BrokerRepositoryEnvironmentClient {
  private readonly runBaselines = new Map<string, {
    binding: RepositoryRunBaselineLease;
    request: RepositoryRunBaselineRequest;
  }>();

  constructor(private readonly transport: BrokerTransport) {}

  async acquireTransactionLease(
    request: RepositoryTransactionLeaseRequest,
    options: BrokerRequestOptions
  ): Promise<RepositoryTransactionLease> {
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
    request: RepositoryTransactionBeginRequest,
    options: BrokerRequestOptions
  ): Promise<RepositoryTransactionResult> {
    return await beginRepositoryTransaction(this.transport, request, {
      ...options, timeoutMs: options.timeoutMs ?? 600_000
    });
  }

  async continueTransaction(
    request: RepositoryTransactionContinueRequest,
    options: BrokerRequestOptions
  ): Promise<RepositoryTransactionResult> {
    return await continueRepositoryTransaction(this.transport, request, {
      ...options, timeoutMs: options.timeoutMs ?? 600_000
    });
  }

  async abortTransaction(
    request: RepositoryTransactionBoundRequest,
    options: BrokerRequestOptions
  ): Promise<RepositoryTransactionResult> {
    return await abortRepositoryTransaction(this.transport, request, {
      ...options, timeoutMs: options.timeoutMs ?? 120_000
    });
  }

  async recoverTransactions(
    request: RepositoryTransactionRecoverRequest,
    options: BrokerRequestOptions
  ): Promise<RepositoryTransactionResult> {
    return await recoverRepositoryTransactions(this.transport, request, {
      ...options, timeoutMs: options.timeoutMs ?? 120_000
    });
  }

  async sealTransaction(
    request: RepositoryTransactionBoundRequest,
    options: BrokerRequestOptions
  ): Promise<RepositoryTransactionResult> {
    return await sealRepositoryTransaction(this.transport, request, options);
  }

  async restoreRunBaseline(
    request: RepositoryRunBaselineRequest,
    options: BrokerRequestOptions
  ): Promise<RepositoryRunBaselineResult> {
    return await this.consumeRunBaseline(request, "restore", options);
  }

  async releaseRunBaseline(
    request: RepositoryRunBaselineRequest,
    options: BrokerRequestOptions
  ): Promise<RepositoryRunBaselineResult> {
    return await this.consumeRunBaseline(request, "release", options);
  }

  clear(): void { this.runBaselines.clear(); }

  private async consumeRunBaseline(
    request: RepositoryRunBaselineRequest,
    action: "restore" | "release",
    options: BrokerRequestOptions
  ): Promise<RepositoryRunBaselineResult> {
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
    RepositoryRunBaselineRequest, "sessionId" | "runId" | "repositoryRoot"
  >): string {
    return `${request.sessionId}\0${request.runId}\0${path.resolve(request.repositoryRoot)}`;
  }
}
