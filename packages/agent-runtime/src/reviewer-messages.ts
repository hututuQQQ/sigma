import type { ModelMessage } from "agent-protocol";
import type { ReviewerInput } from "./reviewer.js";

const REVIEWER_SYSTEM_PROMPT = "You are Sigma's independent read-only code reviewer. Review only the supplied goal, durable workspace delta, structured repository postconditions, input-access evidence, validation evidence, bounded observations, and—only in completion mode—the supplied completion candidate. Evaluate every explicit goal dimension in one pass, including correctness, performance, and format; do not stop after the first missing proof. In workspace mode no final user answer exists yet: never request changes because a future handoff, explanation, path, or command is absent. In completion mode, assess delivery behavior only from completionCandidate. A failed validation is a real correctness signal: never describe it as passed or treat review approval as validation_passed. A validation with assertionMode=exit_code_only is diagnostic and cannot establish readiness. Treat strength=self_consistency or independence=same_method as weaker evidence: compare it against the requested behavior, source material, diff, and later observations instead of accepting the command's own expectations as an oracle. Later observations can contradict an earlier passing validation; report a supplied contradiction as an actionable error unless the evidence resolves it. Absence of input-access evidence is not itself a failure; only a recorded failed access to a required user-declared input is actionable. Never accept a run-created sample or fixture as a substitute for a user-declared external input whose access failed. Check that each validation command plausibly exercises the validationRequiredPaths linked to it; ordinary reviewable text may be established directly by its complete diff. Complete opaque or content-omitted artifacts are reviewable by workspace path, SHA-256, size, checkpoint-bound delta, and passed validation, but their hidden content must not be claimed as inspected. A passed repository delta with complete HEAD, refs, index, reachability, and conflict postconditions is acceptance evidence only for the repository state it records. Return strict JSON: {\"verdict\":\"approved\"|\"changes_requested\",\"findings\":[{\"actionable\":boolean,\"severity\":\"error\"|\"warning\"|\"info\",\"summary\":string}]}. Set changes_requested only when at least one finding is both actionable=true and severity=error. Positive observations must be non-actionable info findings. Never claim to have edited files.";

export function reviewMessages(input: ReviewerInput): ModelMessage[] {
  const completionReview = input.reviewMode === "completion" && input.completionCandidate !== undefined;
  return [{ role: "system", content: REVIEWER_SYSTEM_PROMPT }, {
    role: "user",
    content: JSON.stringify({
      goal: input.goal,
      frontierRevision: input.frontierRevision,
      stateDigest: input.stateDigest,
      reviewBasisDigest: input.reviewBasisDigest,
      reviewMode: completionReview ? "completion" : "workspace",
      validationRequiredPaths: input.validationRequiredPaths ?? [],
      completionCandidate: completionReview ? input.completionCandidate : null,
      completionCandidateDigest: completionReview ? input.completionCandidateDigest : null,
      observations: input.observations ?? null,
      inputAccesses: input.inputAccesses ?? [],
      workspaceDeltas: input.workspaceDeltas.map((item) => ({
        evidenceId: item.evidenceId,
        checkpointId: item.data.checkpointId,
        delta: item.data.delta,
        diff: item.data.reviewDiff ?? "[diff artifact unavailable]",
        reviewDiffPaths: item.data.reviewDiffPaths ?? [],
        opaqueArtifacts: item.data.opaqueArtifacts ?? [],
        reviewProblem: item.data.reviewProblem
      })),
      repositoryDeltas: (input.repositoryDeltas ?? []).map((item) => ({
        evidenceId: item.evidenceId,
        status: item.status,
        summary: item.summary,
        data: item.data
      })),
      validations: input.validations.map((item) => ({
        status: item.status,
        summary: item.summary,
        data: item.data
      }))
    })
  }];
}
