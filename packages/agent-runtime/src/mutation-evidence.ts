import { createHash } from "node:crypto";
import {
  passedValidationSupportsClaim,
  type EvidenceRecord,
  type RepositoryDeltaEvidence,
  type ReviewEvidence,
  type ValidationEvidence,
  type WorkspaceDeltaEvidence
} from "agent-protocol";
import type { RuntimeSession } from "./types.js";
import { CHECKPOINT_INTEGRITY_VALIDATOR } from "./validation-policy.js";
import {
  assurancePathsForClaim, assuranceRequirement, frontierOpaqueArtifactPaths,
  reviewValidationRequiredPaths,
  validationClaimSatisfies
} from "./assurance-engine.js";
import { reviewObservationProjection } from "./review-observations.js";

const MUTATION_KINDS = new Set(["workspace_delta", "repository_delta", "validation", "review", "user_waiver"]);

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
    && item.runId === session.durable.runId
    && item.data.validator !== CHECKPOINT_INTEGRITY_VALIDATOR
    && item.data.frontierRevision === frontier.revision
    && item.data.stateDigest === frontier.currentStateDigest;
}

export interface FrontierValidationReadiness {
  validations: ValidationEvidence[];
  repositoryAcceptances: RepositoryDeltaEvidence[];
  coveredPaths: string[];
  missingPaths: string[];
  missingClaims: string[];
  latestFailed?: ValidationEvidence;
  ready: boolean;
}

function completeRepositoryPostconditions(item: RepositoryDeltaEvidence): boolean {
  return item.status === "passed"
    && item.data.conflictsBeforeDigest !== undefined
    && item.data.conflictsAfterDigest !== undefined
    && item.data.conflictCountBefore !== undefined
    && item.data.conflictCountAfter !== undefined;
}

/** Return the trusted repository transition chain ending at the current
 * frontier. New structured transactions carry complete conflict semantics;
 * legacy repository evidence stays replayable but cannot satisfy acceptance. */
export function currentRepositoryAcceptances(session: RuntimeSession): RepositoryDeltaEvidence[] {
  const frontierDigest = session.durable.state.mutationFrontier.repositoryStateDigest;
  if (!frontierDigest) return [];
  const candidates = sessionMutationEvidence(session).filter((item): item is RepositoryDeltaEvidence =>
    item.kind === "repository_delta" && completeRepositoryPostconditions(item));
  const chain: RepositoryDeltaEvidence[] = [];
  let expected = frontierDigest;
  for (const item of [...candidates].reverse()) {
    if (item.data.afterStateDigest !== expected) continue;
    chain.unshift(item);
    expected = item.data.beforeStateDigest;
  }
  return chain;
}

function repositoryAcceptanceCovers(
  path: string,
  required: string,
  repositoryAcceptances: readonly RepositoryDeltaEvidence[]
): boolean {
  return normalizedWorkspacePath(path) === ".git"
    && required === "acceptance"
    && repositoryAcceptances.length > 0;
}

