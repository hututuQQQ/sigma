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
import { assurancePathClass } from "./assurance-path-classification.js";

const HIGH_RISK_PATH = /(?:^|\/)(?:native|security|sandbox|permissions?|auth|completion|budget|release|deployment|agent-execution|agent-runtime)(?:\/|$)|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/iu;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/iu;

function normalizedWorkspacePath(value: string): string {
  return value.replaceAll("\\", "/");
}

/** Opaqueness is an observed property of checkpoint material, not a filename
 * convention. A binary or content-omitted README must retain the same
 * executable-validation obligation as an artifact with a binary extension. */
export function frontierOpaqueArtifactPaths(session: RuntimeSession): string[] {
  const frontierPaths = session.durable.state.mutationFrontier.changedPaths;
  const changed = new Set(frontierPaths.map(normalizedWorkspacePath));
  const latestRepresentation = new Map<string, "opaque" | "reviewable">();
  const records = [...session.durable.state.mutationEvidence];
  const seen = new Set(records.map((item) => item.evidenceId));
  for (const item of session.durable.state.evidence) {
    if (!seen.has(item.evidenceId)) records.push(item);
  }
  for (const item of records) {
    if (item.kind !== "workspace_delta" || item.status !== "passed"
      || item.sessionId !== session.identity.sessionId) continue;
    const deltaPaths = [...new Set([
      ...item.data.delta.added, ...item.data.delta.modified, ...item.data.delta.deleted
    ].map(normalizedWorkspacePath))];
    const opaquePaths = new Set((item.data.opaqueArtifacts ?? [])
      .map((artifact) => normalizedWorkspacePath(artifact.path)));
    for (const path of deltaPaths) {
      if (changed.has(path)) latestRepresentation.set(path, opaquePaths.has(path) ? "opaque" : "reviewable");
    }
  }
  return frontierPaths.filter((path) => latestRepresentation.get(normalizedWorkspacePath(path)) === "opaque");
}

export function explicitAcceptanceClaims(goal: string): ValidationClaimKindV1[] {
  const claims: ValidationClaimKindV1[] = [];
  const lower = goal.toLowerCase();
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?lint\b|\b(?:eslint|flake8|golangci-lint|pylint|ruff|stylelint)\b|\blint(?:er)?\b/u.test(lower)) {
    claims.push("lint");
  }
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:typecheck|check-types)\b|\b(?:basedpyright|mypy|pyright|tsc)\b|\btype[- ]?check\b|类型检查/u.test(lower)) {
    claims.push("typecheck");
  }
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:vitest|jest|pytest|phpunit|rspec|ctest|tox|nox)\b|\bcargo\s+(?:test|nextest(?:\s+run)?)\b|\bgo\s+test\b|\bdotnet\s+(?:test|vstest)\b|\b(?:mvn|mvnw|gradle|gradlew)\s+test\b|\b(?:make|gmake|ninja)\s+(?:test|check)\b|\bmeson\s+test\b|\bswift\s+test\b|\bmix\s+test\b|\bcomposer\s+test\b|\bbundle\s+exec\s+rspec\b|\b(?:run|execute|perform|rerun|re-run)\s+(?:the\s+|all\s+)?(?:tests?|test\s+suite)\b|\btest\s+(?:it|this|that|the\s+(?:changes?|code|project|result|implementation|output))\b|\btests?\s+(?:must|should|needs?\s+to)\s+(?:pass|succeed|be\s+clean)\b|\b(?:make\s+sure|ensure|confirm|prove|check\s+that)\b[^.?!\n]{0,80}\btests?\s+pass\b|(?:运行|执行|跑|重跑)(?:一下|一遍|全部|所有)?(?:测试|测试套件)|测试(?:一下|一遍|它|这个|这些|修改|改动|代码|实现|功能|输出)|(?:确保|确认)[^。！？\n]{0,40}测试通过/u.test(lower)) {
    claims.push("unit");
  }
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?build\b|\bcargo\s+(?:build|check)\b|\bgo\s+build\b|\bdotnet\s+build\b|\b(?:mvn|mvnw)\s+(?:package|verify)\b|\b(?:gradle|gradlew)\s+(?:build|check)\b|\b(?:make|gmake)\s+build\b|\bcmake\s+--build\b|\bmeson\s+compile\b|\bswift\s+build\b|\b(?:run|execute|perform|rerun|re-run)\s+(?:the\s+)?build\b|\bbuild\s+(?:must|should|needs?\s+to)\s+(?:pass|succeed)\b|\b(?:make\s+sure|ensure|confirm|prove|check\s+that)\b[^.?!\n]{0,80}\bbuild\s+succeeds?\b|(?:运行|执行|跑|重跑)(?:一下|一遍|全部|所有)?(?:构建|编译)|(?:确保|确认)[^。！？\n]{0,40}(?:构建成功|编译成功)/u.test(lower)) {
    claims.push("acceptance");
  }
  if (/\bnode(?:\.exe)?\s+--check\b/u.test(lower)) claims.push("syntax");
  if (claims.length === 0 && (/\b(?:validate|verify)\b|\b(?:run|execute|perform|rerun|re-run)\s+(?:the\s+)?(?:validation|verification)\b|(?:验证|校验)(?:一下|一遍|它|这个|这些|结果|修改|改动|代码|实现|功能|输出)?/u.test(lower))) {
    claims.push("acceptance");
  }
  return [...new Set(claims)];
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

/** Paths whose semantics must be covered by executable validation before an
 * independent review can approve the current frontier. Ordinary reviewable
 * text is inspected directly by the reviewer under the trusted default
 * profile; explicit validation instructions and high-risk changes stay strict. */
export function reviewValidationRequiredPaths(session: RuntimeSession): string[] {
  const requirement = assuranceRequirement(session);
  const explicit = session.durable.state.validationRequirement === "required";
  const required = new Set(requirement.requiredClaims.flatMap((claim) =>
    assurancePathsForClaim(session.durable.state.mutationFrontier.changedPaths, claim, session)));
  const opaquePaths = frontierOpaqueArtifactPaths(session);
  for (const path of opaquePaths) required.add(path);
  const opaque = new Set(opaquePaths.map(normalizedWorkspacePath));
  return [...required].filter((path) => opaque.has(normalizedWorkspacePath(path)) || explicit
    || requirement.risk === "high"
    || assurancePathClass(path) !== "reviewable_text");
}
