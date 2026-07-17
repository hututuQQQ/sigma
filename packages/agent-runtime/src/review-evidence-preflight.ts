import type {
  OpaqueArtifactEvidence,
  ValidationEvidence,
  WorkspaceDeltaEvidence
} from "agent-protocol";
import type { ReviewerInput } from "./reviewer.js";

function binaryReviewEvidenceFailure(
  delta: WorkspaceDeltaEvidence,
  diff: string,
  validations: readonly ValidationEvidence[]
): string | undefined {
  if (!diff.includes("[binary sha256=")) return undefined;
  const markers = [...diff.matchAll(/^\[binary sha256=([a-f0-9]{64}) size=(\d+)\]$/gmu)];
  if (markers.length === 0) return `Delta ${delta.evidenceId} has an invalid opaque artifact digest or size.`;
  if (markers.some((match) => !Number.isSafeInteger(Number(match[2])))) {
    return `Delta ${delta.evidenceId} has an opaque artifact size outside the supported range.`;
  }
  const sections = [...diff.matchAll(/^--- (?:a\/([^\s]+)|\/dev\/null)\n\+\+\+ (?:b\/([^\s]+)|\/dev\/null)$/gmu)]
    .map((match) => (match[2] ?? match[1] ?? "").replaceAll("\\", "/"));
  const changedPaths = new Set([
    ...delta.data.delta.added,
    ...delta.data.delta.modified,
    ...delta.data.delta.deleted
  ].map((item) => item.replaceAll("\\", "/")));
  if (sections.length === 0 || sections.some((section) => section && !changedPaths.has(section))) {
    return `Delta ${delta.evidenceId} is missing an opaque artifact path bound to its workspace delta.`;
  }
  const validated = validations.some((item) => item.status === "passed"
    && [...delta.data.delta.added, ...delta.data.delta.modified, ...delta.data.delta.deleted]
      .some((path) => item.data.coveredPaths.includes(path)));
  if (!validated) return `Delta ${delta.evidenceId} has no passed validation evidence for its opaque artifact.`;
  return undefined;
}

function legacyOpaqueArtifactReviewEvidenceFailure(
  delta: WorkspaceDeltaEvidence,
  validations: readonly ValidationEvidence[]
): string | undefined {
  const artifacts = delta.data.opaqueArtifacts;
  if (!artifacts || artifacts.length === 0) return undefined;
  const changedPaths = new Set([
    ...delta.data.delta.added,
    ...delta.data.delta.modified,
    ...delta.data.delta.deleted
  ].map((item) => item.replaceAll("\\", "/")));
  const seen = new Set<string>();
  for (const artifact of artifacts as OpaqueArtifactEvidence[]) {
    const normalized = typeof artifact.path === "string" ? artifact.path.replaceAll("\\", "/") : "";
    const identities = [artifact.before, artifact.after].filter((item) => item !== undefined);
    if (!changedPaths.has(normalized) || seen.has(normalized)
      || identities.length === 0
      || identities.some((identity) => !/^[a-f0-9]{64}$/u.test(identity.digest)
        || !Number.isSafeInteger(identity.sizeBytes) || identity.sizeBytes < 0)) {
      return `Delta ${delta.evidenceId} has invalid opaque artifact evidence.`;
    }
    seen.add(normalized);
  }
  if (![...changedPaths].every((item) => seen.has(item))) {
    return `Delta ${delta.evidenceId} has incomplete opaque artifact evidence.`;
  }
  const validated = validations.some((item) => item.status === "passed"
    && [...delta.data.delta.added, ...delta.data.delta.modified, ...delta.data.delta.deleted]
      .some((path) => item.data.coveredPaths.includes(path)));
  if (!validated) return `Delta ${delta.evidenceId} has no passed validation evidence for its opaque artifact.`;
  return undefined;
}

type ChangeKind = "added" | "modified" | "deleted";

function normalizedRelativePath(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  if (normalized.length === 0 || normalized.startsWith("/") || /^[a-z]:\//iu.test(normalized)
    || normalized.includes("\r") || normalized.includes("\n")) return undefined;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return undefined;
  return normalized;
}

