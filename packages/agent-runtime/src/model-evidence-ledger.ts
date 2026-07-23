import type { ContextItem } from "agent-protocol";
import { approximateTokens } from "agent-context";
import {
  currentFrontierValidationStatus,
  frontierValidationReadiness,
  latestFrontierReview
} from "./mutation-evidence.js";
import type { RuntimeSession } from "./types.js";

function findingText(value: unknown): string {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  return rendered.length <= 1_000 ? rendered : `${rendered.slice(0, 1_000)}…`;
}

/** Model-visible factual status. Evidence IDs and final policy decisions stay runtime-owned. */
export function evidenceLedger(session: RuntimeSession): ContextItem {
  const frontier = session.durable.state.mutationFrontier;
  const validation = currentFrontierValidationStatus(session);
  const coverageTelemetry = frontierValidationReadiness(session);
  const review = latestFrontierReview(session);
  const reviewMode = session.services.profile?.profile.mutationPolicy.reviewMode ?? "advisory";
  const changed = frontier.changedPaths.slice(0, 200);
  const validationStatus = frontier.changedPaths.length === 0
    ? "not needed"
    : !validation.hasRecord
      ? "not run for the current frontier"
      : validation.passed
        ? "passed for the current frontier"
        : validation.latestFailed
          ? "failed for the current frontier"
          : "recorded but incomplete for the current frontier";
  const lines = [
    "Current durable status (facts, not a prescribed next action):",
    `- mutation frontier revision: ${frontier.revision}`,
    `- net changed paths (${frontier.changedPaths.length}): ${changed.length > 0 ? changed.join(", ") : "none"}`,
    ...(changed.length < frontier.changedPaths.length
      ? [`- ${frontier.changedPaths.length - changed.length} additional paths omitted from this display`]
      : []),
    `- validation: ${validationStatus}`,
    ...(coverageTelemetry.missingClaims.length > 0
      ? [`- telemetry-only inferred validation claim gaps: ${coverageTelemetry.missingClaims.join(", ")}`]
      : []),
    ...(coverageTelemetry.missingPaths.length > 0
      ? [`- telemetry-only inferred validation path gaps: ${coverageTelemetry.missingPaths.join(", ")}`]
      : []),
    ...(validation.latestFailed
      ? [`- latest failed validation: ${validation.latestFailed.summary}`]
      : []),
    `- independent review mode: ${reviewMode}`,
    ...(review
      ? [
          `- latest review: ${review.data.verdict} (${review.status})`,
          ...review.data.findings.slice(0, 12).map((item) => `  - ${findingText(item)}`)
        ]
      : []),
    reviewMode === "required"
      ? "- Strict completion requires successful current-frontier validation and reviewer approval of the same completion candidate."
      : "- Standard completion may report failed or unverified validation honestly; a missing record produces one advisory.",
    "When work is complete, stop naturally with the user-facing summary."
  ];
  const content = lines.join("\n");
  return {
    id: `runtime:completion-status:${session.durable.runId}:${frontier.revision}:${session.durable.state.evidence.length}`,
    authority: "runtime",
    provenance: "completion_status",
    content,
    tokenCount: approximateTokens(content),
    priority: 9_900
  };
}
