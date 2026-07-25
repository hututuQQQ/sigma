import { createHash } from "node:crypto";
import type {
  DiagnosticEvidence,
  EvidenceRecord,
  RepositoryAcceptanceEvidence,
  ReviewEvidence,
  ValidationEvidence,
  WorkspaceDeltaEvidence
} from "agent-protocol";
import { isEnclosingContainerMutationEvidence } from "agent-kernel";
import type { RuntimeSession } from "./types.js";
import { CHECKPOINT_INTEGRITY_VALIDATOR } from "./validation-policy.js";

const MUTATION_KINDS = new Set([
  "workspace_delta", "repository_delta", "repository_acceptance",
  "validation", "review", "user_waiver"
]);
export function isBackgroundProcessSettlementEvidence(
  item: EvidenceRecord
): item is DiagnosticEvidence {
  if (item.kind !== "diagnostic"
    || item.data.source !== "background_process_settlement") return false;
  const diagnostic = item.data.diagnostic;
  return Boolean(diagnostic
    && typeof diagnostic === "object"
    && !Array.isArray(diagnostic)
    && (diagnostic as Record<string, unknown>).schemaVersion === 1
    && typeof (diagnostic as Record<string, unknown>).processId === "string");
}
export function sessionMutationEvidence(session: RuntimeSession): EvidenceRecord[] {
  const byId = new Map<string, EvidenceRecord>();
  for (const item of session.durable.state.mutationEvidence) {
    if (item.sessionId === session.identity.sessionId) byId.set(item.evidenceId, item);
  }
  for (const item of session.durable.state.evidence) {
    if (item.sessionId === session.identity.sessionId
      && (MUTATION_KINDS.has(item.kind)
        || isEnclosingContainerMutationEvidence(item)
        || isBackgroundProcessSettlementEvidence(item))) {
      byId.set(item.evidenceId, item);
    }
  }
  return [...byId.values()];
}

export function sessionEnvironmentMutationEvidence(
  session: RuntimeSession
): DiagnosticEvidence[] {
  return sessionMutationEvidence(session).filter(
    (item): item is DiagnosticEvidence =>
      item.kind === "diagnostic" && isEnclosingContainerMutationEvidence(item)
  );
}

export function sessionProcessSettlementEvidence(
  session: RuntimeSession
): DiagnosticEvidence[] {
  return sessionMutationEvidence(session).filter(isBackgroundProcessSettlementEvidence);
}

function isCurrentValidation(session: RuntimeSession, item: EvidenceRecord): item is ValidationEvidence {
  const frontier = session.durable.state.mutationFrontier;
  return item.kind === "validation"
    && item.data.validator !== CHECKPOINT_INTEGRITY_VALIDATOR
    && item.data.frontierRevision === frontier.revision
    && item.data.stateDigest === frontier.currentStateDigest;
}

export interface CurrentFrontierValidationStatus {
  validations: ValidationEvidence[];
  latestPassed?: ValidationEvidence;
  latestFailed?: ValidationEvidence;
  hasRecord: boolean;
  passed: boolean;
}

/**
 * Completion authority is deliberately structural: a validation record must
 * be bound to the exact current frontier, and Strict requires one such record
 * to have passed. Command-name and claim classification remain available for
 * telemetry and model context, but do not decide whether completion is valid.
 */
export function currentFrontierValidationStatus(
  session: RuntimeSession
): CurrentFrontierValidationStatus {
  const validations = sessionMutationEvidence(session).filter((item) =>
    isCurrentValidation(session, item));
  const latestPassed = [...validations].reverse().find((item) => item.status === "passed");
  const latestFailed = [...validations].reverse().find((item) => item.status === "failed");
  return {
    validations,
    ...(latestPassed ? { latestPassed } : {}),
    ...(latestFailed ? { latestFailed } : {}),
    hasRecord: validations.length > 0,
    passed: Boolean(latestPassed)
  };
}

