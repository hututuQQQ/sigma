import type { ValidationEvidence, WorkspaceDeltaEvidence } from "agent-protocol";

export const CHECKPOINT_INTEGRITY_VALIDATOR = "checkpoint_postimage_integrity";

/**
 * Return whether a validation record carries task-level assurance rather than
 * merely proving an internal runtime invariant.
 *
 * Checkpoint postimage evidence is deliberately represented as validation so
 * recovery can audit content-addressed snapshots. It must not, however, count
 * as evidence that the user's acceptance conditions were exercised. Requiring
 * an executable command/termination, an explicit claim, or covered task paths
 * also keeps future metadata-only runtime checks from accidentally resetting
 * long-horizon stagnation state.
 */
export function isTaskValidationEvidence(validation: ValidationEvidence): boolean {
  if (validation.data.validator === CHECKPOINT_INTEGRITY_VALIDATOR) return false;
  return validation.data.coveredPaths.length > 0
    || validation.data.claim !== undefined
    || Boolean(validation.data.command?.trim())
    || validation.data.termination?.processStarted === true;
}

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
