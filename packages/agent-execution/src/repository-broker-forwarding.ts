import type { ExecutionBroker } from "./types.js";

/** Preserve structured repository capabilities through capability-decorating
 * brokers. No fallback is synthesized: absence remains fail-closed. */
export function repositoryBrokerCapabilities(broker: ExecutionBroker): Partial<ExecutionBroker> {
  return {
    ...(broker.acquireRepositoryMetadataLease ? {
      acquireRepositoryMetadataLease: broker.acquireRepositoryMetadataLease.bind(broker)
    } : {}),
    ...(broker.acquireRepositoryTransactionLease ? {
      acquireRepositoryTransactionLease: broker.acquireRepositoryTransactionLease.bind(broker)
    } : {}),
    ...(broker.beginRepositoryTransaction ? {
      beginRepositoryTransaction: broker.beginRepositoryTransaction.bind(broker)
    } : {}),
    ...(broker.continueRepositoryTransaction ? {
      continueRepositoryTransaction: broker.continueRepositoryTransaction.bind(broker)
    } : {}),
    ...(broker.abortRepositoryTransaction ? {
      abortRepositoryTransaction: broker.abortRepositoryTransaction.bind(broker)
    } : {}),
    ...(broker.recoverRepositoryTransactions ? {
      recoverRepositoryTransactions: broker.recoverRepositoryTransactions.bind(broker)
    } : {}),
    ...(broker.sealRepositoryTransaction ? {
      sealRepositoryTransaction: broker.sealRepositoryTransaction.bind(broker)
    } : {}),
    ...(broker.restoreRepositoryRunBaseline ? {
      restoreRepositoryRunBaseline: broker.restoreRepositoryRunBaseline.bind(broker)
    } : {}),
    ...(broker.releaseRepositoryRunBaseline ? {
      releaseRepositoryRunBaseline: broker.releaseRepositoryRunBaseline.bind(broker)
    } : {})
  };
}
