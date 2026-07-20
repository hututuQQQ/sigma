import type {
  RepositoryDeltaEvidence,
  ValidationEvidence,
  WorkspaceDeltaEvidence
} from "agent-protocol";
import { reviewValidationRequiredPaths } from "./assurance-engine.js";
import {
  frontierValidationReadiness,
  reviewRelevantValidations,
  sessionMutationEvidence,
  unresolvedWorkspaceDeltas
} from "./mutation-evidence.js";
import { reviewerWaivedDeltaIds } from "./review-waiver-policy.js";
import type { RuntimeSession } from "./types.js";

export interface ReviewSubjectReadiness {
  pending: WorkspaceDeltaEvidence[];
  eligible: WorkspaceDeltaEvidence[];
  validations: ValidationEvidence[];
  repositoryDeltas: RepositoryDeltaEvidence[];
  relevantValidations: ValidationEvidence[];
  validationRequiredPaths: string[];
}

export function profileReviewMode(session: RuntimeSession): "off" | "advisory" | "required" {
  return session.services.profile?.profile.mutationPolicy.reviewMode ?? "advisory";
}

export function reviewSubjectReadiness(session: RuntimeSession): ReviewSubjectReadiness {
  const validation = frontierValidationReadiness(session);
  const relevantValidations = reviewRelevantValidations(session, validation.validations);
  const validationRequiredPaths = reviewValidationRequiredPaths(session);
  const unresolved = unresolvedWorkspaceDeltas(session);
  const waived = reviewerWaivedDeltaIds(sessionMutationEvidence(session));
  const pending = profileReviewMode(session) === "required"
    ? unresolved
    : unresolved.filter((item) => !waived.has(item.evidenceId));
  const validationReady = validationRequiredPaths.every((path) =>
    validation.coveredPaths.includes(path));
  return {
    pending,
    eligible: validationReady ? pending : [],
    validations: validation.validations,
    repositoryDeltas: validation.repositoryAcceptances,
    relevantValidations,
    validationRequiredPaths
  };
}

export function hasReviewSubject(
  workspaceDeltas: readonly WorkspaceDeltaEvidence[],
  repositoryDeltas: readonly RepositoryDeltaEvidence[]
): boolean {
  return workspaceDeltas.length > 0 || repositoryDeltas.length > 0;
}

/** This is the single predicate used by both solver reservation and reviewer
 * execution. It deliberately includes an empty required-path set (ordinary
 * reviewable text) and applies advisory waivers before deciding. */
export function candidateReviewEligible(session: RuntimeSession): boolean {
  if (profileReviewMode(session) === "off") return false;
  const readiness = reviewSubjectReadiness(session);
  return hasReviewSubject(readiness.eligible, readiness.repositoryDeltas);
}
