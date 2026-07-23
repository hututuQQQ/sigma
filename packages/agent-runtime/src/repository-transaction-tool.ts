import { lstat } from "node:fs/promises";
import type { JsonValue, ToolCallPlan, ToolReceipt } from "agent-protocol";
import {
  canonicalWorkspacePath,
  type ProcessExecutionPort
} from "agent-platform";
import {
  repositoryInspectionTopologyCandidate,
  type PlannedToolExecutionContext,
  type RegisteredEffectTool,
  type RepositoryRecoverySelectionStore,
  type RepositoryWorktreeTopology
} from "agent-tools";
import {
  brokerOperations,
  PendingRepositoryTransactions,
  requireRepositoryTransactionBroker,
  requireTransactionHandle,
  transactionEffects,
  type PendingRepositoryTransaction,
  type RepositoryTransactionPort
} from "./repository-transaction-broker.js";
import {
  completedRepositoryReceipt,
  pendingRepositoryReceipt
} from "./repository-transaction-evidence.js";
import {
  assertRecoverySelectionPlan,
  recoveryOperation
} from "./repository-transaction-recovery.js";
import {
  gitOperationArgs,
  gitOperationSchema,
  gitTransactionInput,
  mutatesWorktree,
  type GitOperation,
  type GitTransactionInput
} from "./repository-transaction-schema.js";
import {
  collectRepositoryEvidenceState,
  repositoryConflictPaths
} from "./repository-transaction-state.js";

export interface RepositoryTransactionLimits {
  maxFiles?: number;
  maxBytes?: number;
  recoverySelections?: RepositoryRecoverySelectionStore;
}
export type RepositoryCheckpointLimits = RepositoryTransactionLimits;

async function repositoryTopologyFor(
  workspace: string,
  requested: string,
  signal: AbortSignal
): Promise<RepositoryWorktreeTopology> {
  signal.throwIfAborted();
  const root = await canonicalWorkspacePath(workspace, requested);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw Object.assign(new Error("Repository root must be a stable directory."), {
      code: "workspace_not_git_root"
    });
  }
  return await repositoryInspectionTopologyCandidate({
    workspacePath: root,
    signal
  });
}

function transactionPlan(
  operations: readonly GitOperation[],
  topology: RepositoryWorktreeTopology,
  repository: string
): ToolCallPlan {
  const effects = transactionEffects(operations, topology);
  return {
    exactEffects: effects,
    readPaths: [repository],
    writePaths: operations.some(mutatesWorktree) ? [repository] : [],
    network: "none",
    processMode: "none",
    checkpointScope: [],
    mutationAuthority: "broker_repository_transaction_v2",
    idempotence: "non_replayable"
  };
}

function inputSchema(): Record<string, JsonValue> {
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: ["begin", "continue", "abort", "recover"] },
      repository: {
        type: "string",
        description: "Workspace-relative repository root; defaults to '.'."
      },
      operations: { type: "array", minItems: 1, maxItems: 64, items: gitOperationSchema },
      transactionHandle: { type: "string", minLength: 16, maxLength: 200 },
      candidateId: { type: "string", pattern: "^[a-f0-9]{64}$" },
      selectionEvidenceId: { type: "string", minLength: 1, maxLength: 512 }
    },
    additionalProperties: false
  };
}

function pendingForInput(
  pending: PendingRepositoryTransactions,
  input: GitTransactionInput,
  context: Pick<PlannedToolExecutionContext, "sessionId" | "runId">
): PendingRepositoryTransaction {
  if (!input.transactionHandle) {
    throw Object.assign(new Error("Repository transaction handle is required."), {
      code: "repository_transaction_handle_invalid"
    });
  }
  return pending.resolve(input.transactionHandle, context.sessionId, context.runId);
}

