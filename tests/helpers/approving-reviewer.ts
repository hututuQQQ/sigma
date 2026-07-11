import { randomUUID } from "node:crypto";
import type { ReviewEvidence } from "../../packages/agent-protocol/src/index.js";
import type { ReviewerInput, ReviewerPort } from "../../packages/agent-runtime/src/reviewer.js";

export function createApprovingReviewer(id = "test-independent-reviewer"): ReviewerPort {
  return {
    async review(input: ReviewerInput): Promise<ReviewEvidence> {
      return {
        evidenceId: randomUUID(),
        sessionId: input.sessionId,
        runId: input.runId,
        kind: "review",
        status: "passed",
        createdAt: new Date().toISOString(),
        producer: { authority: "runtime", id },
        summary: "Independent test reviewer approved the supplied durable diff and validation evidence.",
        data: {
          reviewerId: id,
          verdict: "approved",
          findings: [],
          workspaceDeltaEvidenceIds: input.workspaceDeltas.map((item) => item.evidenceId),
          ...(input.workspaceDeltas.at(-1)?.data.checkpointId
            ? { checkpointId: input.workspaceDeltas.at(-1)!.data.checkpointId }
            : {})
        }
      };
    }
  };
}