export interface FrontierValidationReadiness {
  validations: ValidationEvidence[];
  coveredPaths: string[];
  missingPaths: string[];
  missingClaims: string[];
  executedPaths: string[];
  missingExecutionPaths: string[];
  missingExecutionClaims: string[];
  executionReady: boolean;
  latestFailed?: ValidationEvidence;
  ready: boolean;
}

function isExecutedValidation(item: ValidationEvidence): boolean {
  if (item.status === "passed") return true;
  return item.status === "failed"
    && item.data.termination?.processStarted === true
    && item.data.termination.state === "exited";
}

export function currentRepositoryAcceptance(
  session: RuntimeSession
): RepositoryAcceptanceEvidence | undefined {
  const frontier = session.durable.state.mutationFrontier;
  return sessionMutationEvidence(session).filter((item): item is RepositoryAcceptanceEvidence =>
    item.kind === "repository_acceptance"
    && item.status === "passed"
    && item.data.frontierRevision === frontier.revision
    && item.data.frontierStateDigest === frontier.currentStateDigest
    && item.data.repositoryStateDigest === frontier.repositoryStateDigest).at(-1);
}

export function frontierValidationReadiness(session: RuntimeSession): FrontierValidationReadiness {
  const changed = session.durable.state.mutationFrontier.changedPaths;
  const validations = sessionMutationEvidence(session).filter((item) => isCurrentValidation(session, item));
  const passed = validations.filter((item) => item.status === "passed");
  const executed = validations.filter(isExecutedValidation);
  const acceptance = currentRepositoryAcceptance(session);
  const acceptedPaths = new Set(acceptance ? sessionMutationEvidence(session).flatMap((item) =>
    item.kind === "repository_delta"
      && item.data.transactionHandle === acceptance.data.transactionHandle
      ? [".git", ...(item.data.reviewDiffPaths ?? [])] : []) : []);
  const declaredPassedPaths = new Set(passed.flatMap((item) => item.data.coveredPaths));
  const declaredExecutedPaths = new Set(executed.flatMap((item) => item.data.coveredPaths));
  const coveredPaths = changed.filter((changedPath) => acceptedPaths.has(changedPath)
    || declaredPassedPaths.has(changedPath));
  const missingPaths = changed.filter((path) => !coveredPaths.includes(path));
  const executedPaths = changed.filter((changedPath) => acceptedPaths.has(changedPath)
    || declaredExecutedPaths.has(changedPath));
  const missingExecutionPaths = changed.filter((path) => !executedPaths.includes(path));
  const latestFailed = [...validations].reverse().find((item) => item.status === "failed");
  return {
    validations,
    coveredPaths,
    missingPaths,
    // Runtime records declared subjects but deliberately does not infer which
    // semantic claim the task requires. The independent reviewer owns that
    // judgment.
    missingClaims: [],
    executedPaths,
    missingExecutionPaths,
    missingExecutionClaims: [],
    executionReady: executed.length > 0,
    ...(latestFailed ? { latestFailed } : {}),
    ready: passed.length > 0
  };
}

function validationSemanticSignature(validation: ValidationEvidence): string {
  return JSON.stringify({
    status: validation.status,
    validator: validation.data.validator,
    command: validation.data.command ?? null,
    exitCode: validation.data.exitCode ?? null,
    termination: validation.data.termination ?? null,
    ...(validation.data.output
      ? { output: {
          sha256: validation.data.output.sha256,
          byteLength: validation.data.output.byteLength,
          truncated: validation.data.output.truncated
        } }
      : {}),
    coveredPaths: [...new Set(validation.data.coveredPaths)].sort(),
    intent: validation.data.intent ?? null,
    adapterInference: validation.data.adapterInference ?? null,
    claim: validation.data.claim ?? null,
    frontierRevision: validation.data.frontierRevision,
    stateDigest: validation.data.stateDigest
  });
}