function changedPathKinds(delta: WorkspaceDeltaEvidence): Map<string, ChangeKind> | undefined {
  const result = new Map<string, ChangeKind>();
  const groups: Array<readonly [ChangeKind, readonly string[]]> = [
    ["added", delta.data.delta.added],
    ["modified", delta.data.delta.modified],
    ["deleted", delta.data.delta.deleted]
  ];
  for (const [kind, paths] of groups) {
    for (const path of paths) {
      const normalized = normalizedRelativePath(path);
      if (!normalized || result.has(normalized)) return undefined;
      result.set(normalized, kind);
    }
  }
  return result;
}

function validOpaqueIdentity(identity: { digest: string; sizeBytes: number } | undefined): boolean {
  return identity !== undefined && /^[a-f0-9]{64}$/u.test(identity.digest)
    && Number.isSafeInteger(identity.sizeBytes) && identity.sizeBytes >= 0;
}

function pathIsFullyOpaque(kind: ChangeKind, artifact: OpaqueArtifactEvidence | undefined): boolean {
  if (!artifact) return false;
  if (kind === "added") return artifact.after !== undefined;
  if (kind === "deleted") return artifact.before !== undefined;
  return artifact.before !== undefined && artifact.after !== undefined;
}

function expectedReviewHeader(path: string, kind: ChangeKind): string {
  const before = kind === "added" ? "/dev/null" : `a/${path}`;
  const after = kind === "deleted" ? "/dev/null" : `b/${path}`;
  return `--- ${before}\n+++ ${after}\n`;
}

function hasPassedValidation(
  delta: WorkspaceDeltaEvidence,
  validations: readonly ValidationEvidence[]
): boolean {
  const paths = [...delta.data.delta.added, ...delta.data.delta.modified, ...delta.data.delta.deleted];
  return validations.some((item) => item.status === "passed"
    && paths.some((path) => item.data.coveredPaths.includes(path)));
}

type EvidenceIndex<T> = { value: T } | { failure: string };

function invalidOpaqueArtifact(
  artifact: OpaqueArtifactEvidence,
  normalized: string | undefined,
  kind: ChangeKind | undefined,
  seen: ReadonlyMap<string, OpaqueArtifactEvidence>
): boolean {
  if (!normalized || !kind || seen.has(normalized)) return true;
  if (artifact.before === undefined && artifact.after === undefined) return true;
  if (artifact.before !== undefined && !validOpaqueIdentity(artifact.before)) return true;
  if (artifact.after !== undefined && !validOpaqueIdentity(artifact.after)) return true;
  if (kind === "added") return artifact.before !== undefined || artifact.after === undefined;
  if (kind === "deleted") return artifact.after !== undefined || artifact.before === undefined;
  return false;
}

function opaqueArtifactIndex(
  delta: WorkspaceDeltaEvidence,
  changes: ReadonlyMap<string, ChangeKind>
): EvidenceIndex<Map<string, OpaqueArtifactEvidence>> {
  const result = new Map<string, OpaqueArtifactEvidence>();
  for (const artifact of delta.data.opaqueArtifacts ?? []) {
    const normalized = normalizedRelativePath(artifact.path);
    const kind = normalized ? changes.get(normalized) : undefined;
    if (invalidOpaqueArtifact(artifact, normalized, kind, result)) {
      return { failure: `Delta ${delta.evidenceId} has invalid opaque artifact evidence.` };
    }
    result.set(normalized!, artifact);
  }
  return { value: result };
}

function reviewDiffCoverageIndex(
  delta: WorkspaceDeltaEvidence,
  changes: ReadonlyMap<string, ChangeKind>
): EvidenceIndex<Set<string>> {
  const result = new Set<string>();
  for (const path of delta.data.reviewDiffPaths ?? []) {
    const normalized = normalizedRelativePath(path);
    if (!normalized || !changes.has(normalized) || result.has(normalized)) {
      return { failure: `Delta ${delta.evidenceId} has invalid or duplicate review diff coverage.` };
    }
    result.add(normalized);
  }
  return { value: result };
}

