import type {
  OpaqueArtifactEvidence,
  WorkspaceDeltaEvidence
} from "agent-protocol";
import type { ReviewerInput } from "./reviewer-contracts.js";

type ChangeKind = "added" | "modified" | "deleted";

function normalizedRelativePath(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  if (normalized.length === 0 || normalized.startsWith("/") || /^[a-z]:\//iu.test(normalized)
    || normalized.includes("\r") || normalized.includes("\n")) return undefined;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return undefined;
  }
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

function validIdentity(identity: { digest: string; sizeBytes: number } | undefined): boolean {
  return identity === undefined || /^[a-f0-9]{64}$/u.test(identity.digest)
    && Number.isSafeInteger(identity.sizeBytes) && identity.sizeBytes >= 0;
}

function validOpaqueShape(
  kind: ChangeKind,
  artifact: OpaqueArtifactEvidence
): boolean {
  if (!validIdentity(artifact.before) || !validIdentity(artifact.after)) return false;
  if (artifact.before === undefined && artifact.after === undefined) return false;
  if (kind === "added") {
    return artifact.before === undefined && artifact.after !== undefined;
  }
  if (kind === "deleted") {
    return artifact.before !== undefined && artifact.after === undefined;
  }
  return true;
}

function opaqueEvidenceFailure(
  delta: WorkspaceDeltaEvidence,
  changes: ReadonlyMap<string, ChangeKind>
): string | undefined {
  const seen = new Set<string>();
  for (const artifact of delta.data.opaqueArtifacts ?? [] as OpaqueArtifactEvidence[]) {
    const path = normalizedRelativePath(artifact.path);
    const kind = path ? changes.get(path) : undefined;
    if (!path || !kind || seen.has(path) || !validOpaqueShape(kind, artifact)) {
      return `Delta ${delta.evidenceId} has invalid opaque artifact identity evidence.`;
    }
    seen.add(path);
  }
  return undefined;
}

/**
 * Preflight verifies only evidence integrity. Material completeness, language
 * type, command shape, validation coverage, and whether a change is reviewable
 * are semantic questions for the active reviewer. Missing or truncated
 * material therefore cannot consume a substantive review attempt.
 */
export function reviewInputFailure(input: ReviewerInput): string | undefined {
  for (const delta of input.workspaceDeltas) {
    const changes = changedPathKinds(delta);
    if (!changes) return `Delta ${delta.evidenceId} has invalid or duplicate workspace paths.`;
    const opaqueFailure = opaqueEvidenceFailure(delta, changes);
    if (opaqueFailure) return opaqueFailure;
    for (const path of delta.data.reviewDiffPaths ?? []) {
      const normalized = normalizedRelativePath(path);
      if (!normalized || !changes.has(normalized)) {
        return `Delta ${delta.evidenceId} has review diff coverage outside its workspace delta.`;
      }
    }
  }
  return undefined;
}
