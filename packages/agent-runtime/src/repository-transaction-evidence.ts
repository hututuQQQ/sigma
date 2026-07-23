import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type {
  RepositoryDeltaEvidence,
  JsonValue,
  ToolReceipt
} from "agent-protocol";
import type { PlannedToolExecutionContext } from "agent-tools";
import type {
  PendingRepositoryTransaction,
  RepositoryTransactionPort
} from "./repository-transaction-broker.js";
import {
  requireCompletedAssertions,
  transactionEffects
} from "./repository-transaction-broker.js";
import {
  collectRepositoryEvidenceState,
  repositoryObjectIsAncestor,
  repositoryRevisionDelta
} from "./repository-transaction-state.js";
import type { RepositoryTransactionResultV2 } from "agent-execution";

function assertionDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

type CompletedAssertions = ReturnType<typeof requireCompletedAssertions>;
type RepositoryEvidenceState = Awaited<ReturnType<typeof collectRepositoryEvidenceState>>;
type RecoverySelection = NonNullable<PendingRepositoryTransaction["recoverySelection"]>;

function recoveryPostconditionFailed(): Error {
  return Object.assign(new Error(
    "Repository recovery did not preserve the current history and integrate the runtime-authorized target."
  ), { code: "repository_postcondition_failed" });
}

function exactRecoverySatisfied(
  assertions: CompletedAssertions,
  recovery: RecoverySelection
): boolean {
  return recovery.integrationMode === "exact_head"
    && assertions.targetAssertions?.satisfied === true
    && assertions.targetAssertions.selectedHead === recovery.selectedObject
    && assertions.head === recovery.selectedObject
    && assertions.targetAssertions.requiredReachableObjects.includes(recovery.selectedObject);
}

async function mergedRecoverySatisfied(
  execution: RepositoryTransactionPort,
  context: PlannedToolExecutionContext,
  transaction: PendingRepositoryTransaction,
  after: RepositoryEvidenceState,
  recovery: RecoverySelection
): Promise<boolean> {
  if (recovery.integrationMode !== "merge" || !after.head) return false;
  const selectedObjectPreserved = await repositoryObjectIsAncestor(
    execution, transaction.topology, recovery.selectedObject, after.head, context.signal
  );
  if (!selectedObjectPreserved || !transaction.before.head) return selectedObjectPreserved;
  return await repositoryObjectIsAncestor(
    execution, transaction.topology, transaction.before.head, after.head, context.signal
  );
}

async function assertRecoveryState(
  execution: RepositoryTransactionPort,
  context: PlannedToolExecutionContext,
  transaction: PendingRepositoryTransaction,
  after: RepositoryEvidenceState,
  assertions: CompletedAssertions
): Promise<CompletedAssertions> {
  const recovery = transaction.recoverySelection;
  if (!recovery) return assertions;
  if (assertions.symbolicRef !== recovery.selectedSymbolicRef) {
    throw recoveryPostconditionFailed();
  }
  if (exactRecoverySatisfied(assertions, recovery)) return assertions;
  if (!await mergedRecoverySatisfied(execution, context, transaction, after, recovery)) {
    throw recoveryPostconditionFailed();
  }
  // A merge cannot declare the selected object as the final HEAD before Git
  // creates the merge commit, so the broker has no exact target assertion to
  // return. The runtime has now independently established that both the
  // selected object and the pre-transaction HEAD are ancestors of the leased
  // post-transaction HEAD. Preserve that verified recovery target in the same
  // assertion shape used by exact recovery so evidence normalization can issue
  // repository acceptance without trusting model- or tool-authored claims.
  return {
    ...assertions,
    targetAssertions: {
      schemaVersion: 3,
      selectedHead: recovery.selectedObject,
      selectedSymbolicRef: recovery.selectedSymbolicRef,
      requiredReachableObjects: [...new Set([
        recovery.selectedObject,
        ...(transaction.before.head ? [transaction.before.head] : [])
      ])],
      satisfied: true
    }
  };
}

async function assertRuntimeAndBrokerState(
  execution: RepositoryTransactionPort,
  context: PlannedToolExecutionContext,
  transaction: PendingRepositoryTransaction,
  after: RepositoryEvidenceState,
  result: RepositoryTransactionResultV2
): Promise<CompletedAssertions> {
  const assertions = requireCompletedAssertions(result);
  if (after.head !== assertions.head
    || after.refsDigest !== assertions.refsDigest
    || after.reachabilityDigest !== assertions.reachabilityDigest
    || after.reachableObjects !== assertions.reachableObjectCount) {
    throw Object.assign(new Error(
      "Broker and independently leased repository observations disagree."
    ), { code: "repository_postcondition_failed" });
  }
  return await assertRecoveryState(execution, context, transaction, after, assertions);
}

async function abortAfterFailure(
  execution: RepositoryTransactionPort,
  transaction: PendingRepositoryTransaction,
  cause: unknown
): Promise<never> {
  try {
    await execution.abortRepositoryTransaction({
      protocolVersion: 2,
      transactionHandle: transaction.handle,
      sessionId: transaction.sessionId,
      runId: transaction.runId
    }, { timeoutMs: 120_000 });
  } catch (rollbackError) {
    throw Object.assign(new AggregateError(
      [cause, rollbackError],
      "Repository postcondition failed and broker rollback was not confirmed."
    ), { code: "repository_state_uncertain" });
  }
  throw cause;
}

