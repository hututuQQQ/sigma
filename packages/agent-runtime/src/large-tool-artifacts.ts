import { createHash } from "node:crypto";
import type { ArtifactRef, ToolReceipt } from "agent-protocol";

export const SUCCESS_TOOL_ARTIFACT_THRESHOLD_BYTES = 8 * 1_024;
export const FAILED_TOOL_ARTIFACT_THRESHOLD_BYTES = 12 * 1_024;

interface MaterializedContent {
  name: string;
  mediaType: string;
  content: string;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function largeContents(toolName: string, callId: string, receipt: ToolReceipt): MaterializedContent[] {
  const values: MaterializedContent[] = [];
  const threshold = receipt.ok
    ? SUCCESS_TOOL_ARTIFACT_THRESHOLD_BYTES : FAILED_TOOL_ARTIFACT_THRESHOLD_BYTES;
  if (Buffer.byteLength(receipt.output, "utf8") > threshold) {
    values.push({
      name: `${toolName}-${callId}-output.txt`,
      mediaType: "text/plain; charset=utf-8",
      content: receipt.output
    });
  }
  if (receipt.result !== undefined) {
    const content = JSON.stringify(receipt.result);
    if (Buffer.byteLength(content, "utf8") > threshold) {
      values.push({
        name: `${toolName}-${callId}-result.json`,
        mediaType: "application/json",
        content
      });
    }
  }
  return values;
}

export async function materializeLargeToolArtifacts(
  sessionId: string,
  toolName: string,
  receipt: ToolReceipt,
  createArtifact: (sessionId: string, content: string | Uint8Array) => Promise<string>
): Promise<ToolReceipt> {
  const refs: ArtifactRef[] = [...(receipt.artifactRefs ?? [])];
  const artifactIds = new Set(receipt.artifacts);
  for (const value of largeContents(toolName, receipt.callId, receipt)) {
    const digest = sha256(value.content);
    if (refs.some((item) => item.digest === digest && item.name === value.name)) continue;
    const artifactId = await createArtifact(sessionId, value.content);
    artifactIds.add(artifactId);
    refs.push({
      artifactId,
      name: value.name,
      digest,
      mediaType: value.mediaType,
      sizeBytes: Buffer.byteLength(value.content, "utf8"),
      ...(receipt.contentTrust === "external_untrusted"
        ? { contentTrust: "external_untrusted" as const } : {})
    });
  }
  return refs.length === (receipt.artifactRefs?.length ?? 0)
    ? receipt
    : {
        ...receipt,
        artifacts: [...artifactIds],
        artifactRefs: refs
      };
}
