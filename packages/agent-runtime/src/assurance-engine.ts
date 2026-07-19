import type {
  AssuranceRequirementV1,
  ValidationClaimKindV1
} from "agent-protocol";
import {
  projectCapabilitiesForPath,
  staticValidationClaimsForPath,
  type RepositoryValidationCapabilityProfile
} from "agent-context";
import type { RuntimeSession } from "./types.js";

const HIGH_RISK_PATH = /(?:^|\/)(?:native|security|sandbox|permissions?|auth|completion|budget|release|deployment|agent-execution|agent-runtime)(?:\/|$)|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/iu;
const SOURCE_PATH = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp)$/iu;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/iu;

export function explicitAcceptanceClaims(goal: string): ValidationClaimKindV1[] {
  const claims: ValidationClaimKindV1[] = [];
  const lower = goal.toLowerCase();
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?lint\b|\beslint\b/u.test(lower)) claims.push("lint");
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:typecheck|check-types)\b|\btsc\b/u.test(lower)) claims.push("typecheck");
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:vitest|jest|pytest)\b/u.test(lower)) claims.push("unit");
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?build\b/u.test(lower)) claims.push("acceptance");
  if (/\bnode(?:\.exe)?\s+--check\b/u.test(lower)) claims.push("syntax");
  return claims;
}

function currentCapabilityProfile(session: RuntimeSession): RepositoryValidationCapabilityProfile | undefined {
  const profile = session.interaction.validationCapabilities;
  return profile?.complete === true
    && profile.stateDigest === session.durable.state.mutationFrontier.currentStateDigest
    ? profile : undefined;
}

function projectHasUnit(
  profile: RepositoryValidationCapabilityProfile,
  changedPath: string
): boolean {
  return projectCapabilitiesForPath(profile, changedPath)?.unit === true;
}

function addStrictSourceClaims(
  changed: readonly string[],
  required: Set<ValidationClaimKindV1>
): void {
  if (changed.some((item) => TEST_PATH.test(item))) required.add("unit");
  if (changed.some((item) => /\.[cm]?tsx?$/iu.test(item))) required.add("typecheck");
  if (changed.some((item) => SOURCE_PATH.test(item)) && required.size === 0) required.add("unit");
}

function addCapabilityAwareSourceClaims(
  changed: readonly string[],
  profile: RepositoryValidationCapabilityProfile,
  required: Set<ValidationClaimKindV1>
): void {
  for (const changedPath of changed) {
    if (!SOURCE_PATH.test(changedPath)) continue;
    required.add(TEST_PATH.test(changedPath) || projectHasUnit(profile, changedPath)
      ? "unit" : "acceptance");
    for (const claim of staticValidationClaimsForPath(profile, changedPath)) required.add(claim);
  }
}

export function assuranceRequirement(session: RuntimeSession): AssuranceRequirementV1 {
  const changed = session.durable.state.mutationFrontier.changedPaths;
  if (changed.length === 0) return { risk: "read_only", requiredClaims: [], review: "off" };
  const high = changed.some((item) => HIGH_RISK_PATH.test(item));
  const required = new Set<ValidationClaimKindV1>(explicitAcceptanceClaims(session.durable.state.plan.goal));
  const profile = currentCapabilityProfile(session);
  if (profile) addCapabilityAwareSourceClaims(changed, profile, required);
  else addStrictSourceClaims(changed, required);
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
  claim: ValidationClaimKindV1,
  session?: RuntimeSession
): string[] {
  const profile = session ? currentCapabilityProfile(session) : undefined;
  if (profile && session) {
    const explicit = new Set(explicitAcceptanceClaims(session.durable.state.plan.goal));
    const high = session.durable.state.mutationFrontier.changedPaths.some((item) => HIGH_RISK_PATH.test(item));
    if (claim === "unit" || claim === "integration") {
      return paths.filter((item) => (SOURCE_PATH.test(item) || TEST_PATH.test(item))
        && (explicit.has("unit") || TEST_PATH.test(item) || projectHasUnit(profile, item)));
    }
    if (claim === "syntax" || claim === "typecheck") {
      return paths.filter((item) => explicit.has(claim)
        ? claim === "typecheck" ? /\.[cm]?tsx?$/iu.test(item) : SOURCE_PATH.test(item)
        : staticValidationClaimsForPath(profile, item).includes(claim));
    }
    if (claim === "acceptance") {
      return paths.filter((item) => explicit.has("acceptance") || high || !SOURCE_PATH.test(item)
        || !projectHasUnit(profile, item));
    }
    if (claim === "lint") {
      return explicit.has("lint")
        ? paths.filter((item) => SOURCE_PATH.test(item) || /\.(?:json|ya?ml|toml)$/iu.test(item))
        : [];
    }
  }
  if (claim === "typecheck") return paths.filter((item) => /\.[cm]?tsx?$/iu.test(item));
  if (claim === "unit" || claim === "integration") {
    return paths.filter((item) => SOURCE_PATH.test(item) || TEST_PATH.test(item));
  }
  if (claim === "lint") return paths.filter((item) => SOURCE_PATH.test(item) || /\.(?:json|ya?ml|toml)$/iu.test(item));
  return [...paths];
}
