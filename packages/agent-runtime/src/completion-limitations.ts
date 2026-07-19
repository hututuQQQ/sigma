import {
  passedValidationSupportsClaim,
  type CompletionLimitationV1,
  type ValidationClaimKindV1,
  type ValidationEvidence
} from "agent-protocol";
import {
  projectCapabilitiesForPath,
  repositoryValidationCapabilityCoversPath,
  type RepositoryValidationCapabilityProfile
} from "agent-context";
import {
  assurancePathsForClaim,
  assuranceRequirement,
  validationRequirementForInstruction,
  validationClaimSatisfies
} from "./assurance-engine.js";
import {
  currentFrontierReview,
  frontierValidationReadiness,
  latestFrontierReview,
  unresolvedWorkspaceDeltas,
  type FrontierValidationReadiness
} from "./mutation-evidence.js";
import type { RuntimeSession } from "./types.js";

export function reviewMode(session: RuntimeSession): "off" | "advisory" | "required" {
  return session.services.profile?.profile.mutationPolicy.reviewMode ?? "advisory";
}

export function reviewSatisfied(session: RuntimeSession): boolean {
  const requirement = assuranceRequirement(session);
  const reviewRequired = reviewMode(session) === "required" || requirement.review === "required";
  const review = currentFrontierReview(session);
  const approved = review?.status === "passed" && review.data.verdict === "approved";
  if (reviewRequired) return approved;
  // Advisory means that an absent review is not a prerequisite. Once review
  // work has started, however, a stale basis or actionable correctness verdict
  // cannot be silently converted into ordinary completion. Infrastructure
  // findings remain advisory and are preserved in the completion message.
  const latest = latestFrontierReview(session);
  if (latest && !review) return false;
  return review?.data.failureKind !== undefined
    || review === undefined
    || approved;
}

function currentCapabilityProfile(session: RuntimeSession): RepositoryValidationCapabilityProfile | null {
  const profile = session.interaction.validationCapabilities;
  return profile?.complete === true
    && profile.availableCommandsComplete === true
    && profile.stateDigest === session.durable.state.mutationFrontier.currentStateDigest
    ? profile : null;
}

function profileProvesUnavailable(
  profile: RepositoryValidationCapabilityProfile,
  claim: ValidationClaimKindV1,
  paths: readonly string[]
): boolean {
  if (paths.length === 0 || claim === "probe" || claim === "lint") return false;
  return paths.every((changedPath) => {
    if (!repositoryValidationCapabilityCoversPath(changedPath)) return false;
    const project = projectCapabilitiesForPath(profile, changedPath);
    if (!project) return false;
    if (claim === "unit" || claim === "integration") return !project.unit;
    if (claim === "acceptance") {
      return !project.unit
        && project.staticClaims.length === 0
        && project.commandFamilies.length === 0;
    }
    return !project.staticClaims.includes(claim);
  });
}

function completeWorkspaceDelta(session: RuntimeSession): boolean {
  const frontier = session.durable.state.mutationFrontier;
  if (frontier.changedPaths.length === 0 || session.durable.state.checkpointHead?.status !== "sealed") return false;
  const deltas = unresolvedWorkspaceDeltas(session);
  const paths = new Set(deltas.flatMap((item) => [
    ...item.data.delta.added,
    ...item.data.delta.modified,
    ...item.data.delta.deleted
  ]));
  const checkpoints = new Set(deltas.map((item) => item.data.checkpointId));
  return frontier.changedPaths.every((item) => paths.has(item))
    && frontier.sourceCheckpointIds.every((item) => checkpoints.has(item));
}

function unavailableValidation(item: ValidationEvidence): boolean {
  const termination = item.data.termination;
  const failureCode = termination?.failureCode;
  return item.status === "failed"
    && item.data.validator === "command"
    && item.data.claim?.status === "unavailable"
    && termination?.processStarted === false
    && termination.cancelled === false
    && termination.timedOut === false
    && termination.idleTimedOut === false
    && typeof failureCode === "string"
    && /^(?:executable_not_found|executable_unavailable|shell_unavailable|runtime_unavailable|toolchain_unavailable)$/u.test(failureCode)
    && typeof item.data.command === "string"
    && item.data.command.trim().length > 0;
}