function receiptSemanticSignature(
  receipt: RuntimeSession["durable"]["state"]["receipts"][number]
): string {
  const outputDigest = createHash("sha256")
    .update(receipt.output)
    .digest("hex");
  const resultDigest = createHash("sha256")
    .update(JSON.stringify(receipt.result ?? null))
    .digest("hex");
  return JSON.stringify({
    callId: receipt.callId,
    ok: receipt.ok,
    outputDigest,
    resultDigest,
    outcome: receipt.outcome,
    observedEffects: receipt.observedEffects,
    actualEffects: receipt.actualEffects ?? [],
    workspaceDelta: receipt.workspaceDelta ?? null,
    artifacts: receipt.artifacts,
    artifactRefs: receipt.artifactRefs ?? [],
    diagnostics: receipt.diagnostics,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt
  });
}

export function reviewBasisDigest(
  session: RuntimeSession,
  validations = currentFrontierValidationStatus(session).validations,
  _completionCandidateDigest?: string
): string {
  const frontier = session.durable.state.mutationFrontier;
  const signatures = [...new Set(validations.map(validationSemanticSignature))].sort();
  const processSettlements = sessionProcessSettlementEvidence(session)
    .map((item) => JSON.stringify({
      evidenceId: item.evidenceId,
      status: item.status,
      diagnostic: item.data.diagnostic
    }))
    .sort();
  const receipts = session.durable.state.receipts
    .filter((receipt) => {
      const effects = new Set(receipt.actualEffects ?? receipt.observedEffects);
      return effects.has("filesystem.read")
        || effects.has("process.handoff")
        || [...effects].some((effect) =>
          effect === "process.spawn" || effect.startsWith("process.spawn."))
        || effects.has("validation");
    })
    .map(receiptSemanticSignature);
  return createHash("sha256").update(JSON.stringify({
    frontierRevision: frontier.revision,
    stateDigest: frontier.currentStateDigest,
    plan: {
      goal: session.durable.state.plan.goal,
      activeNodeId: session.durable.state.plan.activeNodeId ?? null,
      nodes: session.durable.state.plan.nodes.map((node) => ({
        id: node.id,
        title: node.title,
        status: node.status,
        acceptanceCriteria: node.acceptanceCriteria,
        blockedReason: node.blockedReason ?? null
      }))
    },
    validations: signatures,
    ...(processSettlements.length > 0 ? { processSettlements } : {}),
    receipts
  })).digest("hex");
}

export function latestFrontierReview(session: RuntimeSession): ReviewEvidence | undefined {
  const frontier = session.durable.state.mutationFrontier;
  return sessionMutationEvidence(session).filter((item): item is ReviewEvidence => item.kind === "review"
    && item.data.frontierRevision === frontier.revision
    && item.data.stateDigest === frontier.currentStateDigest).at(-1);
}

export function currentFrontierReview(
  session: RuntimeSession,
  _completionCandidateDigest?: string
): ReviewEvidence | undefined {
  const basisDigest = reviewBasisDigest(session);
  return sessionMutationEvidence(session).filter((item): item is ReviewEvidence => item.kind === "review"
    && item.data.frontierRevision === session.durable.state.mutationFrontier.revision
    && item.data.stateDigest === session.durable.state.mutationFrontier.currentStateDigest
    && item.data.reviewBasisDigest === basisDigest).at(-1);
}

function durableEvidenceIds(session: RuntimeSession): Set<string> {
  return new Set([
    ...session.durable.state.evidence.map((item) => item.evidenceId),
    ...session.durable.state.mutationEvidence.map((item) => item.evidenceId),
    ...session.durable.state.reviewReceipts.flatMap((item) =>
      (item.receipt.evidence ?? []).map((evidence) => evidence.evidenceId))
  ]);
}

function actualCheckIsDurable(
  session: RuntimeSession,
  review: ReviewEvidence,
  check: NonNullable<ReviewEvidence["data"]["actualChecks"]>[number]
): boolean {
  const requestId = review.data.reviewRequestId;
  if (!requestId || check.evidenceIds.length === 0) return false;
  return session.durable.state.reviewReceipts.some((item) =>
    item.reviewRequestId === requestId
    && item.call.name === check.toolName
    && check.evidenceIds.every((evidenceId) =>
      (item.receipt.evidence ?? []).some((evidence) =>
      evidence.evidenceId === evidenceId)));
}

