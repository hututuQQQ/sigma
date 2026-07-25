import type { ReviewRequestResult } from "agent-protocol";
import { completionCandidate } from "./completion-gate-common.js";
import {
  currentFrontierReview,
  frontierValidationReadiness,
  latestFrontierReview,
  reviewBasisDigest
} from "./mutation-evidence.js";
import { reviewReadiness } from "./review-coordinator-support.js";
import type { RuntimeSession } from "./types.js";

export function runtimeReviewRequest(session: RuntimeSession): ReviewRequestResult {
  const candidateDigest = completionCandidate(session)?.digest;
  const reviewMode = candidateDigest ? "completion" as const : "workspace" as const;
  const readiness = reviewReadiness(session, reviewMode);
  const validationTelemetry = frontierValidationReadiness(session);
  const frontier = session.durable.state.mutationFrontier;
  const currentReview = currentFrontierReview(session, candidateDigest);
  const latestReview = latestFrontierReview(session);
  return {
    status: readiness.pending.length === 0
      ? "not_required"
      : currentReview?.data.verdict === "validation_required"
        ? "validation_required"
        : readiness.blockedReview
          ? "changes_required"
          : "review_requested",
    reviewState: currentReview ? "current" : latestReview ? "stale" : "none",
    reviewBasisDigest: reviewBasisDigest(session, undefined, candidateDigest),
    frontierRevision: frontier.revision,
    stateDigest: frontier.currentStateDigest,
    changedPaths: [...frontier.changedPaths],
    missingValidationPaths: validationTelemetry.missingPaths,
    ...(readiness.blockedReview
      ? { findings: [...readiness.blockedReview.data.findings] }
      : {}),
    ...(readiness.retryableReview
      ? { findings: [...readiness.retryableReview.data.findings] }
      : {})
  };
}
