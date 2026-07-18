import type {
  AssuranceRequirementV1,
  ValidationClaimKindV1
} from "agent-protocol";
import type { RuntimeSession } from "./types.js";

const HIGH_RISK_PATH = /(?:^|\/)(?:native|security|sandbox|permissions?|auth|completion|budget|release|deployment|agent-execution|agent-runtime)(?:\/|$)|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/iu;
const SOURCE_PATH = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp)$/iu;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/iu;

function explicitAcceptanceClaims(goal: string): ValidationClaimKindV1[] {
  const claims: ValidationClaimKindV1[] = [];
  const lower = goal.toLowerCase();
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?lint\b|\beslint\b/u.test(lower)) claims.push("lint");
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:typecheck|check-types)\b|\btsc\b/u.test(lower)) claims.push("typecheck");
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:vitest|jest|pytest)\b/u.test(lower)) claims.push("unit");
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?build\b/u.test(lower)) claims.push("acceptance");
  if (/\bnode(?:\.exe)?\s+--check\b/u.test(lower)) claims.push("syntax");
  return claims;
}

export function assuranceRequirement(session: RuntimeSession): AssuranceRequirementV1 {
  const changed = session.durable.state.mutationFrontier.changedPaths;
  if (changed.length === 0) return { risk: "read_only", requiredClaims: [], review: "off" };
  const high = changed.some((item) => HIGH_RISK_PATH.test(item));
  const required = new Set<ValidationClaimKindV1>(explicitAcceptanceClaims(session.durable.state.plan.goal));
  if (changed.some((item) => TEST_PATH.test(item))) required.add("unit");
  if (changed.some((item) => /\.[cm]?tsx?$/iu.test(item))) required.add("typecheck");
  if (changed.some((item) => SOURCE_PATH.test(item)) && required.size === 0) required.add("unit");
  if (required.size === 0) required.add("acceptance");
  if (high) required.add("acceptance");
  return {
    risk: high ? "high" : changed.some((item) => SOURCE_PATH.test(item)) ? "medium" : "low",
    requiredClaims: [...required],
    review: high ? "required" : "advisory"
  };
}

export function validationClaimSatisfies(
  actual: ValidationClaimKindV1 | undefined,
  required: ValidationClaimKindV1
): boolean {
  if (!actual || actual === "probe") return false;
  if (actual === required) return true;
  return actual === "integration" && required === "unit";
}

export function assurancePathsForClaim(
  paths: readonly string[],
  claim: ValidationClaimKindV1
): string[] {
  if (claim === "typecheck") return paths.filter((item) => /\.[cm]?tsx?$/iu.test(item));
  if (claim === "unit" || claim === "integration") {
    return paths.filter((item) => SOURCE_PATH.test(item) || TEST_PATH.test(item));
  }
  if (claim === "lint") return paths.filter((item) => SOURCE_PATH.test(item) || /\.(?:json|ya?ml|toml)$/iu.test(item));
  return [...paths];
}