function approvedReview(review: ReviewEvidence | undefined): review is ReviewEvidence {
  return Boolean(review
    && review.status === "passed"
    && review.data.verdict === "approved"
    && review.data.failureKind === undefined
    && review.data.failureCode === undefined);
}

function reviewMatchesCurrentBasis(
  session: RuntimeSession,
  review: ReviewEvidence
): boolean {
  const frontier = session.durable.state.mutationFrontier;
  return review.data.frontierRevision === frontier.revision
    && review.data.stateDigest === frontier.currentStateDigest
    && review.data.reviewBasisDigest === reviewBasisDigest(session);
}

function criterionEvidenceIsAuthentic(
  review: ReviewEvidence,
  known: ReadonlySet<string>
): boolean {
  const criteria = review.data.criteria ?? [];
  return criteria.length > 0 && criteria.every((item) =>
    item.status === "satisfied"
    && item.evidence.length > 0
    && item.evidence.every((id) => known.has(id)));
}

function durableReviewEvidenceIsAuthentic(
  review: ReviewEvidence,
  known: ReadonlySet<string>
): boolean {
  const cited = new Set((review.data.criteria ?? []).flatMap((item) => item.evidence));
  const durable = new Set(review.data.durableEvidenceIds ?? []);
  return [...cited].every((id) => durable.has(id))
    && [...durable].every((id) => known.has(id));
}

/**
 * Validate only objective provenance and freshness. The runtime deliberately
 * does not reinterpret commands, paths, file extensions, or semantic
 * sufficiency; those judgments belong to the independent reviewer.
 */
export function authenticCurrentReviewApproval(
  session: RuntimeSession,
  review: ReviewEvidence | undefined,
  requireReviewerCheck = false
): boolean {
  if (!approvedReview(review) || !reviewMatchesCurrentBasis(session, review)) return false;
  const known = durableEvidenceIds(session);
  if (!criterionEvidenceIsAuthentic(review, known)
    || !durableReviewEvidenceIsAuthentic(review, known)) return false;
  const checks = review.data.actualChecks ?? [];
  if (checks.some((check) => !actualCheckIsDurable(session, review, check))) return false;
  return !requireReviewerCheck || checks.length > 0;
}

/** Reviewer projection for diff material. Only deltas that
 * contribute a path to the current final frontier are returned. */
export function unresolvedWorkspaceDeltas(session: RuntimeSession): WorkspaceDeltaEvidence[] {
  const changed = new Set(session.durable.state.mutationFrontier.changedPaths);
  const evidence = sessionMutationEvidence(session);
  const workspace = evidence.filter((item): item is WorkspaceDeltaEvidence =>
    item.kind === "workspace_delta" && item.status === "passed"
    && [...item.data.delta.added, ...item.data.delta.modified, ...item.data.delta.deleted]
      .some((path) => changed.has(path)));
  const repositories = evidence.flatMap((item): WorkspaceDeltaEvidence[] => {
    if (item.kind !== "repository_delta" || item.status !== "passed") return [];
    const delta = item.data.worktreeDelta ?? { added: [], modified: [".git"], deleted: [] };
    const paths = [...delta.added, ...delta.modified, ...delta.deleted];
    if (!paths.some((changedPath) => changed.has(changedPath))) return [];
    const semanticSummary = JSON.stringify({
      operations: item.data.operations,
      headBefore: item.data.headBefore,
      headAfter: item.data.headAfter,
      semanticAssertions: item.data.semanticAssertions ?? null
    }, null, 2);
    return [{
      evidenceId: `repository-review:${item.evidenceId}`,
      sessionId: item.sessionId,
      runId: item.runId,
      kind: "workspace_delta",
      status: "passed",
      createdAt: item.createdAt,
      producer: { authority: "runtime", id: item.evidenceId },
      summary: "Broker-journaled repository transaction review projection.",
      data: {
        delta,
        checkpointId: item.data.transactionHandle ?? item.evidenceId,
        reviewDiff: item.data.reviewDiff ?? semanticSummary,
        reviewDiffPaths: item.data.reviewDiffPaths ?? paths
      }
    }];
  });
  return [...workspace, ...repositories];
}
