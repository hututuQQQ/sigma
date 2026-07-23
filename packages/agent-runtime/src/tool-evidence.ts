import { randomUUID } from "node:crypto";
import type {
  CommandEvidence,
  DiagnosticEvidence,
  EvidenceRecord,
  InputAccessEvidence,
  MutationFrontier,
  RepositoryAcceptanceEvidenceV1,
  RepositoryRecoveryDecisionEvidenceV1,
  RepositoryRecoverySelectionEvidenceV1,
  RepositoryDeltaEvidence,
  ToolCallPlan,
  ToolReceipt,
  ValidationEvidence,
  WorkspaceDeltaEvidence
} from "agent-protocol";
import { frontierAfterEvidence } from "agent-kernel";

export interface ReceiptEvidenceScope {
  sessionId: string;
  runId: string;
  workspaceDeltas: WorkspaceDeltaEvidence[];
  validationScope?: {
    frontierRevision: number;
    stateDigest: string;
    coveredPaths: string[];
    claim?: Omit<import("agent-protocol").ValidationClaimV1, "status">;
  };
  repositoryScope?: {
    goalEpoch: number;
    frontier: MutationFrontier;
    mutationEvidence: EvidenceRecord[];
  };
}

export function effectsOutsidePlan(receipt: ToolReceipt, plan: ToolCallPlan): string[] {
  const allowed = new Set(plan.exactEffects);
  return [...new Set(receipt.actualEffects ?? receipt.observedEffects)].filter((effect) => !allowed.has(effect));
}

export function assertToolReceiptIdentity(receipt: ToolReceipt, expectedCallId: string): void {
  if (receipt.callId === expectedCallId) return;
  throw Object.assign(new Error(
    `Tool receipt callId '${receipt.callId}' does not match requested callId '${expectedCallId}'.`
  ), { code: "tool_receipt_identity_mismatch" });
}

function evidenceBase(scope: ReceiptEvidenceScope, receipt: ToolReceipt): Pick<
  EvidenceRecord,
  "evidenceId" | "sessionId" | "runId" | "createdAt" | "producer"
> {
  return {
    evidenceId: randomUUID(),
    sessionId: scope.sessionId,
    runId: scope.runId,
    createdAt: receipt.completedAt || new Date().toISOString(),
    producer: { authority: "tool", id: receipt.callId }
  };
}

function sanitizeValidation(
  raw: ValidationEvidence,
  receipt: ToolReceipt,
  scope: ReceiptEvidenceScope
): ValidationEvidence {
  const frontier = scope.validationScope;
  if (!frontier) throw Object.assign(new Error("Validation evidence is missing its frozen mutation frontier."), {
    code: "validation_frontier_missing"
  });
  return {
    ...evidenceBase(scope, receipt),
    kind: "validation",
    status: receipt.ok && raw.status === "passed" ? "passed" : "failed",
    summary: raw.summary,
    data: {
      validator: raw.data.validator,
      ...(raw.data.command ? { command: raw.data.command } : {}),
      ...(raw.data.exitCode === undefined ? {} : { exitCode: raw.data.exitCode }),
      ...(raw.data.termination ? { termination: { ...raw.data.termination } } : {}),
      artifactIds: [...new Set(receipt.artifacts)],
      frontierRevision: frontier.frontierRevision,
      stateDigest: frontier.stateDigest,
      coveredPaths: [...frontier.coveredPaths],
      ...(frontier.claim ? {
        claim: {
          ...frontier.claim,
          subject: { ...frontier.claim.subject },
          status: raw.data.termination?.processStarted === false
            ? "unavailable" as const
            : receipt.ok && raw.status === "passed" ? "passed" as const : "failed" as const
        }
      } : {})
    }
  };
}

function sanitizeCommand(raw: CommandEvidence, receipt: ToolReceipt, scope: ReceiptEvidenceScope): CommandEvidence {
  return {
    ...evidenceBase(scope, receipt),
    kind: "command",
    status: receipt.ok && raw.status === "passed" ? "passed" : "failed",
    summary: raw.summary,
    data: {
      command: raw.data.command,
      exitCode: raw.data.exitCode,
      ...(raw.data.signal ? { signal: raw.data.signal } : {}),
      artifactIds: [...new Set(receipt.artifacts)],
      ...(raw.data.stdoutArtifactId && receipt.artifacts.includes(raw.data.stdoutArtifactId)
        ? { stdoutArtifactId: raw.data.stdoutArtifactId } : {}),
      ...(raw.data.stderrArtifactId && receipt.artifacts.includes(raw.data.stderrArtifactId)
        ? { stderrArtifactId: raw.data.stderrArtifactId } : {})
    }
  };
}

