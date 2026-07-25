import type { JsonValue, ModelToolCall, ToolReceipt } from "agent-protocol";
import type { ReviewerInput } from "./reviewer-contracts.js";
import {
  type DurableReviewerReceipt,
  normalizedReceipt,
  syntheticCheckEvidence
} from "./reviewer-tool-receipts.js";
import {
  type ActiveReviewerToolEnvironmentOptions,
  jsonObject,
  sha256,
  utf8PageRange
} from "./reviewer-tool-shared.js";

export async function readReviewerArtifact(
  options: ActiveReviewerToolEnvironmentOptions,
  call: ModelToolCall
): Promise<DurableReviewerReceipt> {
  const startedAt = new Date().toISOString();
  const input = jsonObject(call.arguments);
  if (typeof input.artifactId !== "string" || !input.artifactId) {
    throw Object.assign(new Error("artifactId is required."), {
      code: "review_artifact_invalid"
    });
  }
  const result = await options.control.forSession(options.session).readArtifact({
    artifactId: input.artifactId,
    ...(Number.isSafeInteger(input.offsetBytes)
      ? { offsetBytes: Number(input.offsetBytes) }
      : {}),
    ...(Number.isSafeInteger(input.maxBytes)
      ? { maxBytes: Number(input.maxBytes) }
      : {})
  });
  const raw: ToolReceipt = {
    callId: call.id,
    ok: true,
    output: JSON.stringify(result),
    result: result as unknown as JsonValue,
    observedEffects: ["filesystem.read"],
    actualEffects: ["filesystem.read"],
    artifacts: [],
    diagnostics: [],
    evidence: [],
    startedAt,
    completedAt: new Date().toISOString()
  };
  return normalizedReceipt({
    ...raw,
    evidence: [syntheticCheckEvidence(options.session, call, raw)]
  });
}

export async function readReviewerChangeSet(
  options: ActiveReviewerToolEnvironmentOptions,
  input: ReviewerInput,
  call: ModelToolCall,
  projected: { content: Buffer; artifactId: string }
): Promise<DurableReviewerReceipt> {
  const startedAt = new Date().toISOString();
  const arguments_ = jsonObject(call.arguments);
  const offset = Number.isSafeInteger(arguments_.offsetBytes)
    ? Math.max(0, Number(arguments_.offsetBytes))
    : 0;
  const maximum = Number.isSafeInteger(arguments_.maxBytes)
    ? Math.min(65_536, Math.max(1, Number(arguments_.maxBytes)))
    : 8_192;
  const changeSet = projected.content;
  const { start, end } = utf8PageRange(changeSet, offset, maximum);
  const chunk = changeSet.subarray(start, end);
  const result = {
    totalBytes: changeSet.byteLength,
    requestedOffsetBytes: offset,
    offsetBytes: start,
    returnedBytes: chunk.byteLength,
    nextOffset: end < changeSet.byteLength ? end : null,
    eof: end >= changeSet.byteLength,
    digest: sha256(changeSet),
    utf8: chunk.toString("utf8"),
    base64: chunk.toString("base64")
  };
  const raw: ToolReceipt = {
    callId: call.id,
    ok: true,
    output: JSON.stringify(result),
    result,
    observedEffects: ["filesystem.read"],
    actualEffects: ["filesystem.read"],
    artifacts: [projected.artifactId],
    artifactRefs: [{
      artifactId: projected.artifactId,
      name: `verification-change-set-${input.frontierRevision}.json`,
      digest: sha256(changeSet),
      mediaType: "application/json",
      sizeBytes: changeSet.byteLength
    }],
    diagnostics: [],
    evidence: [],
    startedAt,
    completedAt: new Date().toISOString()
  };
  return normalizedReceipt({
    ...raw,
    evidence: [syntheticCheckEvidence(options.session, call, raw)]
  });
}
