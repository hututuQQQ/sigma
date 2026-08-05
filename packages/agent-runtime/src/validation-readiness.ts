import type { ValidationClaimKind, ValidationEvidence } from "agent-protocol";
import { validationClaimSatisfies } from "./assurance-engine.js";

interface ValidationReadinessInput {
  changedPaths: readonly string[];
  validations: readonly ValidationEvidence[];
  acceptedPaths: ReadonlySet<string>;
  requiredClaims: readonly ValidationClaimKind[];
  repositoryAccepted: boolean;
}

export interface ValidationReadinessTelemetry {
  coveredPaths: string[];
  missingPaths: string[];
  missingClaims: ValidationClaimKind[];
  executedPaths: string[];
  missingExecutionPaths: string[];
  missingExecutionClaims: ValidationClaimKind[];
  executionReady: boolean;
  ready: boolean;
}

function isExecutedValidation(item: ValidationEvidence): boolean {
  if (item.status === "passed") return true;
  return item.status === "failed"
    && item.data.termination?.processStarted === true
    && item.data.termination.state === "exited";
}

function missingClaims(
  required: readonly ValidationClaimKind[],
  validations: readonly ValidationEvidence[],
  repositoryAccepted: boolean
): ValidationClaimKind[] {
  const actual = validations.map((item) =>
    item.data.claim?.kind ?? item.data.adapterInference?.kind);
  if (repositoryAccepted) actual.push("acceptance");
  return required.filter((claim) => !actual.some((kind) =>
    validationClaimSatisfies(kind, claim)));
}

export function validationReadinessTelemetry(
  input: ValidationReadinessInput
): ValidationReadinessTelemetry {
  const passed = input.validations.filter((item) => item.status === "passed");
  const executed = input.validations.filter(isExecutedValidation);
  const passedPaths = new Set(passed.flatMap((item) => item.data.coveredPaths));
  const executedPaths = new Set(executed.flatMap((item) => item.data.coveredPaths));
  const covers = (path: string, declared: ReadonlySet<string>) =>
    input.acceptedPaths.has(path) || declared.has(path);
  const covered = input.changedPaths.filter((path) => covers(path, passedPaths));
  const executionCovered = input.changedPaths.filter((path) => covers(path, executedPaths));
  return {
    coveredPaths: covered,
    missingPaths: input.changedPaths.filter((path) => !covered.includes(path)),
    missingClaims: missingClaims(input.requiredClaims, passed, input.repositoryAccepted),
    executedPaths: executionCovered,
    missingExecutionPaths: input.changedPaths.filter((path) => !executionCovered.includes(path)),
    missingExecutionClaims: missingClaims(input.requiredClaims, executed, input.repositoryAccepted),
    executionReady: executed.length > 0,
    ready: passed.length > 0
  };
}
