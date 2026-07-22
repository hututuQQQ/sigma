import type { ContextItem } from "agent-protocol";
import { approximateTokens } from "agent-context";
import { currentFrontierReview, frontierValidationReadiness } from "./mutation-evidence.js";
import type { RuntimeSession } from "./types.js";

function findingText(value: unknown): string {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  return rendered.length <= 1_000 ? rendered : `${rendered.slice(0, 1_000)}…`;
}

/** Model-visible V5 completion state. Internal evidence and checkpoint IDs are
 * deliberately absent: the runtime owns their association and final handoff. */
export function evidenceLedger(session: RuntimeSession): ContextItem {
  const frontier = session.durable.state.mutationFrontier;
  const validation = frontierValidationReadiness(session);
  const review = currentFrontierReview(session);
  const reviewMode = session.services.profile?.profile.mutationPolicy.reviewMode ?? "advisory";
  const changed = frontier.changedPaths.slice(0, 200);
  const lines = [
    "Completion status (runtime-owned; do not supply evidence IDs):",
    `- final mutation revision: ${frontier.revision}`,
    `- net changed paths (${frontier.changedPaths.length}): ${changed.length > 0 ? changed.join(", ") : "none"}`,
    ...(changed.length < frontier.changedPaths.length ? [`- ${frontier.changedPaths.length - changed.length} additional paths omitted from this display`] : []),
    `- semantic validation: ${frontier.changedPaths.length === 0 ? "not required" : validation.ready ? "passed for every net changed path" : "blocking"}`,
    ...(validation.missingClaims.length > 0
      ? [`- required validation claim kinds still missing/failed: ${validation.missingClaims.join(", ")}`] : []),
    ...(validation.missingPaths.length > 0 ? [`- validation still missing/failed for: ${validation.missingPaths.join(", ")}`] : []),
    ...(validation.latestFailed ? [`- latest failed validation: ${validation.latestFailed.summary}`] : []),
    `- independent review mode: ${reviewMode}`,
    ...(review ? [`- latest review: ${review.data.verdict} (${review.status})`,
      ...review.data.findings.slice(0, 12).map((item) => `  - ${findingText(item)}`)] : []),
    "When work is complete, stop naturally with the final user-facing summary. The runtime completion coordinator will evaluate assurance and review gates. If validation cannot be repaired after concrete attempts, call report_blocked. Use request_user_input only for a real user decision."
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