function repositoryDeltaEvidence(
  request: { callId: string },
  context: PlannedToolExecutionContext,
  transaction: PendingRepositoryTransaction,
  assertions: ReturnType<typeof requireCompletedAssertions>,
  after: Awaited<ReturnType<typeof collectRepositoryEvidenceState>>,
  revisionDelta: Awaited<ReturnType<typeof repositoryRevisionDelta>>
): RepositoryDeltaEvidence {
  return {
    evidenceId: randomUUID(), sessionId: context.sessionId, runId: context.runId,
    kind: "repository_delta", status: "passed", createdAt: new Date().toISOString(),
    producer: { authority: "tool", id: request.callId },
    summary: `Applied ${transaction.operations.length} broker-journaled Git operation(s).`,
    data: {
      repositoryRoot: path.relative(
        context.workspacePath, transaction.topology.worktreeRoot
      ).replaceAll("\\", "/") || ".",
      operationCount: transaction.operations.length,
      operations: transaction.operations.map((operation) => operation.op),
      beforeStateDigest: transaction.before.stateDigest,
      afterStateDigest: assertionDigest(assertions),
      headBefore: transaction.before.head, headAfter: after.head,
      refsBeforeDigest: transaction.before.refsDigest, refsAfterDigest: after.refsDigest,
      indexBeforeDigest: transaction.before.indexDigest, indexAfterDigest: after.indexDigest,
      reachableObjectsBefore: transaction.before.reachableObjects,
      reachableObjectsAfter: after.reachableObjects,
      worktreeDelta: {
        added: revisionDelta.added,
        modified: revisionDelta.modified,
        deleted: revisionDelta.deleted
      },
      ...(revisionDelta.reviewDiff ? { reviewDiff: revisionDelta.reviewDiff } : {}),
      reviewDiffPaths: revisionDelta.reviewDiffPaths,
      semanticAssertions: assertions,
      transactionHandle: transaction.handle,
      ...(transaction.recoverySelection ? {
        selectionEvidenceId: transaction.recoverySelection.selectionEvidenceId,
        candidateId: transaction.recoverySelection.candidateId,
        selectedObject: transaction.recoverySelection.selectedObject
      } : {})
    }
  };
}

export async function completedRepositoryReceipt(
  execution: RepositoryTransactionPort,
  request: { callId: string },
  context: PlannedToolExecutionContext,
  transaction: PendingRepositoryTransaction,
  result: RepositoryTransactionResultV2,
  startedAt: string
): Promise<ToolReceipt> {
  try {
    const after = await collectRepositoryEvidenceState(
      execution, transaction.topology, context.signal
    );
    const assertions = await assertRuntimeAndBrokerState(
      execution, context, transaction, after, result
    );
    const revisionDelta = await repositoryRevisionDelta(
      execution, transaction.topology, transaction.before.head, after.head, context.signal
    );
    const evidence = repositoryDeltaEvidence(
      request, context, transaction, assertions, after, revisionDelta
    );
    await execution.sealRepositoryTransaction({
      protocolVersion: 2,
      transactionHandle: transaction.handle,
      sessionId: transaction.sessionId,
      runId: transaction.runId
    }, { signal: context.signal });
    const effects = transactionEffects(transaction.operations, transaction.topology);
    return {
      callId: request.callId,
      ok: true,
      output: result.output ?? "",
      result: {
        status: "completed",
        transactionHandle: transaction.handle,
        semanticAssertions: assertions
      } as unknown as JsonValue,
      observedEffects: effects,
      actualEffects: effects,
      artifacts: [],
      diagnostics: [],
      evidence: [evidence],
      startedAt,
      completedAt: new Date().toISOString()
    };
  } catch (error) {
    return await abortAfterFailure(execution, transaction, error);
  }
}

export function pendingRepositoryReceipt(
  callId: string,
  transaction: PendingRepositoryTransaction,
  result: RepositoryTransactionResultV2,
  conflictPaths: string[],
  startedAt: string
): ToolReceipt {
  const effects = transactionEffects(transaction.operations, transaction.topology);
  return {
    callId,
    ok: true,
    output: JSON.stringify({
      status: "conflicts_pending",
      transactionHandle: transaction.handle,
      operation: result.operation ?? null,
      conflictCount: result.conflictCount ?? 0,
      conflictPaths,
      nextActions: ["resolve conflicts", "git_transaction continue", "git_transaction abort"]
    }),
    result: {
      status: "conflicts_pending",
      transactionHandle: transaction.handle,
      operation: result.operation ?? null,
      conflictCount: result.conflictCount ?? 0,
      conflictPaths
    },
    observedEffects: effects,
    actualEffects: effects,
    artifacts: [],
    diagnostics: ["conflicts_pending"],
    evidence: [],
    startedAt,
    completedAt: new Date().toISOString()
  };
}