async function conflictReceiptOrRestore(
  execution: RepositoryTransactionPort,
  request: { callId: string },
  context: PlannedToolExecutionContext,
  transaction: PendingRepositoryTransaction,
  result: Awaited<ReturnType<RepositoryTransactionPort["beginRepositoryTransaction"]>>,
  pending: PendingRepositoryTransactions,
  startedAt: string
): Promise<ToolReceipt> {
  try {
    const conflictPaths = await repositoryConflictPaths(
      execution, transaction.topology, context.signal
    );
    return pendingRepositoryReceipt(
      request.callId, transaction, result, conflictPaths, startedAt
    );
  } catch (probeError) {
    try {
      const restored = await execution.abortRepositoryTransaction({
        protocolVersion: 2,
        transactionHandle: transaction.handle,
        sessionId: transaction.sessionId,
        runId: transaction.runId
      }, { signal: context.signal });
      if (restored.status !== "aborted" || restored.rollbackState !== "restored") {
        throw new Error("Broker did not confirm repository restoration.", { cause: probeError });
      }
      pending.consume(transaction.handle);
    } catch (rollbackError) {
      throw Object.assign(new AggregateError(
        [probeError, rollbackError],
        "Repository conflict inspection failed and broker rollback was not confirmed."
      ), { code: "repository_state_uncertain" });
    }
    throw probeError;
  }
}

async function beginTransaction(
  execution: RepositoryTransactionPort,
  request: { callId: string },
  context: PlannedToolExecutionContext,
  input: GitTransactionInput,
  limits: RepositoryTransactionLimits,
  pending: PendingRepositoryTransactions,
  startedAt: string
): Promise<ToolReceipt> {
  const topology = await repositoryTopologyFor(
    context.workspacePath, input.repository, context.signal
  );
  let operations = input.operations;
  let recoverySelection: PendingRepositoryTransaction["recoverySelection"];
  let expectedPostconditions;
  if (input.action === "recover") {
    const recovery = await recoveryOperation(
      execution, context, input, topology, limits.recoverySelections
    );
    operations = [recovery.operation];
    recoverySelection = recovery.binding;
    if (recovery.binding.integrationMode === "exact_head") {
      expectedPostconditions = {
        schemaVersion: 3 as const,
        selectedHead: recovery.binding.selectedObject,
        selectedSymbolicRef: recovery.binding.selectedSymbolicRef,
        requiredReachableObjects: [recovery.binding.selectedObject]
      };
    }
  }
  operations.forEach(gitOperationArgs);
  const before = await collectRepositoryEvidenceState(execution, topology, context.signal);
  const lease = await execution.acquireRepositoryTransactionLease({
    protocolVersion: 2,
    sessionId: context.sessionId,
    runId: context.runId,
    repositoryRoot: topology.worktreeRoot,
    gitDir: topology.gitDir,
    commonDir: topology.commonDir,
    executable: "git",
    network: "none",
    ...(limits.maxFiles === undefined ? {} : { maxSnapshotFiles: limits.maxFiles }),
    ...(limits.maxBytes === undefined ? {} : { maxSnapshotBytes: limits.maxBytes })
  }, { signal: context.signal });
  const result = await execution.beginRepositoryTransaction({
    protocolVersion: expectedPostconditions ? 3 : 2,
    leaseId: lease.leaseId,
    operations: brokerOperations(operations),
    ...(expectedPostconditions ? { expectedPostconditions } : {})
  }, { signal: context.signal });
  const transaction: PendingRepositoryTransaction = {
    handle: requireTransactionHandle(result),
    sessionId: context.sessionId,
    runId: context.runId,
    topology,
    before,
    operations,
    ...(recoverySelection ? { recoverySelection } : {})
  };
  if (result.status === "conflicts_pending") {
    pending.record(transaction);
    return await conflictReceiptOrRestore(
      execution, request, context, transaction, result, pending, startedAt
    );
  }
  try {
    return await completedRepositoryReceipt(
      execution, request, context, transaction, result, startedAt
    );
  } finally {
    pending.consume(transaction.handle);
  }
}

async function continueTransaction(
  execution: RepositoryTransactionPort,
  request: { callId: string },
  context: PlannedToolExecutionContext,
  input: GitTransactionInput,
  pending: PendingRepositoryTransactions,
  startedAt: string
): Promise<ToolReceipt> {
  const transaction = pendingForInput(pending, input, context);
  const result = await execution.continueRepositoryTransaction({
    protocolVersion: 2,
    transactionHandle: transaction.handle,
    sessionId: context.sessionId,
    runId: context.runId,
    operations: brokerOperations(input.operations)
  }, { signal: context.signal });
  if (result.status === "conflicts_pending") {
    return await conflictReceiptOrRestore(
      execution, request, context, transaction, result, pending, startedAt
    );
  }
  try {
    return await completedRepositoryReceipt(
      execution, request, context, transaction, result, startedAt
    );
  } finally {
    pending.consume(transaction.handle);
  }
}

