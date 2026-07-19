import type {
  AssuranceRequirementV1,
  ValidationClaimKindV1,
  ValidationRequirementV1
} from "agent-protocol";
import {
  isRepositorySourcePath,
  projectCapabilitiesForPath,
  staticValidationClaimsForPath,
  type RepositoryValidationCapabilityProfile
} from "agent-context";
import type { RuntimeSession } from "./types.js";

const HIGH_RISK_PATH = /(?:^|\/)(?:native|security|sandbox|permissions?|auth|completion|budget|release|deployment|agent-execution|agent-runtime)(?:\/|$)|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/iu;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/iu;

export function explicitAcceptanceClaims(goal: string): ValidationClaimKindV1[] {
  const claims: ValidationClaimKindV1[] = [];
  const lower = goal.toLowerCase();
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?lint\b|\b(?:eslint|flake8|golangci-lint|pylint|ruff|stylelint)\b/u.test(lower)) {
    claims.push("lint");
  }
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:typecheck|check-types)\b|\b(?:basedpyright|mypy|pyright|tsc)\b/u.test(lower)) {
    claims.push("typecheck");
  }
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:vitest|jest|pytest|phpunit|rspec|ctest|tox|nox)\b|\bcargo\s+(?:test|nextest(?:\s+run)?)\b|\bgo\s+test\b|\bdotnet\s+(?:test|vstest)\b|\b(?:mvn|mvnw|gradle|gradlew)\s+test\b|\b(?:make|gmake|ninja)\s+(?:test|check)\b|\bmeson\s+test\b|\bswift\s+test\b|\bmix\s+test\b|\bcomposer\s+test\b|\bbundle\s+exec\s+rspec\b/u.test(lower)) {
    claims.push("unit");
  }
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?build\b|\bcargo\s+(?:build|check)\b|\bgo\s+build\b|\bdotnet\s+build\b|\b(?:mvn|mvnw)\s+(?:package|verify)\b|\b(?:gradle|gradlew)\s+(?:build|check)\b|\b(?:make|gmake)\s+build\b|\bcmake\s+--build\b|\bmeson\s+compile\b|\bswift\s+build\b/u.test(lower)) {
    claims.push("acceptance");
  }
  if (/\bnode(?:\.exe)?\s+--check\b/u.test(lower)) claims.push("syntax");
  return [...new Set(claims)];
}

function hasExplicitValidationIntent(instruction: string): boolean {
  const english = [
    /\b(?:validate|verify|lint)\b|\btype[- ]?check\b/iu,
    /\b(?:run|execute|perform|rerun|re-run)\s+(?:the\s+|all\s+)?(?:tests?|test\s+suite|validation|verification|lint(?:er)?|type[- ]?check|build)\b/iu,
    /\btest\s+(?:it|this|that|the\s+(?:changes?|code|project|result|implementation|output))\b/iu,
    /\b(?:tests?|build|lint|type[- ]?check)\s+(?:must|should|needs?\s+to)\s+(?:pass|succeed|be\s+clean)\b/iu,
    /\b(?:make\s+sure|ensure|confirm|prove|check\s+that)\b[^.?!\n]{0,80}\b(?:tests?\s+pass|build\s+succeeds?|lint\s+(?:passes|is\s+clean)|type[- ]?check\s+passes)\b/iu
  ];
  if (english.some((pattern) => pattern.test(instruction))) return true;
  return [
    /(?:验证|校验)(?:一下|一遍|它|这个|这些|结果|修改|改动|代码|实现|功能|输出)?/u,
    /(?:运行|执行|跑|重跑)(?:一下|一遍|全部|所有)?(?:测试|测试套件|验证|校验|lint|类型检查|构建|编译)/iu,
    /测试(?:一下|一遍|它|这个|这些|修改|改动|代码|实现|功能|输出)/u,
    /(?:确保|确认)[^。！？\n]{0,40}(?:测试通过|构建成功|编译成功|类型检查通过|lint\s*通过)/iu
  ].some((pattern) => pattern.test(instruction));
}

/** Classify validation authority at a trusted user-facing control plane. The
 * runtime command API still treats an omitted classification as `required`;
 * only the built-in standard CLI profile may opt into default assurance, and
 * an explicit validation command in the instruction always remains required. */
export function validationRequirementForInstruction(
  instruction: string,
  profileId: string
): ValidationRequirementV1 {
  return profileId === "standard"
    && explicitAcceptanceClaims(instruction).length === 0
    && !hasExplicitValidationIntent(instruction)
    ? "default"
    : "required";
}

function currentCapabilityProfile(session: RuntimeSession): RepositoryValidationCapabilityProfile | undefined {
  const profile = session.interaction.validationCapabilities;
  return profile?.complete === true
    && profile.availableCommandsComplete === true
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
  if (changed.some(isRepositorySourcePath) && required.size === 0) required.add("unit");
}

function addCapabilityAwareSourceClaims(
  changed: readonly string[],
  profile: RepositoryValidationCapabilityProfile,
  required: Set<ValidationClaimKindV1>
): void {
  for (const changedPath of changed) {
    if (!isRepositorySourcePath(changedPath)) continue;
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
    risk: high ? "high" : changed.some(isRepositorySourcePath) ? "medium" : "low",
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
      return paths.filter((item) => (isRepositorySourcePath(item) || TEST_PATH.test(item))
        && (explicit.has("unit") || TEST_PATH.test(item) || projectHasUnit(profile, item)));
    }
    if (claim === "syntax" || claim === "typecheck") {
      return paths.filter((item) => explicit.has(claim)
        ? claim === "typecheck" ? /\.[cm]?tsx?$/iu.test(item) : isRepositorySourcePath(item)
        : staticValidationClaimsForPath(profile, item).includes(claim));
    }
    if (claim === "acceptance") {
      return paths.filter((item) => explicit.has("acceptance") || high || !isRepositorySourcePath(item)
        || !projectHasUnit(profile, item));
    }
    if (claim === "lint") {
      return explicit.has("lint")
        ? paths.filter((item) => isRepositorySourcePath(item) || /\.(?:json|ya?ml|toml)$/iu.test(item))
        : [];
    }
  }
  if (claim === "typecheck") return paths.filter((item) => /\.[cm]?tsx?$/iu.test(item));
  if (claim === "unit" || claim === "integration") {
    return paths.filter((item) => isRepositorySourcePath(item) || TEST_PATH.test(item));
  }
  if (claim === "lint") return paths.filter((item) => isRepositorySourcePath(item) || /\.(?:json|ya?ml|toml)$/iu.test(item));
  return [...paths];
}
