import { createHash } from "node:crypto";
import type {
  EvidenceRecord,
  RepositoryAcceptanceEvidenceV1,
  ReviewEvidence,
  ValidationEvidence,
  WorkspaceDeltaEvidence
} from "agent-protocol";
import type { RuntimeSession } from "./types.js";
import { CHECKPOINT_INTEGRITY_VALIDATOR } from "./validation-policy.js";
import {
  assurancePathsForClaim, assuranceRequirement, validationClaimSatisfies
} from "./assurance-engine.js";

const MUTATION_KINDS = new Set([
  "workspace_delta", "repository_delta", "repository_acceptance",
  "validation", "review", "user_waiver"
]);

export function sessionMutationEvidence(session: RuntimeSession): EvidenceRecord[] {
  const byId = new Map<string, EvidenceRecord>();
  for (const item of session.durable.state.mutationEvidence) {
    if (item.sessionId === session.identity.sessionId) byId.set(item.evidenceId, item);
  }
  for (const item of session.durable.state.evidence) {
    if (item.sessionId === session.identity.sessionId && MUTATION_KINDS.has(item.kind)) byId.set(item.evidenceId, item);
  }
  return [...byId.values()];
}

function isCurrentValidation(session: RuntimeSession, item: EvidenceRecord): item is ValidationEvidence {
  const frontier = session.durable.state.mutationFrontier;
  return item.kind === "validation"
    && item.data.validator !== CHECKPOINT_INTEGRITY_VALIDATOR
    && item.data.frontierRevision === frontier.revision
    && item.data.stateDigest === frontier.currentStateDigest;
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
): RepositoryAcceptanceEvidenceV1 | undefined {
  const frontier = session.durable.state.mutationFrontier;
  const goalEpoch = session.durable.state.taskControl.goalEpoch;
  return sessionMutationEvidence(session).filter((item): item is RepositoryAcceptanceEvidenceV1 =>
    item.kind === "repository_acceptance"
    && item.status === "passed"
    && item.data.goalEpoch === goalEpoch
    && item.data.frontierRevision === frontier.revision
    && item.data.frontierStateDigest === frontier.currentStateDigest
    && item.data.repositoryStateDigest === frontier.repositoryStateDigest).at(-1);
}

export function frontierValidationReadiness(session: RuntimeSession): FrontierValidationReadiness {
  const changed = session.durable.state.mutationFrontier.changedPaths;
  const validations = sessionMutationEvidence(session).filter((item) => isCurrentValidation(session, item));
  const requirement = assuranceRequirement(session);
  const passed = validations.filter((item) => item.status === "passed");
  const executed = validations.filter(isExecutedValidation);
  const acceptance = currentRepositoryAcceptance(session);
  const acceptedPaths = new Set(acceptance ? sessionMutationEvidence(session).flatMap((item) =>
    item.kind === "repository_delta"
      && item.data.transactionHandle === acceptance.data.transactionHandle
      ? [".git", ...(item.data.reviewDiffPaths ?? [])] : []) : []);
  const missingClaims = requirement.requiredClaims.filter((required) => {
    const requiredPaths = assurancePathsForClaim(changed, required)
      .filter((changedPath) => !acceptedPaths.has(changedPath));
    return requiredPaths.length > 0 && !requiredPaths.every((changedPath) => passed.some((validation) =>
      validationClaimSatisfies(validation.data.claim?.kind, required)
        && validation.data.coveredPaths.includes(changedPath)));
  });
  const coveredPaths = changed.filter((changedPath) => acceptedPaths.has(changedPath)
    || requirement.requiredClaims.every((required) => {
    if (!assurancePathsForClaim([changedPath], required).includes(changedPath)) return true;
    return passed.some((validation) => validationClaimSatisfies(validation.data.claim?.kind, required)
      && validation.data.coveredPaths.includes(changedPath));
    }));
  const missingPaths = changed.filter((path) => !coveredPaths.includes(path));
  const missingExecutionClaims = requirement.requiredClaims.filter((required) => {
    const requiredPaths = assurancePathsForClaim(changed, required)
      .filter((changedPath) => !acceptedPaths.has(changedPath));
    return requiredPaths.length > 0 && !requiredPaths.every((changedPath) => executed.some((validation) =>
      validationClaimSatisfies(validation.data.claim?.kind, required)
        && validation.data.coveredPaths.includes(changedPath)));
  });
  const executedPaths = changed.filter((changedPath) => acceptedPaths.has(changedPath)
    || requirement.requiredClaims.every((required) => {
      if (!assurancePathsForClaim([changedPath], required).includes(changedPath)) return true;
      return executed.some((validation) => validationClaimSatisfies(validation.data.claim?.kind, required)
        && validation.data.coveredPaths.includes(changedPath));
    }));
  const missingExecutionPaths = changed.filter((path) => !executedPaths.includes(path));
  const latestFailed = [...validations].reverse().find((item) => item.status === "failed"
    && requirement.requiredClaims.some((required) =>
      validationClaimSatisfies(item.data.claim?.kind, required)));
  return {
    validations,
    coveredPaths,
    missingPaths,
    missingClaims,
    executedPaths,
    missingExecutionPaths,
    missingExecutionClaims,
    executionReady: missingExecutionPaths.length === 0 && missingExecutionClaims.length === 0,
    ...(latestFailed ? { latestFailed } : {}),
    ready: missingPaths.length === 0 && missingClaims.length === 0
  };
}

function validationSemanticSignature(validation: ValidationEvidence): string {
  return JSON.stringify({
    status: validation.status,
    validator: validation.data.validator,
    command: validation.data.command ?? null,
    exitCode: validation.data.exitCode ?? null,
    termination: validation.data.termination ?? null,
    coveredPaths: [...new Set(validation.data.coveredPaths)].sort(),
    claim: validation.data.claim ?? null,
    frontierRevision: validation.data.frontierRevision,
    stateDigest: validation.data.stateDigest
  });
}

export function reviewBasisDigest(
  session: RuntimeSession,
  validations = frontierValidationReadiness(session).validations,
  completionCandidateDigest?: string
): string {
  const frontier = session.durable.state.mutationFrontier;
  const signatures = [...new Set(validations.map(validationSemanticSignature))].sort();
  return createHash("sha256").update(JSON.stringify({
    frontierRevision: frontier.revision,
    stateDigest: frontier.currentStateDigest,
    validations: signatures,
    ...(completionCandidateDigest ? { completionCandidateDigest } : {})
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
  completionCandidateDigest?: string
): ReviewEvidence | undefined {
  const basisDigest = reviewBasisDigest(session, undefined, completionCandidateDigest);
  return sessionMutationEvidence(session).filter((item): item is ReviewEvidence => item.kind === "review"
    && item.data.frontierRevision === session.durable.state.mutationFrontier.revision
    && item.data.stateDigest === session.durable.state.mutationFrontier.currentStateDigest
    && item.data.reviewBasisDigest === basisDigest).at(-1);
}

/** Compatibility projection for reviewer diff material. Only deltas that
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