function sanitizeDiagnostic(raw: DiagnosticEvidence, receipt: ToolReceipt, scope: ReceiptEvidenceScope): DiagnosticEvidence {
  return {
    ...evidenceBase(scope, receipt),
    kind: "diagnostic",
    status: receipt.ok ? raw.status : "failed",
    summary: raw.summary,
    data: { source: raw.data.source, diagnostic: raw.data.diagnostic }
  };
}

function sanitizeInputAccess(
  raw: InputAccessEvidence,
  receipt: ToolReceipt,
  scope: ReceiptEvidenceScope
): InputAccessEvidence {
  return {
    ...evidenceBase(scope, receipt),
    kind: "input_access",
    status: receipt.ok && raw.status === "passed" ? "passed" : "failed",
    summary: raw.summary,
    data: {
      path: raw.data.path,
      scope: raw.data.scope,
      ...(raw.data.sha256 ? { sha256: raw.data.sha256 } : {}),
      ...(raw.data.byteLength === undefined ? {} : { byteLength: raw.data.byteLength }),
      ...(raw.data.failureCode ? { failureCode: raw.data.failureCode } : {})
    }
  };
}

function sanitizeRepositoryDelta(
  raw: RepositoryDeltaEvidence,
  receipt: ToolReceipt,
  scope: ReceiptEvidenceScope
): RepositoryDeltaEvidence {
  return {
    ...evidenceBase(scope, receipt),
    kind: "repository_delta",
    status: receipt.ok && raw.status === "passed" ? "passed" : "failed",
    summary: raw.summary,
    data: {
      ...raw.data,
      operations: [...raw.data.operations],
      ...(receipt.workspaceDelta ? { worktreeDelta: {
        added: [...receipt.workspaceDelta.added],
        modified: [...receipt.workspaceDelta.modified],
        deleted: [...receipt.workspaceDelta.deleted]
      } } : raw.data.worktreeDelta ? { worktreeDelta: {
        added: [...raw.data.worktreeDelta.added],
        modified: [...raw.data.worktreeDelta.modified],
        deleted: [...raw.data.worktreeDelta.deleted]
      } } : {})
    }
  };
}

function repositoryAcceptance(
  delta: RepositoryDeltaEvidence,
  receipt: ToolReceipt,
  scope: ReceiptEvidenceScope
): RepositoryAcceptanceEvidenceV1 | undefined {
  const repository = scope.repositoryScope;
  const assertions = delta.data.semanticAssertions;
  const target = assertions?.targetAssertions;
  if (!repository || !assertions || !target || target.satisfied !== true
    || !delta.data.transactionHandle || !delta.data.selectionEvidenceId
    || !delta.data.candidateId || !delta.data.selectedObject
    || target.selectedHead !== delta.data.selectedObject
    || !target.requiredReachableObjects.includes(delta.data.selectedObject)) {
    return undefined;
  }
  const frontier = frontierAfterEvidence(
    repository.frontier,
    [...repository.mutationEvidence, delta],
    delta
  );
  return {
    evidenceId: randomUUID(),
    sessionId: scope.sessionId,
    runId: scope.runId,
    kind: "repository_acceptance",
    status: "passed",
    createdAt: receipt.completedAt || new Date().toISOString(),
    producer: { authority: "runtime", id: receipt.callId },
    summary: "The runtime accepted broker-asserted repository recovery postconditions.",
    data: {
      schemaVersion: 1,
      goalEpoch: repository.goalEpoch,
      frontierRevision: frontier.revision,
      frontierStateDigest: frontier.currentStateDigest,
      repositoryRoot: delta.data.repositoryRoot ?? ".",
      transactionHandle: delta.data.transactionHandle,
      operationClasses: [...delta.data.operations],
      repositoryStateDigest: delta.data.afterStateDigest,
      selectionEvidenceId: delta.data.selectionEvidenceId,
      candidateId: delta.data.candidateId,
      semanticAssertions: assertions
    }
  };
}

function sanitizeRepositorySelection(
  raw: RepositoryRecoverySelectionEvidenceV1,
  receipt: ToolReceipt,
  scope: ReceiptEvidenceScope
): RepositoryRecoverySelectionEvidenceV1 | undefined {
  if (scope.repositoryScope?.goalEpoch !== raw.data.goalEpoch) return undefined;
  return {
    ...raw,
    ...evidenceBase(scope, receipt),
    // This identifier is also the opaque key into the in-memory recovery
    // capability store. Replacing it would sever a legitimate selection from
    // that store. Retaining it cannot mint recovery authority: resolution
    // still requires a live record plus matching session, run, goal,
    // repository, and candidate bindings.
    evidenceId: raw.evidenceId,
    producer: { authority: "runtime", id: receipt.callId },
    data: { ...raw.data }
  };
}

