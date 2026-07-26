import { Buffer } from "node:buffer";
import type {
  ArtifactRef,
  RuntimeControlPort,
  ToolExecutionContext
} from "agent-protocol";
import type { WebManifest, WebManifestEntry } from "./types.js";

const REF_PATTERN = /^web:([a-f0-9]{64}):(\d+)$/u;
const MAX_ARTIFACT_BYTES = 5 * 1_024 * 1_024;

export interface ResolvedWebReference {
  manifestArtifactId: string;
  entryIndex: number;
  manifest: WebManifest;
  entry: WebManifestEntry;
}

export function webReference(manifestArtifactId: string, entryIndex: number): string {
  return `web:${manifestArtifactId}:${entryIndex}`;
}

export function externalArtifactRef(
  artifactId: string,
  name: string,
  content: string,
  mediaType: string
): ArtifactRef {
  return {
    artifactId,
    name,
    digest: artifactId,
    mediaType,
    sizeBytes: Buffer.byteLength(content, "utf8"),
    contentTrust: "external_untrusted"
  };
}

async function artifactBytes(control: RuntimeControlPort, artifactId: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let offset = 0;
  let total = 0;
  while (true) {
    const page = await control.readArtifact({
      artifactId,
      offsetBytes: offset,
      maxBytes: 64 * 1_024
    });
    if (page.contentTrust !== "external_untrusted") {
      throw Object.assign(new Error("Web artifact is missing its external-content trust marker."), {
        code: "web_ref_trust_invalid"
      });
    }
    const bytes = page.encoding === "utf8"
      ? Buffer.from(page.content, "utf8") : Buffer.from(page.content, "base64");
    chunks.push(bytes);
    total += bytes.byteLength;
    if (total > MAX_ARTIFACT_BYTES) {
      throw Object.assign(new Error("Web artifact exceeds the 5 MiB read limit."), {
        code: "web_ref_too_large"
      });
    }
    if (page.eof) break;
    if (page.nextOffset === undefined || page.nextOffset <= offset) {
      throw Object.assign(new Error("Web artifact pagination did not advance."), {
        code: "web_ref_invalid"
      });
    }
    offset = page.nextOffset;
  }
  return Buffer.concat(chunks);
}

function manifestEntry(value: unknown): value is WebManifestEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (item.kind === "search_result" || item.kind === "page")
    && typeof item.url === "string"
    && typeof item.title === "string";
}

function parseManifest(bytes: Buffer): WebManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw Object.assign(new Error("Web reference manifest is not valid JSON."), {
      code: "web_ref_invalid"
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("Web reference manifest is invalid."), {
      code: "web_ref_invalid"
    });
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== 1
    || (manifest.provider !== "exa" && manifest.provider !== "direct")
    || !Array.isArray(manifest.entries)
    || !manifest.entries.every(manifestEntry)) {
    throw Object.assign(new Error("Web reference manifest has an unsupported schema."), {
      code: "web_ref_invalid"
    });
  }
  return manifest as unknown as WebManifest;
}

export async function resolveWebReference(
  value: string,
  control: RuntimeControlPort | undefined
): Promise<ResolvedWebReference> {
  const match = REF_PATTERN.exec(value);
  if (!match || !control) {
    throw Object.assign(new Error("Web reference is invalid or artifact access is unavailable."), {
      code: "web_ref_invalid"
    });
  }
  const entryIndex = Number(match[2]);
  const manifestArtifactId = match[1]!;
  const manifest = parseManifest(await artifactBytes(control, manifestArtifactId));
  const entry = manifest.entries[entryIndex];
  if (!entry) {
    throw Object.assign(new Error("Web reference entry does not exist."), {
      code: "web_ref_missing"
    });
  }
  return { manifestArtifactId, entryIndex, manifest, entry };
}

export async function readWebBody(
  entry: WebManifestEntry,
  control: RuntimeControlPort | undefined
): Promise<string> {
  if (entry.kind !== "page" || !entry.bodyArtifactId || !control) {
    throw Object.assign(new Error("Reference has no opened page body; call open first."), {
      code: "web_page_not_opened"
    });
  }
  return (await artifactBytes(control, entry.bodyArtifactId)).toString("utf8");
}

export async function createExternalArtifact(
  context: Pick<ToolExecutionContext, "createArtifact">,
  name: string,
  content: string,
  mediaType: string
): Promise<{ artifactId: string; ref: ArtifactRef }> {
  const artifactId = await context.createArtifact({ name, content });
  return {
    artifactId,
    ref: externalArtifactRef(artifactId, name, content, mediaType)
  };
}
