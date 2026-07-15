import {
  evidenceSupportsClaim,
  type ValidationEvidence,
  type WorkspaceDeltaEvidence
} from "agent-protocol";
import { documentationOnly } from "./reviewer.js";

export const CHECKPOINT_INTEGRITY_VALIDATOR = "checkpoint_postimage_integrity";

/** Checkpoint integrity proves a durable postimage, not that changed code works.
 * It is sufficient for documentation-only deltas; other changes need an
 * independent linked validator such as a build, test, lint, or diagnostic. */
function validationTargetsDelta(
  validation: ValidationEvidence,
  delta: WorkspaceDeltaEvidence
): boolean {
  if (!validation.data.workspaceDeltaEvidenceIds.includes(delta.evidenceId)) return false;
  return documentationOnly(delta) || validation.data.validator !== CHECKPOINT_INTEGRITY_VALIDATOR;
}

/** A passed validator proves the validation_passed obligation for a delta. */
export function validationCoversDelta(
  validation: ValidationEvidence,
  delta: WorkspaceDeltaEvidence
): boolean {
  return evidenceSupportsClaim(validation, "validation_passed")
    && validationTargetsDelta(validation, delta);
}

/** An exited validator proves only that validation ran for a delta. This is
 * deliberately distinct from validationCoversDelta so a failed execution can
 * be reviewed and reported without ever becoming passed evidence. */
export function validationExecutionCoversDelta(
  validation: ValidationEvidence,
  delta: WorkspaceDeltaEvidence
): boolean {
  return evidenceSupportsClaim(validation, "validation_executed")
    && validationTargetsDelta(validation, delta);
}

/** Select the authoritative terminal validation result for a delta. Ledger
 * order is durable execution order, so a later failed check cannot be hidden
 * behind an earlier pass. */
export function latestValidationExecutionForDelta(
  validations: readonly ValidationEvidence[],
  delta: WorkspaceDeltaEvidence
): ValidationEvidence | undefined {
  return validations.filter((validation) => validationExecutionCoversDelta(validation, delta)).at(-1);
}
