import type { ValidationCandidate, ValidationCost, ValidationKind, ValidationScope } from "./validation-types.js";

export function estimateValidationCost(scope: ValidationScope, kind: ValidationKind, command: string): ValidationCost {
  const normalized = command.toLowerCase();
  if (scope === "syntax" || /\b(--check|-m py_compile|bash -n)\b/.test(normalized)) return "cheap";
  if (scope === "focused") return "cheap";
  if (kind === "lint" || kind === "typecheck" || kind === "compile") return "medium";
  if (scope === "project" || /\b(test\s+\.\.\.|go test \.\/\.\.\.|cargo test|mvn test|gradle test|pnpm test|npm test|yarn test)\b/.test(normalized)) {
    return "expensive";
  }
  return "medium";
}

export function withEstimatedCost(candidate: Omit<ValidationCandidate, "cost"> & { cost?: ValidationCost }): ValidationCandidate {
  return {
    ...candidate,
    cost: candidate.cost ?? estimateValidationCost(candidate.scope, candidate.kind, candidate.command)
  };
}
