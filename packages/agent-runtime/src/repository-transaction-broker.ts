import type {
  RepositoryOperationV2,
  RepositoryTransactionResultV2
} from "agent-execution";
import type { ProcessExecutionPort } from "agent-platform";
import type { ToolDescriptor } from "agent-protocol";
import type { RepositoryWorktreeTopology } from "agent-tools";
import {
  gitOperationArgs,
  isDestructiveGitOperation,
  mutatesWorktree,
  type GitOperation
} from "./repository-transaction-schema.js";
import type { RepositoryEvidenceState } from "./repository-transaction-state.js";

export type RepositoryTransactionPort = ProcessExecutionPort & Required<Pick<
  ProcessExecutionPort,
  "acquireRepositoryTransactionLease" | "beginRepositoryTransaction"
    | "continueRepositoryTransaction" | "abortRepositoryTransaction"
    | "recoverRepositoryTransactions" | "sealRepositoryTransaction"
>>;

export interface PendingRepositoryTransaction {
  handle: string;
  sessionId: string;
  runId: string;
  topology: RepositoryWorktreeTopology;
  before: RepositoryEvidenceState;
  operations: GitOperation[];
  recoverySelection?: {
    candidateId: string;
    selectionEvidenceId: string;
    selectedObject: string;
    selectedSymbolicRef: string | null;
    integrationMode: "exact_head" | "merge";
  };
}

export class PendingRepositoryTransactions {
  private readonly records = new Map<string, PendingRepositoryTransaction>();

  record(transaction: PendingRepositoryTransaction): void {
    this.records.set(transaction.handle, transaction);
  }

  resolve(handle: string, sessionId: string, runId: string): PendingRepositoryTransaction {
    const transaction = this.records.get(handle);
    if (!transaction || transaction.sessionId !== sessionId || transaction.runId !== runId) {
      throw Object.assign(new Error(
        "Repository transaction handle is unknown, expired, or belongs to another run."
      ), { code: "repository_transaction_handle_invalid" });
    }
    return transaction;
  }

  consume(handle: string): void { this.records.delete(handle); }
}

export function requireRepositoryTransactionBroker(
  execution: ProcessExecutionPort
): asserts execution is RepositoryTransactionPort {
  if (!execution.acquireRepositoryTransactionLease || !execution.beginRepositoryTransaction
    || !execution.continueRepositoryTransaction || !execution.abortRepositoryTransaction
    || !execution.recoverRepositoryTransactions || !execution.sealRepositoryTransaction) {
    throw Object.assign(new Error(
      "The execution broker does not expose journaled repository transactions."
    ), { code: "repository_atomicity_unavailable" });
  }
}

export function brokerOperations(operations: readonly GitOperation[]): RepositoryOperationV2[] {
  return operations.map((operation) => ({
    operationClass: operation.op,
    args: gitOperationArgs(operation)
  }));
}

export function transactionEffects(
  operations: readonly GitOperation[],
  topology: RepositoryWorktreeTopology
): ToolDescriptor["possibleEffects"] {
  return [
    "repository.write",
    ...(topology.trust === "external_untrusted" ? ["filesystem.read.external" as const] : []),
    ...(operations.some(mutatesWorktree) ? ["filesystem.write" as const] : []),
    ...(operations.some(isDestructiveGitOperation) ? ["destructive" as const] : [])
  ];
}

export function requireTransactionHandle(result: RepositoryTransactionResultV2): string {
  if (!result.transactionHandle) {
    throw Object.assign(new Error(
      "Broker repository result omitted its durable transaction handle."
    ), { code: "repository_state_uncertain" });
  }
  return result.transactionHandle;
}

export function requireCompletedAssertions(result: RepositoryTransactionResultV2) {
  if (result.status !== "completed_pending_seal" || result.protocolVersion !== 3
    || !result.semanticAssertions || result.semanticAssertions.conflictCount !== 0) {
    throw Object.assign(new Error(
      "Broker repository transaction did not provide conflict-free V3 semantic assertions."
    ), { code: "repository_postcondition_failed" });
  }
  return result.semanticAssertions;
}
