import type { RuntimeSession } from "./types.js";

function containsCandidate(text: string, candidateId: string): boolean {
  const index = text.indexOf(candidateId);
  if (index < 0) return false;
  const before = index === 0 ? "" : text[index - 1]!;
  const after = index + candidateId.length >= text.length
    ? "" : text[index + candidateId.length]!;
  return !/[a-f0-9]/iu.test(before) && !/[a-f0-9]/iu.test(after);
}

/** Match only runtime-issued candidate ids literally repeated by the latest
 * user message. Model arguments and free-form reviewer text are ignored. */
export function repositoryRecoveryCandidateIds(session: RuntimeSession): string[] {
  const userText = [...session.durable.state.messages]
    .reverse()
    .find((message) => message.role === "user")?.content ?? "";
  const decision = [...session.durable.state.evidence]
    .reverse()
    .find((evidence) => evidence.kind === "repository_recovery_decision"
      && evidence.sessionId === session.identity.sessionId
      && evidence.runId === session.durable.runId);
  if (!decision || decision.kind !== "repository_recovery_decision") return [];
  return decision.data.candidates
    .map((candidate) => candidate.candidateId)
    .filter((candidateId) => containsCandidate(userText, candidateId));
}

export function toolTaskControlContext(session: RuntimeSession) {
  const frontier = session.durable.state.mutationFrontier;
  return {
    goalEpoch: session.durable.state.taskControl.goalEpoch,
    repositoryRecoveryCandidateIds: repositoryRecoveryCandidateIds(session),
    mutationFrontierRevision: frontier.revision,
    mutationFrontierStateDigest: frontier.currentStateDigest
  };
}