function sanitizeRepositoryDecision(
  raw: RepositoryRecoveryDecisionEvidenceV1,
  receipt: ToolReceipt,
  scope: ReceiptEvidenceScope
): RepositoryRecoveryDecisionEvidenceV1 | undefined {
  if (scope.repositoryScope?.goalEpoch !== raw.data.goalEpoch) return undefined;
  return {
    ...raw,
    ...evidenceBase(scope, receipt),
    producer: { authority: "runtime", id: receipt.callId },
    data: {
      ...raw.data,
      candidates: raw.data.candidates.map((candidate) => ({ ...candidate, subjectTrusted: false }))
    }
  };
}

function synthesizedDiagnostic(
  receipt: ToolReceipt,
  toolName: string,
  scope: ReceiptEvidenceScope,
  actualEffects: ToolReceipt["observedEffects"]
): DiagnosticEvidence {
  return {
    ...evidenceBase(scope, receipt),
    kind: "diagnostic",
    status: receipt.ok ? "informational" : "failed",
    summary: `${toolName} ${receipt.ok ? "completed" : "failed"}.`,
    data: { source: toolName, diagnostic: {
      callId: receipt.callId,
      effects: actualEffects,
      diagnostics: [...receipt.diagnostics]
    } }
  };
}

function normalizeRepositoryInspectionEvidence(
  raw: EvidenceRecord,
  receipt: ToolReceipt,
  toolName: string,
  scope: ReceiptEvidenceScope,
  actualEffects: ToolReceipt["observedEffects"]
): EvidenceRecord[] | undefined {
  if (toolName !== "repository_inspect" || !receipt.ok
    || !actualEffects.includes("filesystem.read")) return undefined;
  if (raw.kind === "repository_recovery_selection") {
    const selection = sanitizeRepositorySelection(raw, receipt, scope);
    return selection ? [selection] : [];
  }
  if (raw.kind === "repository_recovery_decision") {
    const decision = sanitizeRepositoryDecision(raw, receipt, scope);
    return decision ? [decision] : [];
  }
  return undefined;
}

function normalizeEvidenceRecord(
  raw: EvidenceRecord,
  receipt: ToolReceipt,
  toolName: string,
  plan: ToolCallPlan,
  scope: ReceiptEvidenceScope,
  actualEffects: ToolReceipt["observedEffects"]
): EvidenceRecord[] {
  if (raw.kind === "validation") {
    return plan.exactEffects.includes("validation") && actualEffects.includes("validation")
      ? [sanitizeValidation(raw, receipt, scope)] : [];
  }
  if (raw.kind === "repository_delta") {
    if (!plan.exactEffects.includes("repository.write")
      || !actualEffects.includes("repository.write")) return [];
    const delta = sanitizeRepositoryDelta(raw, receipt, scope);
    const acceptance = repositoryAcceptance(delta, receipt, scope);
    return [delta, ...(acceptance ? [acceptance] : [])];
  }
  if (raw.kind === "command") {
    return actualEffects.some((effect) =>
      effect === "process.spawn" || effect === "process.spawn.readonly")
      ? [sanitizeCommand(raw, receipt, scope)] : [];
  }
  if (raw.kind === "diagnostic") return [sanitizeDiagnostic(raw, receipt, scope)];
  if (raw.kind === "input_access") {
    return actualEffects.includes("filesystem.read")
      ? [sanitizeInputAccess(raw, receipt, scope)] : [];
  }
  return normalizeRepositoryInspectionEvidence(
    raw, receipt, toolName, scope, actualEffects
  ) ?? [];
}

/**
 * Tool-returned evidence is untrusted data. Re-issue only kinds justified by
 * the approved/observed effects, stamp the active run, and discard privileged
 * review, waiver, checkpoint, child, and workspace-delta claims. Workspace
 * deltas are emitted only by the checkpoint manager after sealing.
 */
export function normalizeReceiptEvidence(
  receipt: ToolReceipt,
  toolName: string,
  plan: ToolCallPlan,
  scope: ReceiptEvidenceScope
): ToolReceipt {
  const actualEffects = [...new Set(receipt.actualEffects ?? receipt.observedEffects)];
  const evidence = (receipt.evidence ?? []).flatMap((raw) =>
    normalizeEvidenceRecord(raw, receipt, toolName, plan, scope, actualEffects));
  return {
    ...receipt,
    actualEffects,
    evidence: evidence.length > 0 ? evidence : [synthesizedDiagnostic(receipt, toolName, scope, actualEffects)]
  };
}
