import { createHash } from "node:crypto";

export const MODEL_PROJECTION_MAX_ENTRIES = 64;
export const MODEL_PROJECTION_MAX_BYTES = 16 * 1024;

export interface BoundedProjectionV1 {
  version: "bounded_projection_v1";
  entries: string[];
  totalCount: number;
  omittedCount: number;
  digest: string;
  evidenceRef: string;
}

export interface BoundedProjectionOptions {
  evidenceRef: string;
  maxEntries?: number;
  maxBytes?: number;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function modelVisibleEntry(value: string): string {
  const maximumSourceCharacters = 4_096;
  const source = value.length <= maximumSourceCharacters ? value : [
    value.slice(0, maximumSourceCharacters / 2),
    `...[entry omitted; chars=${value.length}; sha256=${createHash("sha256").update(value, "utf8").digest("hex")}]...`,
    value.slice(-(maximumSourceCharacters / 2))
  ].join("");
  const redacted = source
    .replace(/Bearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(/((?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)[^@\s]+@/giu, "$1[redacted]@");
  return [...redacted].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127 ? JSON.stringify(character).slice(1, -1) : character;
  }).join("");
}

function completeListDigest(values: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update("[");
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0) hash.update(",");
    hash.update(JSON.stringify(values[index]));
  }
  hash.update("]");
  return hash.digest("hex");
}

function projection(
  entries: string[],
  totalCount: number,
  digest: string,
  evidenceRef: string
): BoundedProjectionV1 {
  return {
    version: "bounded_projection_v1",
    entries,
    totalCount,
    omittedCount: totalCount - entries.length,
    digest,
    evidenceRef
  };
}

/**
 * Build a deterministic, model-safe view without changing the authoritative
 * collection. The digest is computed over the complete, unredacted input so a
 * later evidence read can prove which exact collection was projected.
 */
export function boundedProjectionV1(
  values: readonly string[],
  options: BoundedProjectionOptions
): BoundedProjectionV1 {
  const maximumEntries = Math.max(0, Math.min(
    MODEL_PROJECTION_MAX_ENTRIES,
    Math.trunc(options.maxEntries ?? MODEL_PROJECTION_MAX_ENTRIES)
  ));
  const maximumBytes = Math.max(1, Math.min(
    MODEL_PROJECTION_MAX_BYTES,
    Math.trunc(options.maxBytes ?? MODEL_PROJECTION_MAX_BYTES)
  ));
  const digest = completeListDigest(values);
  const entries: string[] = [];
  for (const value of values.slice(0, maximumEntries)) {
    const visible = modelVisibleEntry(value);
    const candidate = projection([...entries, visible], values.length, digest, options.evidenceRef);
    if (serializedBytes(candidate) > maximumBytes) break;
    entries.push(visible);
  }
  return projection(entries, values.length, digest, options.evidenceRef);
}

export function projectionMetadata(value: BoundedProjectionV1): string {
  return [
    `version=${value.version}`,
    `totalCount=${value.totalCount}`,
    `omittedCount=${value.omittedCount}`,
    `sha256=${value.digest}`,
    `evidenceRef=${value.evidenceRef}`
  ].join("; ");
}
