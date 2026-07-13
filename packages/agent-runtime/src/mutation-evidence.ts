import type { EvidenceRecord, ValidationEvidence, WorkspaceDeltaEvidence } from "agent-protocol";
import type { RuntimeSession } from "./types.js";
import { validationCoversDelta } from "./validation-policy.js";

const MUTATION_KINDS = new Set(["workspace_delta", "validation", "review", "user_waiver"]);

/** Returns the durable session mutation ledger plus current-run evidence that
 * has not yet passed through the reducer (useful at emitter/test boundaries). */
export function sessionMutationEvidence(session: RuntimeSession): EvidenceRecord[] {
  const byId = new Map<string, EvidenceRecord>();
  for (const item of session.durable.state.mutationEvidence) {
    if (item.sessionId === session.identity.sessionId) byId.set(item.evidenceId, item);
  }
  for (const item of session.durable.state.evidence) {
    if (item.sessionId === session.identity.sessionId && MUTATION_KINDS.has(item.kind)) {
      byId.set(item.evidenceId, item);
    }
  }
  return [...byId.values()];
}

/** Session-wide deltas that still need semantic validation. Follow-up runs
 * must be able to discharge obligations created by an earlier interrupted run. */
export function unresolvedWorkspaceDeltas(session: RuntimeSession): WorkspaceDeltaEvidence[] {
  const evidence = sessionMutationEvidence(session);
  const validations = evidence.filter((item): item is ValidationEvidence =>
    item.kind === "validation" && item.status === "passed");
  return evidence.filter((item): item is WorkspaceDeltaEvidence =>
    item.kind === "workspace_delta" && item.status === "passed")
    .filter((delta) => !validations.some((validation) => validationCoversDelta(validation, delta)));
}
