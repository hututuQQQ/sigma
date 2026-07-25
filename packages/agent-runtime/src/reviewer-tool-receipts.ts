import type {
  EvidenceRecord,
  ModelMessage,
  ModelToolCall,
  ToolReceipt
} from "agent-protocol";
import type { ReviewerToolCheckV1 } from "./reviewer-contracts.js";
import type { RuntimeSession } from "./types.js";
import {
  type ActiveReviewerToolEnvironmentOptions,
  sha256
} from "./reviewer-tool-shared.js";

export type DurableReviewerReceipt = ToolReceipt & {
  outcome: NonNullable<ToolReceipt["outcome"]>;
};

export function normalizedReceipt(receipt: ToolReceipt): DurableReviewerReceipt {
  return {
    ...receipt,
    outcome: receipt.outcome ?? {
      status: receipt.ok ? "succeeded" : "failed",
      output: receipt.output,
      diagnosticCodes: [...receipt.diagnostics]
    },
    actualEffects: receipt.actualEffects ?? receipt.observedEffects,
    evidence: receipt.evidence ?? []
  };
}

export function syntheticCheckEvidence(
  session: RuntimeSession,
  call: ModelToolCall,
  receipt: ToolReceipt
): EvidenceRecord {
  return {
    evidenceId: `review-check:${call.id}`,
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    kind: "diagnostic",
    status: receipt.ok ? "passed" : "failed",
    createdAt: receipt.completedAt,
    producer: { authority: "tool", id: call.id },
    summary: `Independent verification tool '${call.name}' ${receipt.ok ? "completed" : "failed"}.`,
    data: {
      source: `reviewer:${call.name}`,
      diagnostic: {
        callId: call.id,
        outputDigest: sha256(receipt.output),
        effects: receipt.actualEffects ?? receipt.observedEffects,
        diagnostics: receipt.diagnostics
      }
    }
  };
}

export function reviewerToolFailure(
  session: RuntimeSession,
  call: ModelToolCall,
  startedAt: string,
  error: unknown
): DurableReviewerReceipt {
  const code = typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code
    : "review_tool_failed";
  const raw: ToolReceipt = {
    callId: call.id,
    ok: false,
    output: error instanceof Error ? error.message : String(error),
    outcome: {
      status: "failed",
      output: error instanceof Error ? error.message : String(error),
      diagnosticCodes: [code]
    },
    observedEffects: [],
    actualEffects: [],
    artifacts: [],
    diagnostics: [code],
    evidence: [],
    startedAt,
    completedAt: new Date().toISOString()
  };
  return normalizedReceipt({
    ...raw,
    evidence: [syntheticCheckEvidence(session, call, raw)]
  });
}

export function checkFor(
  call: ModelToolCall,
  receipt: ToolReceipt
): ReviewerToolCheckV1 {
  return {
    toolName: call.name,
    evidenceIds: (receipt.evidence ?? []).map((item) => item.evidenceId),
    summary: `${call.name}: ${receipt.ok ? "succeeded" : "failed"}; output ${sha256(receipt.output).slice(0, 12)}`
  };
}

export function toolMessage(call: ModelToolCall, receipt: ToolReceipt): ModelMessage {
  const evidenceIds = (receipt.evidence ?? []).map((item) => item.evidenceId);
  const evidenceNote = evidenceIds.length > 0
    ? `\n\nDurable reviewer evidence IDs: ${evidenceIds.join(", ")}`
    : "";
  return {
    role: "tool",
    toolCallId: call.id,
    content: `${receipt.output.length <= 12_000
      ? receipt.output
      : `${receipt.output.slice(0, 9_000)}\n...[review tool output truncated]...\n${receipt.output.slice(-3_000)}`}${evidenceNote}`
  };
}

export async function materializeLargeOutput(
  options: ActiveReviewerToolEnvironmentOptions,
  call: ModelToolCall,
  raw: ToolReceipt
): Promise<ToolReceipt> {
  if (Buffer.byteLength(raw.output, "utf8") <= 12_000) return raw;
  const content = Buffer.from(raw.output, "utf8");
  const artifactId = await options.createArtifact(
    options.session.identity.sessionId,
    content
  );
  return {
    ...raw,
    artifacts: [...new Set([...raw.artifacts, artifactId])],
    artifactRefs: [
      ...(raw.artifactRefs ?? []),
      {
        artifactId,
        name: `review-${call.name}-${call.id}.txt`,
        digest: sha256(content),
        mediaType: "text/plain; charset=utf-8",
        sizeBytes: content.byteLength
      }
    ],
    diagnostics: [...raw.diagnostics, `full_output_artifact:${artifactId}`]
  };
}