export function frontierValidationReadiness(session: RuntimeSession): FrontierValidationReadiness {
  const changed = session.durable.state.mutationFrontier.changedPaths;
  const validations = sessionMutationEvidence(session).filter((item) => isCurrentValidation(session, item));
  const repositoryAcceptances = currentRepositoryAcceptances(session);
  const requirement = assuranceRequirement(session);
  const passed = validations.filter(passedValidationSupportsClaim);
  const missingClaims = requirement.requiredClaims.filter((required) => {
    const requiredPaths = assurancePathsForClaim(changed, required, session);
    return requiredPaths.length > 0 && !requiredPaths.every((changedPath) => passed.some((validation) =>
      validationClaimSatisfies(validation.data.claim?.kind, required)
        && validation.data.coveredPaths.includes(changedPath))
      || repositoryAcceptanceCovers(changedPath, required, repositoryAcceptances));
  });
  const coveredPaths = changed.filter((changedPath) => requirement.requiredClaims.every((required) => {
    if (!assurancePathsForClaim([changedPath], required, session).includes(changedPath)) return true;
    return passed.some((validation) => validationClaimSatisfies(validation.data.claim?.kind, required)
      && validation.data.coveredPaths.includes(changedPath))
      || repositoryAcceptanceCovers(changedPath, required, repositoryAcceptances);
  }));
  const missingPaths = changed.filter((path) => !coveredPaths.includes(path));
  const latestFailed = [...validations].reverse().find((item) => item.status === "failed"
    && item.data.claim?.status !== "unavailable"
    && requirement.requiredClaims.some((required) =>
      validationClaimSatisfies(item.data.claim?.kind, required)));
  return {
    validations,
    repositoryAcceptances,
    coveredPaths,
    missingPaths,
    missingClaims,
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

export function reviewRelevantValidations(
  session: RuntimeSession,
  validations = frontierValidationReadiness(session).validations
): ValidationEvidence[] {
  const requiredPaths = new Set(reviewValidationRequiredPaths(session));
  const opaquePaths = new Set(frontierOpaqueArtifactPaths(session));
  const requiredClaims = assuranceRequirement(session).requiredClaims;
  return validations.filter((validation) => validation.data.coveredPaths.some((path) =>
    requiredPaths.has(path) && (opaquePaths.has(path) || requiredClaims.some((required) =>
      validationClaimSatisfies(validation.data.claim?.kind, required)))));
}

function legacyReviewBasisDigest(
  session: RuntimeSession,
  validations = frontierValidationReadiness(session).validations
): string {
  const frontier = session.durable.state.mutationFrontier;
  const relevant = reviewRelevantValidations(session, validations);
  const signatures = [...new Set(relevant.map(validationSemanticSignature))].sort();
  const observations = reviewObservationProjection(session, validations);
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: 2,
    frontierRevision: frontier.revision,
    stateDigest: frontier.currentStateDigest,
    validations: signatures,
    evidenceTailSha256: observations.contentSha256
  })).digest("hex");
}

/** V3 binds review only to completion-relevant state. Tool protocol receipts,
 * repeated reads, and diagnostic chatter cannot invalidate an approval. */
export function reviewBasisDigest(
  session: RuntimeSession,
  validations = frontierValidationReadiness(session).validations,
  completionCandidateDigest?: string
): string {
  const frontier = session.durable.state.mutationFrontier;
  const relevant = reviewRelevantValidations(session, validations);
  const signatures = [...new Set(relevant.map(validationSemanticSignature))].sort();
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: 3,
    frontierRevision: frontier.revision,
    stateDigest: frontier.currentStateDigest,
    validations: signatures,
    completionCandidateDigest: completionCandidateDigest ?? null
  })).digest("hex");
}

export function latestFrontierReview(session: RuntimeSession): ReviewEvidence | undefined {
  const frontier = session.durable.state.mutationFrontier;
  return sessionMutationEvidence(session).filter((item): item is ReviewEvidence => item.kind === "review"
    && item.runId === session.durable.runId
    && item.data.frontierRevision === frontier.revision
    && item.data.stateDigest === frontier.currentStateDigest).at(-1);
}

export function currentFrontierReview(
  session: RuntimeSession,
  completionCandidateDigest?: string
): ReviewEvidence | undefined {
  const validations = frontierValidationReadiness(session).validations;
  const candidates = sessionMutationEvidence(session).filter((item): item is ReviewEvidence => item.kind === "review"
    && item.runId === session.durable.runId
    && item.data.frontierRevision === session.durable.state.mutationFrontier.revision
    && item.data.stateDigest === session.durable.state.mutationFrontier.currentStateDigest);
  return [...candidates].reverse().find((item) => {
    if (item.data.reviewBasisVersion === 2) {
      return completionCandidateDigest === undefined
        && item.data.reviewBasisDigest === legacyReviewBasisDigest(session, validations);
    }
    if (item.data.reviewBasisVersion !== 3) return false;
    const boundCandidate = item.data.completionCandidateDigest;
    if (completionCandidateDigest !== undefined && boundCandidate !== completionCandidateDigest) return false;
    return item.data.reviewBasisDigest === reviewBasisDigest(session, validations, boundCandidate);
  });
}

/** Return only a workspace-mode review. Completion-bound reviews also cover
 * the workspace for the durable completion boundary, but must not be treated
 * as the result of an explicit request_review workspace request. */
