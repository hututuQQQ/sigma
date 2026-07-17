import type { EvidenceRecord, ReviewEvidence, ValidationEvidence, WorkspaceDeltaEvidence } from "agent-protocol";
import type { RuntimeSession } from "./types.js";
import { CHECKPOINT_INTEGRITY_VALIDATOR } from "./validation-policy.js";

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
  latestFailed?: ValidationEvidence;
  ready: boolean;
}

export function frontierValidationReadiness(session: RuntimeSession): FrontierValidationReadiness {
  const changed = session.durable.state.mutationFrontier.changedPaths;
  const validations = sessionMutationEvidence(session).filter((item) => isCurrentValidation(session, item));
  const latestByPath = new Map<string, ValidationEvidence>();
  for (const validation of validations) {
    for (const path of validation.data.coveredPaths) {
      if (changed.includes(path)) latestByPath.set(path, validation);
    }
  }
  const coveredPaths = changed.filter((path) => latestByPath.get(path)?.status === "passed");
  const missingPaths = changed.filter((path) => latestByPath.get(path)?.status !== "passed");
  const latestFailed = [...validations].reverse().find((item) => item.status === "failed"
    && item.data.coveredPaths.some((path) => changed.includes(path)));
  return {
    validations,
    coveredPaths,
    missingPaths,
    ...(latestFailed ? { latestFailed } : {}),
    ready: missingPaths.length === 0
  };
}

export function currentFrontierReview(session: RuntimeSession): ReviewEvidence | undefined {
  const frontier = session.durable.state.mutationFrontier;
  return sessionMutationEvidence(session).filter((item): item is ReviewEvidence => item.kind === "review"
    && item.data.frontierRevision === frontier.revision
    && item.data.stateDigest === frontier.currentStateDigest).at(-1);
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
