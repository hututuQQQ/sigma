import type { ValidationEvidence, WorkspaceDeltaEvidence } from "agent-protocol";

export const CHECKPOINT_INTEGRITY_VALIDATOR = "checkpoint_postimage_integrity";

function deltaPaths(delta: WorkspaceDeltaEvidence): string[] {
  return [...delta.data.delta.added, ...delta.data.delta.modified, ...delta.data.delta.deleted];
}

/** Compatibility helper for reviewer inputs. V5 authority is assurance/path
 * based; this answers only whether the validation passed and overlaps the
 * delta's human-readable paths. */
export function validationCoversDelta(validation: ValidationEvidence, delta: WorkspaceDeltaEvidence): boolean {
  return validation.status === "passed"
    && validation.data.validator !== CHECKPOINT_INTEGRITY_VALIDATOR
    && deltaPaths(delta).some((path) => validation.data.coveredPaths.includes(path));
}

export function validationExecutionCoversDelta(
  validation: ValidationEvidence,
  delta: WorkspaceDeltaEvidence
): boolean {
  return validation.data.validator !== CHECKPOINT_INTEGRITY_VALIDATOR
    && deltaPaths(delta).some((path) => validation.data.coveredPaths.includes(path));
}

export function latestValidationExecutionForDelta(
  validations: readonly ValidationEvidence[],
  delta: WorkspaceDeltaEvidence
): ValidationEvidence | undefined {
  return validations.filter((validation) => validationExecutionCoversDelta(validation, delta)).at(-1);
}