export function currentWorkspaceReview(session: RuntimeSession): ReviewEvidence | undefined {
  const validations = frontierValidationReadiness(session).validations;
  return [...sessionMutationEvidence(session)].reverse().find((item): item is ReviewEvidence => {
    if (item.kind !== "review"
      || item.runId !== session.durable.runId
      || item.data.frontierRevision !== session.durable.state.mutationFrontier.revision
      || item.data.stateDigest !== session.durable.state.mutationFrontier.currentStateDigest
      || item.data.completionCandidateDigest !== undefined) return false;
    if (item.data.reviewBasisVersion === 2) {
      return item.data.reviewBasisDigest === legacyReviewBasisDigest(session, validations);
    }
    return item.data.reviewBasisVersion === 3
      && item.data.reviewBasisDigest === reviewBasisDigest(session, validations);
  });
}

export function latestWorkspaceReview(session: RuntimeSession): ReviewEvidence | undefined {
  const frontier = session.durable.state.mutationFrontier;
  return sessionMutationEvidence(session).filter((item): item is ReviewEvidence => item.kind === "review"
    && item.runId === session.durable.runId
    && item.data.frontierRevision === frontier.revision
    && item.data.stateDigest === frontier.currentStateDigest
    && item.data.completionCandidateDigest === undefined).at(-1);
}

function normalizedWorkspacePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function frontierReviewDiff(
  diff: string | undefined,
  retainedPaths: ReadonlySet<string>
): string | undefined {
  if (diff === undefined) return undefined;
  const section = /^--- (?:a\/([^\r\n]+)|\/dev\/null)\r?\n\+\+\+ (?:b\/([^\r\n]+)|\/dev\/null)\r?\n/gmu;
  const matches = [...diff.matchAll(section)];
  if (matches.length === 0) return diff;
  return matches.flatMap((match, index) => {
    const path = normalizedWorkspacePath(match[2] ?? match[1] ?? "");
    const end = matches[index + 1]?.index ?? diff.length;
    return retainedPaths.has(path) ? [diff.slice(match.index!, end)] : [];
  }).join("");
}

/** Project immutable checkpoint evidence onto the current net frontier. A
 * checkpoint may also contain a temporary path that was reverted later; that
 * historical path is not part of the final change and cannot create a review
 * or validation obligation. Evidence ids remain stable for audit/recovery. */
function finalFrontierDelta(
  item: WorkspaceDeltaEvidence,
  changed: ReadonlySet<string>
): WorkspaceDeltaEvidence | undefined {
  const keep = (paths: readonly string[]): string[] => paths.filter((path) =>
    changed.has(normalizedWorkspacePath(path)));
  const delta = {
    added: keep(item.data.delta.added),
    modified: keep(item.data.delta.modified),
    deleted: keep(item.data.delta.deleted)
  };
  const retained = new Set([...delta.added, ...delta.modified, ...delta.deleted]
    .map(normalizedWorkspacePath));
  if (retained.size === 0) return undefined;
  return {
    ...item,
    data: {
      ...item.data,
      delta,
      ...(item.data.reviewDiff === undefined ? {} : {
        reviewDiff: frontierReviewDiff(item.data.reviewDiff, retained)
      }),
      ...(item.data.reviewDiffPaths === undefined ? {} : {
        reviewDiffPaths: item.data.reviewDiffPaths.filter((path) =>
          retained.has(normalizedWorkspacePath(path)))
      }),
      ...(item.data.opaqueArtifacts === undefined ? {} : {
        opaqueArtifacts: item.data.opaqueArtifacts.filter((artifact) =>
          retained.has(normalizedWorkspacePath(artifact.path)))
      })
    }
  };
}

/** Compatibility projection for reviewer diff material. Only deltas that
 * contribute a path to the current final frontier are returned. */
export function unresolvedWorkspaceDeltas(session: RuntimeSession): WorkspaceDeltaEvidence[] {
  const changed = new Set(session.durable.state.mutationFrontier.changedPaths.map(normalizedWorkspacePath));
  return sessionMutationEvidence(session).flatMap((item) => {
    if (item.kind !== "workspace_delta" || item.status !== "passed") return [];
    const projected = finalFrontierDelta(item, changed);
    return projected ? [projected] : [];
  });
}
