import {
  type FrozenArtifactRef,
  type FrozenCustomizationRef
} from "agent-protocol";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function validConvergenceStageHighWater(state: Record<string, unknown>): boolean {
  if (state.convergenceStageHighWater === undefined) return true;
  const value = record(state.convergenceStageHighWater);
  return Boolean(value
    && typeof value.runId === "string" && value.runId.length > 0
    && ["normal", "converge", "stop"].includes(String(value.deadline))
    && ["normal", "converge", "terminal"].includes(String(value.budget)));
}

export function validFrozenState(state: Record<string, unknown>): boolean {
  return [
    state.frozenProfile === undefined || isFrozenArtifactRef(state.frozenProfile),
    state.frozenCustomization === undefined || isFrozenCustomizationRef(state.frozenCustomization),
    Array.isArray(state.frozenSkills) && state.frozenSkills.every(isFrozenArtifactRef)
  ].every(Boolean);
}

function isFrozenArtifactRef(value: unknown): value is FrozenArtifactRef {
  const item = record(value);
  if (!item) return false;
  const manifestAbsent = item.executionManifestArtifactId === undefined
    && item.executionManifestDigest === undefined;
  const manifestPresent = [
    typeof item.executionManifestArtifactId === "string",
    typeof item.executionManifestArtifactId === "string"
      && /^[a-f0-9]{64}$/u.test(item.executionManifestArtifactId),
    typeof item.executionManifestDigest === "string",
    typeof item.executionManifestDigest === "string"
      && /^[a-f0-9]{64}$/u.test(item.executionManifestDigest)
  ].every(Boolean);
  return [
    typeof item.artifactId === "string" && item.artifactId.length > 0,
    typeof item.digest === "string" && item.digest.length > 0,
    ["home", "workspace", "builtin"].includes(String(item.source)),
    typeof item.qualifiedName === "string" && item.qualifiedName.length > 0,
    manifestAbsent || manifestPresent
  ].every(Boolean);
}

function isFrozenCustomizationRef(value: unknown): value is FrozenCustomizationRef {
  const item = record(value);
  return Boolean(item && typeof item.artifactId === "string" && /^[a-f0-9]{64}$/u.test(item.artifactId)
    && typeof item.digest === "string" && /^[a-f0-9]{64}$/u.test(item.digest));
}