function changedPathReviewFailure(
  delta: WorkspaceDeltaEvidence,
  diff: string,
  path: string,
  kind: ChangeKind,
  artifact: OpaqueArtifactEvidence | undefined,
  covered: ReadonlySet<string>
): string | undefined {
  if (pathIsFullyOpaque(kind, artifact)) return undefined;
  if (!covered.has(path)) return `Delta ${delta.evidenceId} has incomplete review diff coverage.`;
  if (!diff.includes(expectedReviewHeader(path, kind))) {
    return `Delta ${delta.evidenceId} has review diff coverage without a matching section.`;
  }
  for (const identity of [artifact?.before, artifact?.after]) {
    if (identity && !diff.includes(`[binary sha256=${identity.digest} size=${identity.sizeBytes}]`)) {
      return `Delta ${delta.evidenceId} has opaque evidence not bound to its review diff.`;
    }
  }
  return undefined;
}

function reviewDiffEvidenceFailure(
  delta: WorkspaceDeltaEvidence,
  changes: ReadonlyMap<string, ChangeKind>,
  artifacts: ReadonlyMap<string, OpaqueArtifactEvidence>,
  covered: ReadonlySet<string>
): string | undefined {
  const diff = delta.data.reviewDiff;
  if (typeof diff !== "string") return `Delta ${delta.evidenceId} has no reviewable diff.`;
  if (diff.includes("[review diff truncated]") || diff.includes("[file diff truncated]")
    || diff.includes("[content truncated]")) return `Delta ${delta.evidenceId} has a truncated diff.`;
  for (const path of covered) {
    const kind = changes.get(path)!;
    if (pathIsFullyOpaque(kind, artifacts.get(path)) || !diff.includes(expectedReviewHeader(path, kind))) {
      return `Delta ${delta.evidenceId} has review diff coverage without a matching reviewable section.`;
    }
  }
  for (const [path, kind] of changes) {
    const failure = changedPathReviewFailure(delta, diff, path, kind, artifacts.get(path), covered);
    if (failure) return failure;
  }
  return undefined;
}

function completeReviewEvidenceFailure(
  delta: WorkspaceDeltaEvidence,
  validations: readonly ValidationEvidence[]
): string | undefined {
  const changes = changedPathKinds(delta);
  if (!changes) return `Delta ${delta.evidenceId} has invalid or duplicate workspace paths.`;
  const artifactResult = opaqueArtifactIndex(delta, changes);
  if ("failure" in artifactResult) return artifactResult.failure;
  const coverageResult = reviewDiffCoverageIndex(delta, changes);
  if ("failure" in coverageResult) return coverageResult.failure;
  const diffFailure = reviewDiffEvidenceFailure(delta, changes, artifactResult.value, coverageResult.value);
  if (diffFailure) return diffFailure;
  if (!hasPassedValidation(delta, validations)) {
    return `Delta ${delta.evidenceId} has no passed validation evidence bound to its workspace delta.`;
  }
  return undefined;
}

export function reviewInputFailure(input: ReviewerInput): string | undefined {
  for (const delta of input.workspaceDeltas) {
    if (delta.data.reviewDiffPaths !== undefined) {
      const completeFailure = completeReviewEvidenceFailure(delta, input.validations);
      if (completeFailure) return completeFailure;
      continue;
    }
    const diff = delta.data.reviewDiff;
    const opaqueFailure = legacyOpaqueArtifactReviewEvidenceFailure(delta, input.validations);
    if (opaqueFailure) return opaqueFailure;
    if (delta.data.opaqueArtifacts?.length
      && [...new Set([
        ...delta.data.delta.added,
        ...delta.data.delta.modified,
        ...delta.data.delta.deleted
      ].map((item) => item.replaceAll("\\", "/")))].every((item) => delta.data.opaqueArtifacts!
        .some((artifact) => artifact.path.replaceAll("\\", "/") === item))) continue;
    if (typeof diff !== "string") return `Delta ${delta.evidenceId} has no reviewable diff.`;
    if (diff.includes("[review diff truncated]") || diff.includes("[file diff truncated]")) {
      return `Delta ${delta.evidenceId} has a truncated diff.`;
    }
    const binaryFailure = binaryReviewEvidenceFailure(delta, diff, input.validations);
    if (binaryFailure) return binaryFailure;
  }
  return undefined;
}
