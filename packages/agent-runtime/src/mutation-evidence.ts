import { createHash } from "node:crypto";
import type { EvidenceRecord, ReviewEvidence, ValidationEvidence, WorkspaceDeltaEvidence } from "agent-protocol";
import type { RuntimeSession } from "./types.js";
import { CHECKPOINT_INTEGRITY_VALIDATOR } from "./validation-policy.js";
import {
  assurancePathsForClaim, assuranceRequirement, validationClaimSatisfies
} from "./assurance-engine.js";

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
    && item.data.validator !== CHECKPOINT_INTEGRITY_VALIDATOR
    && item.data.frontierRevision === frontier.revision
    && item.data.stateDigest === frontier.currentStateDigest;
}

export interface FrontierValidationReadiness {
  validations: ValidationEvidence[];
  coveredPaths: string[];
  missingPaths: string[];
  missingClaims: string[];
  latestFailed?: ValidationEvidence;
  ready: boolean;
}

export function frontierValidationReadiness(session: RuntimeSession): FrontierValidationReadiness {
  const changed = session.durable.state.mutationFrontier.changedPaths;
  const validations = sessionMutationEvidence(session).filter((item) => isCurrentValidation(session, item));
  const requirement = assuranceRequirement(session);
  const passed = validations.filter((item) => item.status === "passed");
  const missingClaims = requirement.requiredClaims.filter((required) => {
    const requiredPaths = assurancePathsForClaim(changed, required);
    return requiredPaths.length > 0 && !requiredPaths.every((changedPath) => passed.some((validation) =>
      validationClaimSatisfies(validation.data.claim?.kind, required)
        && validation.data.coveredPaths.includes(changedPath)));
  });
  const coveredPaths = changed.filter((changedPath) => requirement.requiredClaims.every((required) => {
    if (!assurancePathsForClaim([changedPath], required).includes(changedPath)) return true;
    return passed.some((validation) => validationClaimSatisfies(validation.data.claim?.kind, required)
      && validation.data.coveredPaths.includes(changedPath));
  }));
  const missingPaths = changed.filter((path) => !coveredPaths.includes(path));
  const latestFailed = [...validations].reverse().find((item) => item.status === "failed"
    && requirement.requiredClaims.some((required) =>
      validationClaimSatisfies(item.data.claim?.kind, required)));
  return {
    validations,
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
  return sessionMutationEvidence(session).filter((item): item is WorkspaceDeltaEvidence =>
    item.kind === "workspace_delta" && item.status === "passed"
    && [...item.data.delta.added, ...item.data.delta.modified, ...item.data.delta.deleted]
      .some((path) => changed.has(path)));
}
