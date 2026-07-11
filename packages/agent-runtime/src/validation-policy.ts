import type { ValidationEvidence, WorkspaceDeltaEvidence } from "agent-protocol";
import { documentationOnly } from "./reviewer.js";

export const CHECKPOINT_INTEGRITY_VALIDATOR = "checkpoint_postimage_integrity";

/** Checkpoint integrity proves a durable postimage, not that changed code works.
 * It is sufficient for documentation-only deltas; other changes need an
 * independent linked validator such as a build, test, lint, or diagnostic. */
export function validationCoversDelta(
  validation: ValidationEvidence,
  delta: WorkspaceDeltaEvidence
): boolean {
  if (!validation.data.workspaceDeltaEvidenceIds.includes(delta.evidenceId)) return false;
  return documentationOnly(delta) || validation.data.validator !== CHECKPOINT_INTEGRITY_VALIDATOR;
}
