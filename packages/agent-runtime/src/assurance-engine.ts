import type {
  AssuranceRequirement,
  ValidationClaimKind
} from "agent-protocol";
import { repositoryLanguage } from "agent-context";
import type { RuntimeSession } from "./types.js";

const HIGH_RISK_PATH = /(?:^|\/)(?:native|security|sandbox|permissions?|auth|credentials?|secrets?|completion|budget|billing|payments?|cryptography?|migrations?|database|release|deployment|infrastructure|infra|workflows?|agent-execution|agent-runtime)(?:\/|$)|(?:^|\/)(?:dockerfile|compose\.ya?ml|cargo\.lock|gemfile\.lock|package-lock\.json|pnpm-lock\.yaml|poetry\.lock|uv\.lock|yarn\.lock)$/iu;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)|(?:\.(?:test|spec)|_(?:test|spec))\.[^/]+$|(?:^|\/)test_[^/]+\.[^/]+$/iu;

function sourcePath(value: string): boolean {
  return repositoryLanguage(value) !== undefined;
}

function explicitAcceptanceClaims(goal: string): ValidationClaimKind[] {
  const claims: ValidationClaimKind[] = [];
  const lower = goal.toLowerCase();
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?lint\b|\beslint\b/u.test(lower)) claims.push("lint");
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:typecheck|check-types)\b|\btsc\b/u.test(lower)) claims.push("typecheck");
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:vitest|jest|pytest)\b/u.test(lower)) claims.push("unit");
  if (/\bnode(?:\.exe)?\s+--test(?:\s|=|$)/u.test(lower)) claims.push("unit");
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?build\b/u.test(lower)) claims.push("acceptance");
  if (/\bnode(?:\.exe)?\s+--check\b/u.test(lower)) claims.push("syntax");
  if (/\bnode(?:\.exe)?\s+(?:["'`])?(?!-)(?:[^\s"'`]*[/\\._-])?(?:check|verify|validate)(?:[/\\._-][^\s"'`]*)?(?=["'`]?\s|["'`.,;:]|$)/u.test(lower)) {
    claims.push("acceptance");
  }
  return claims;
}

export function assuranceRequirement(session: RuntimeSession): AssuranceRequirement {
  const changed = session.durable.state.mutationFrontier.changedPaths;
  if (changed.length === 0) return { risk: "read_only", requiredClaims: [], review: "off" };
  const high = changed.some((item) => HIGH_RISK_PATH.test(item));
  const required = new Set<ValidationClaimKind>(explicitAcceptanceClaims(session.durable.state.plan.goal));
  if (changed.some((item) => TEST_PATH.test(item))) required.add("unit");
  if (changed.some((item) => /\.[cm]?tsx?$/iu.test(item))) required.add("typecheck");
  if (changed.some(sourcePath) && required.size === 0) required.add("unit");
  if (required.size === 0) required.add("acceptance");
  if (high) required.add("acceptance");
  return {
    risk: high ? "high" : changed.some(sourcePath) ? "medium" : "low",
    requiredClaims: [...required],
    review: high ? "required" : "advisory"
  };
}

export function validationClaimSatisfies(
  actual: ValidationClaimKind | undefined,
  required: ValidationClaimKind
): boolean {
  if (!actual || actual === "probe") return false;
  if (actual === required) return true;
  return actual === "integration" && required === "unit";
}

export function assurancePathsForClaim(
  paths: readonly string[],
  claim: ValidationClaimKind
): string[] {
  if (claim === "typecheck") return paths.filter((item) => /\.[cm]?tsx?$/iu.test(item));
  if (claim === "unit" || claim === "integration") {
    return paths.filter((item) => sourcePath(item) || TEST_PATH.test(item));
  }
  if (claim === "lint") return paths.filter((item) => sourcePath(item) || /\.(?:json|ya?ml|toml)$/iu.test(item));
  return [...paths];
}
