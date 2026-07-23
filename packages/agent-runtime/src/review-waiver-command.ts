import { randomUUID } from "node:crypto";
import type { RunCommand, WorkspaceDeltaEvidence } from "agent-protocol";
import { currentFrontierReview, sessionMutationEvidence } from "./mutation-evidence.js";
import { reviewerWaivedDeltaIds } from "./review-waiver-policy.js";
import { documentationOnly } from "./reviewer.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import type { RuntimeSession } from "./types.js";

type ReviewerWaiverCommand = Extract<RunCommand, { type: "reviewer_waiver" }>;

function commandError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function pendingReviewDeltas(session: RuntimeSession): WorkspaceDeltaEvidence[] {
  const evidence = sessionMutationEvidence(session);
  const reviewed = currentFrontierReview(session)?.status === "passed";
  const historicallyReviewedCheckpoints = new Set(evidence.flatMap((item) =>
    item.kind === "review" && item.status === "passed" && item.data.verdict === "approved"
      && item.data.checkpointId ? [item.data.checkpointId] : []));
  const waived = reviewerWaivedDeltaIds(evidence);
  return evidence.filter((item): item is WorkspaceDeltaEvidence =>
    item.kind === "workspace_delta" && item.status === "passed" && !documentationOnly(item)
    && !reviewed && !historicallyReviewedCheckpoints.has(item.data.checkpointId)
    && !waived.has(item.evidenceId));
}

function targetDelta(session: RuntimeSession, command: ReviewerWaiverCommand): WorkspaceDeltaEvidence {
  const pending = pendingReviewDeltas(session);
  const requested = command.checkpointId?.trim();
  const target = requested
    ? [...pending].reverse().find((item) => item.data.checkpointId === requested)
    : pending.at(-1);
  if (target) return target;
  const scope = requested ? `checkpoint '${requested}'` : "the current session";
  throw commandError(
    "reviewer_waiver_not_pending",
    `No unreviewed mutation delta exists for ${scope}.`
  );
}

/** Records an auditable user decision. This is intentionally reachable only
 * from RuntimeClient's user command boundary, never from a tool or hook. */
export async function recordReviewerWaiver(
  session: RuntimeSession,
  command: ReviewerWaiverCommand,
  emit: RuntimeEventEmitter
): Promise<string> {
  if (session.execution.running || (session.durable.state.phase !== "needs_input" && session.durable.state.phase !== "terminal")) {
    throw commandError(
      "reviewer_waiver_invalid_state",
      "Reviewer waiver is allowed only while a session is waiting for input or awaiting a follow-up."
    );
  }
  const reason = command.reason.trim();
  if (!reason || reason.length > 2_000) {
    throw commandError("reviewer_waiver_invalid_reason", "Reviewer waiver reason must contain 1 to 2,000 characters.");
  }
  if (session.durable.state.evidence.some((item) => item.kind === "user_waiver")) {
    throw commandError("reviewer_waiver_already_used", "This run has already used its one reviewer waiver.");
  }
  const target = targetDelta(session, command);
  await emit(session, "review.waived", "user", {
    evidenceId: randomUUID(),
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    kind: "user_waiver",
    status: "informational",
    createdAt: new Date().toISOString(),
    producer: { authority: "user", id: "session-command" },
    summary: `The user explicitly waived independent review for checkpoint '${target.data.checkpointId}'.`,
    data: { scope: "review", reason, checkpointId: target.data.checkpointId }
  });
  return target.data.checkpointId;
}
