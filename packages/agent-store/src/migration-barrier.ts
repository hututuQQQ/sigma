import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { inspectProcessOwner, isProcessOwnerActive } from "agent-platform";
import { V2ReadOnlySessionStore } from "./legacy-v2-store.js";
import { safeId, sessionDirectory } from "./paths.js";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function targetFingerprint(directory: string): Promise<string> {
  const meta = await readFile(path.join(directory, "meta.json"));
  const eventsDir = path.join(directory, "events");
  const names = (await readdir(eventsDir).catch(() => []))
    .filter((name) => /^\d{6}\.jsonl$/u.test(name)).sort();
  const segments: Array<{ name: string; digest: string; bytes: number }> = [];
  for (const name of names) {
    const bytes = await readFile(path.join(eventsDir, name));
    segments.push({ name, digest: sha256(bytes), bytes: bytes.byteLength });
  }
  return sha256(JSON.stringify({ metaDigest: sha256(meta), segments }));
}

export async function assertLegacySourceQuiescent(sourcePath: string): Promise<void> {
  for (const name of ["runtime-owner.json", ".append.lock"]) {
    const observation = await inspectProcessOwner(path.join(sourcePath, name));
    if (isProcessOwnerActive(observation) || observation.kind === "malformed") {
      throw Object.assign(new Error(
        `V2 source has an active or unverified legacy owner '${name}'; promotion was not started.`
      ), { code: "v2_source_active" });
    }
  }
}

interface MigrationSourceBarrier {
  source: { path: string; digest: string; eventCount: number; lastSeq: number };
  target: { path: string; digest: string; lastSeq: number };
}

function migrationManifestError(sessionId: string, cause?: unknown): Error {
  return Object.assign(new Error(`V3 migration manifest is invalid for '${sessionId}'.`,
    cause === undefined ? undefined : { cause }), { code: "v2_migration_manifest_invalid" });
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function barrierSource(value: unknown, sessionId: string): MigrationSourceBarrier["source"] {
  const source = objectRecord(value);
  if (!source || typeof source.path !== "string" || !/^[a-f0-9]{64}$/u.test(String(source.digest))
    || !Number.isSafeInteger(source.eventCount) || !Number.isSafeInteger(source.lastSeq)) {
    throw migrationManifestError(sessionId);
  }
  return {
    path: source.path,
    digest: String(source.digest),
    eventCount: Number(source.eventCount),
    lastSeq: Number(source.lastSeq)
  };
}

function barrierTarget(value: unknown, sessionId: string): MigrationSourceBarrier["target"] {
  const target = objectRecord(value);
  if (!target || typeof target.path !== "string" || !/^[a-f0-9]{64}$/u.test(String(target.digest))
    || !Number.isSafeInteger(target.lastSeq)) throw migrationManifestError(sessionId);
  return { path: target.path, digest: String(target.digest), lastSeq: Number(target.lastSeq) };
}

async function readMigrationBarrier(targetPath: string, sessionId: string): Promise<MigrationSourceBarrier | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path.join(targetPath, "migration.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw migrationManifestError(sessionId, error);
  }
  const item = objectRecord(value);
  if (item?.kind !== "v2_to_v3_copy_on_write" || item.sessionId !== sessionId) {
    throw migrationManifestError(sessionId);
  }
  return { source: barrierSource(item.source, sessionId), target: barrierTarget(item.target, sessionId) };
}

/** Every resume validates the immutable V2 source against its cutover digest,
 * preventing a late legacy writer from being silently ignored by V3. */
export async function assertPromotedV2SourceUnchanged(rootDir: string, sessionIdValue: string): Promise<void> {
  const resolvedRoot = path.resolve(rootDir);
  const sessionId = safeId(sessionIdValue);
  const sourcePath = path.join(resolvedRoot, "sessions", sessionId);
  const targetPath = sessionDirectory(resolvedRoot, sessionId);
  const barrier = await readMigrationBarrier(targetPath, sessionId);
  if (!barrier) return;
  if (path.resolve(barrier.source.path) !== sourcePath || path.resolve(barrier.target.path) !== targetPath) {
    throw migrationManifestError(sessionId);
  }
  await assertLegacySourceQuiescent(sourcePath);
  let current;
  try {
    current = await new V2ReadOnlySessionStore(resolvedRoot).inspect(sessionId);
  } catch (error) {
    throw Object.assign(new Error(`Promoted V2 source is missing or corrupt for '${sessionId}'.`, { cause: error }), {
      code: "v2_source_diverged"
    });
  }
  if (current.sourceDigest !== barrier.source.digest || current.eventCount !== barrier.source.eventCount
    || current.lastSeq !== barrier.source.lastSeq || barrier.target.lastSeq !== barrier.source.lastSeq
    || await targetFingerprint(targetPath) !== barrier.target.digest) {
    throw Object.assign(new Error(`Promoted V2 source diverged after cutover for '${sessionId}'.`), {
      code: "v2_source_diverged"
    });
  }
}
