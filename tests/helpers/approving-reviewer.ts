import { randomUUID } from "node:crypto";
import type { ReviewEvidence } from "../../packages/agent-protocol/src/index.js";
import type { ReviewerInput, ReviewerPort } from "../../packages/agent-runtime/src/reviewer.js";

export function createApprovingReviewer(id = "test-independent-reviewer"): ReviewerPort {
  return {
    async review(input: ReviewerInput): Promise<ReviewEvidence> {
      const evidenceIds = [
        ...input.validations.map((item) => item.evidenceId),
        ...input.workspaceDeltas.map((item) => item.evidenceId)
      ];
      const criteria = input.acceptanceCriteria?.length
        ? input.acceptanceCriteria
        : [input.goal];
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
          schemaVersion: 1,
          reviewerId: id,
          verdict: "approved",
          findings: [],
          criteria: criteria.map((criterion) => ({
            criterion,
            status: "satisfied",
            evidence: [...evidenceIds]
          })),
          frontierRevision: input.frontierRevision,
          stateDigest: input.stateDigest,
          reviewBasisDigest: input.reviewBasisDigest,
          validationEvidenceIds: input.validations.map((item) => item.evidenceId),
          durableEvidenceIds: [...evidenceIds],
          actualChecks: [],
          ...(input.workspaceDeltas.at(-1)?.data.checkpointId
            ? { checkpointId: input.workspaceDeltas.at(-1)!.data.checkpointId }
            : {})
        }
      };
    }
  };
}
