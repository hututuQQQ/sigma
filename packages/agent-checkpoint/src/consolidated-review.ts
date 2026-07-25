import { createHash } from "node:crypto";
import type {
  CheckpointManifest,
  CheckpointRecord,
  CheckpointReviewMaterial
} from "./types.js";
import { CheckpointConflictError } from "./types.js";
import { checkpointDelta } from "./manifest.js";
import type { CheckpointCasStore } from "./cas-store.js";
import { checkpointOpaqueArtifacts } from "./opaque-artifacts.js";
import { buildCheckpointReviewMaterial } from "./checkpoint-review.js";

function reviewManifest(
  entries: ReadonlyMap<string, CheckpointManifest["entries"][number]>
): CheckpointManifest {
  const values = [...entries.values()].sort((left, right) =>
    left.path.localeCompare(right.path));
  return {
    entries: values,
    fileCount: values.length,
    totalBytes: values.reduce((total, entry) => total + entry.size, 0)
  };
}

function selectedCheckpoints(
  records: readonly CheckpointRecord[],
  checkpointIds: readonly string[]
): CheckpointRecord[] {
  const byId = new Map(records.map((record) =>
    [record.checkpointId, record] as const));
  return checkpointIds.map((checkpointId) => {
    const record = byId.get(checkpointId);
    if (!record || record.status !== "sealed" || !record.postManifestDigest
      || !record.delta) {
      throw new CheckpointConflictError(
        `Checkpoint ${checkpointId} is unavailable for consolidated review.`
      );
    }
    return record;
  });
}

async function consolidatedManifests(
  selected: readonly CheckpointRecord[],
  getManifest: (digest: string) => Promise<CheckpointManifest>
): Promise<{ before: CheckpointManifest; after: CheckpointManifest }> {
  const baseline = new Map<string, CheckpointManifest["entries"][number]>();
  const current = new Map<string, CheckpointManifest["entries"][number]>();
  const observed = new Set<string>();
  for (const checkpoint of selected) {
    const before = await getManifest(checkpoint.preManifestDigest);
    const after = await getManifest(checkpoint.postManifestDigest!);
    const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
    const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
    const changed = [...new Set([
      ...checkpoint.delta!.added,
      ...checkpoint.delta!.modified,
      ...checkpoint.delta!.deleted
    ])];
    for (const changedPath of changed) {
      if (!observed.has(changedPath)) {
        observed.add(changedPath);
        const entry = beforeByPath.get(changedPath);
        if (entry) baseline.set(changedPath, entry);
      }
      const entry = afterByPath.get(changedPath);
      if (entry) current.set(changedPath, entry);
      else current.delete(changedPath);
    }
  }
  return {
    before: reviewManifest(baseline),
    after: reviewManifest(current)
  };
}

export async function consolidatedCheckpointReview(
  records: readonly CheckpointRecord[],
  checkpointIds: readonly string[],
  getManifest: (digest: string) => Promise<CheckpointManifest>,
  cas: CheckpointCasStore,
  maxBytes: number
): Promise<CheckpointReviewMaterial> {
  if (checkpointIds.length === 0) {
    return { reviewDiff: "", reviewDiffPaths: [], opaqueArtifacts: [] };
  }
  const selected = selectedCheckpoints(records, checkpointIds);
  const { before, after } = await consolidatedManifests(selected, getManifest);
  const synthetic: CheckpointRecord = {
    ...selected[0]!,
    checkpointId: `consolidated-${createHash("sha256")
      .update(JSON.stringify(checkpointIds)).digest("hex").slice(0, 24)}`,
    status: "sealed",
    preManifestDigest: selected[0]!.preManifestDigest,
    postManifestDigest: selected.at(-1)!.postManifestDigest,
    delta: checkpointDelta(before, after)
  };
  const opaqueArtifacts = await checkpointOpaqueArtifacts(
    synthetic,
    before,
    after,
    cas
  );
  return await buildCheckpointReviewMaterial(
    synthetic,
    before,
    after,
    cas,
    maxBytes,
    opaqueArtifacts
  );
}