function limitationReason(
  evidence: ValidationEvidence,
  claim: ValidationClaimKindV1,
  paths: readonly string[]
): string {
  const failureCode = evidence.data.termination?.failureCode ?? "validation_capability_unavailable";
  return `Required ${claim} validation could not start (${failureCode}); the complete capability snapshot exposes no applicable ${claim} capability for: ${paths.join(", ")}.`;
}

function actualRequiredValidationFailed(
  readiness: FrontierValidationReadiness,
  requiredClaims: readonly ValidationClaimKindV1[]
): boolean {
  return readiness.validations.some((item) => item.data.claim?.status === "failed"
    && requiredClaims.some((required) => validationClaimSatisfies(item.data.claim?.kind, required)));
}

function missingPathsForClaim(
  session: RuntimeSession,
  readiness: FrontierValidationReadiness,
  required: ValidationClaimKindV1
): string[] {
  const requiredPaths = assurancePathsForClaim(
    session.durable.state.mutationFrontier.changedPaths,
    required,
    session
  );
  return requiredPaths.filter((changedPath) => !readiness.validations.some((item) =>
    passedValidationSupportsClaim(item)
    && validationClaimSatisfies(item.data.claim?.kind, required)
    && item.data.coveredPaths.includes(changedPath)));
}

function limitationsForClaim(
  session: RuntimeSession,
  profile: RepositoryValidationCapabilityProfile,
  readiness: FrontierValidationReadiness,
  unavailable: readonly ValidationEvidence[],
  required: ValidationClaimKindV1
): CompletionLimitationV1[] | null {
  const missing = missingPathsForClaim(session, readiness, required);
  if (missing.length === 0) return [];
  if (!profileProvesUnavailable(profile, required, missing)) return null;
  const uncovered = new Set(missing);
  const selected: Array<{ evidence: ValidationEvidence; paths: string[] }> = [];
  for (const evidence of [...unavailable].reverse()) {
    if (!validationClaimSatisfies(evidence.data.claim?.kind, required)) continue;
    const covered = missing.filter((item) => uncovered.has(item) && evidence.data.coveredPaths.includes(item));
    if (covered.length === 0) continue;
    selected.push({ evidence, paths: covered });
    for (const item of covered) uncovered.delete(item);
    if (uncovered.size === 0) break;
  }
  if (uncovered.size > 0) return null;
  return selected.map(({ evidence, paths }) => ({
    kind: "validation_capability_unavailable",
    claim: required,
    attemptedCommandSummary: evidence.data.command!.replace(/\s+/gu, " ").trim().slice(0, 512),
    capabilityEvidenceId: evidence.evidenceId,
    reason: limitationReason(evidence, required, paths)
  }));
}

function usesTrustedDefaultValidation(session: RuntimeSession): boolean {
  const configuredProfile = session.services.profile;
  return session.durable.state.validationRequirement === "default"
    && configuredProfile?.profile.id === "standard"
    && session.services.profileSource === "builtin"
    && validationRequirementForInstruction(
      session.durable.state.plan.goal,
      configuredProfile.profile.id
    ) === "default";
}

/** Returns a typed, evidence-backed downgrade only for a trusted control-plane
 * `default` validation classification under the built-in standard profile.
 * Missing or `required` classifications fail closed; unavailable validation
 * remains failed evidence and never satisfies assurance. */
export function completionLimitations(session: RuntimeSession): CompletionLimitationV1[] | null {
  if (!usesTrustedDefaultValidation(session)) return null;
  const frontier = session.durable.state.mutationFrontier;
  const requirement = assuranceRequirement(session);
  if (frontier.changedPaths.length === 0 || requirement.risk === "high") return null;
  if (!reviewSatisfied(session) || !completeWorkspaceDelta(session)) return null;
  const profile = currentCapabilityProfile(session);
  if (!profile) return null;
  const readiness = frontierValidationReadiness(session);
  if (readiness.ready || actualRequiredValidationFailed(readiness, requirement.requiredClaims)) return null;
  const unavailable = readiness.validations.filter(unavailableValidation);
  const limitations: CompletionLimitationV1[] = [];
  for (const required of requirement.requiredClaims) {
    const selected = limitationsForClaim(session, profile, readiness, unavailable, required);
    if (!selected) return null;
    limitations.push(...selected);
  }
  return limitations.length > 0 ? limitations : null;
}