async function abortTransaction(
  execution: RepositoryTransactionPort,
  request: { callId: string },
  context: PlannedToolExecutionContext,
  input: GitTransactionInput,
  pending: PendingRepositoryTransactions,
  startedAt: string
): Promise<ToolReceipt> {
  const transaction = pendingForInput(pending, input, context);
  const result = await execution.abortRepositoryTransaction({
    protocolVersion: 2,
    transactionHandle: transaction.handle,
    sessionId: context.sessionId,
    runId: context.runId
  }, { signal: context.signal });
  pending.consume(transaction.handle);
  const effects = transactionEffects(transaction.operations, transaction.topology);
  return {
    callId: request.callId,
    ok: result.status === "aborted" && result.rollbackState === "restored",
    output: JSON.stringify({
      status: result.status,
      rollbackState: result.rollbackState,
      gitAbortSucceeded: result.gitAbortSucceeded ?? false
    }),
    result: {
      status: result.status,
      rollbackState: result.rollbackState ?? null,
      gitAbortSucceeded: result.gitAbortSucceeded ?? false
    },
    observedEffects: effects,
    actualEffects: effects,
    artifacts: [],
    diagnostics: result.rollbackState === "restored" ? ["repository_restored"] : [],
    evidence: [],
    startedAt,
    completedAt: new Date().toISOString()
  };
}

export async function recoverInterruptedRepositoryTransactions(
  execution: ProcessExecutionPort | undefined,
  sessionId: string,
  runId?: string
): Promise<void> {
  if (!execution?.recoverRepositoryTransactions) return;
  const result = await execution.recoverRepositoryTransactions({
    protocolVersion: 2,
    sessionId,
    ...(runId ? { runId } : {})
  }, { timeoutMs: 120_000 });
  if (result.status !== "recovered") {
    throw Object.assign(new Error("Interrupted repository transactions were not restored."), {
      code: "repository_state_uncertain"
    });
  }
}

export function repositoryTransactionTool(
  execution: ProcessExecutionPort,
  limits: RepositoryTransactionLimits = {}
): RegisteredEffectTool {
  const pending = new PendingRepositoryTransactions();
  return {
    descriptor: {
      name: "git_transaction",
      description: "Execute a broker-journaled local Git transaction. Begin may pause on normal conflicts; continue accepts only explicit add operations; abort restores the broker-held preimage. Recover requires runtime-issued candidate and selection evidence. Shell argv, hooks, external helpers, network protocols, and raw object IDs are denied.",
      inputSchema: inputSchema(),
      possibleEffects: [
        "repository.write", "filesystem.read.external", "filesystem.write", "destructive"
      ],
      maximumEffects: [
        "repository.write", "filesystem.read.external", "filesystem.write", "destructive"
      ],
      brokerMutationAuthority: "repository_transaction_v2",
      availableModes: ["change"],
      executionMode: "exclusive",
      resourceKeys: ["workspace:write", "repository:git"],
      approval: "prompt",
      idempotent: false,
      timeoutMs: 600_000,
      async prepare(argumentsValue, context): Promise<ToolCallPlan> {
        const input = gitTransactionInput(argumentsValue);
        if (input.action === "continue" || input.action === "abort") {
          const transaction = pendingForInput(pending, input, context);
          input.operations.forEach(gitOperationArgs);
          return transactionPlan(transaction.operations, transaction.topology, ".");
        }
        const signal = AbortSignal.timeout(10_000);
        const topology = await repositoryTopologyFor(
          context.workspacePath, input.repository, signal
        );
        if (input.action === "recover") {
          assertRecoverySelectionPlan(
            input, context, topology.worktreeRoot, limits.recoverySelections
          );
          return transactionPlan(
            [{ op: "reset", mode: "hard", target: "runtime-authorized-candidate" }],
            topology,
            input.repository
          );
        }
        input.operations.forEach(gitOperationArgs);
        return transactionPlan(input.operations, topology, input.repository);
      }
    },
    async execute(request, context) {
      requireRepositoryTransactionBroker(execution);
      const startedAt = new Date().toISOString();
      const input = gitTransactionInput(request.arguments);
      if (input.action === "continue") {
        return await continueTransaction(execution, request, context, input, pending, startedAt);
      }
      if (input.action === "abort") {
        return await abortTransaction(execution, request, context, input, pending, startedAt);
      }
      return await beginTransaction(
        execution, request, context, input, limits, pending, startedAt
      );
    }
  };
}
