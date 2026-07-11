import type { EvidenceKind, EvidenceRef, ModelRequest, ModelResponse } from "../../packages/agent-protocol/src/index.js";

const EVIDENCE_KINDS = new Set<EvidenceKind>([
  "workspace_delta",
  "command",
  "validation",
  "diagnostic",
  "review",
  "checkpoint",
  "child_outcome",
  "user_waiver"
]);

export function currentRunEvidence(request: ModelRequest): EvidenceRef[] {
  const ledger = [...request.messages].reverse().find((message) =>
    message.content.includes("Current-run typed durable evidence ledger."))?.content ?? "";
  const result: EvidenceRef[] = [];
  for (const match of ledger.matchAll(/^- (.+?) \(([^,]+), [^)]+\)$/gmu)) {
    const evidenceId = match[1];
    const kind = match[2] as EvidenceKind;
    if (evidenceId && EVIDENCE_KINDS.has(kind)) result.push({ evidenceId, kind });
  }
  return result;
}

export function typedCompletion(
  request: ModelRequest,
  input: { id: string; summary: string; criterion: string; rationale?: string }
): ModelResponse {
  const latest = currentRunEvidence(request).at(-1);
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: input.id,
        name: "complete_task",
        arguments: {
          summary: input.summary,
          criteria: [{
            criterion: input.criterion,
            status: "met",
            evidence: latest ? [latest] : [],
            rationale: input.rationale ?? ""
          }]
        }
      }]
    },
    finishReason: "tool_calls"
  };
}
