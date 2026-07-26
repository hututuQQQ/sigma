import { createHash } from "node:crypto";
import type { ContextItem } from "agent-protocol";
import { approximateTokens, fitApproximateTokens } from "agent-context";
import {
  currentFrontierValidationStatus,
  frontierValidationReadiness,
  latestFrontierReview
} from "./mutation-evidence.js";
import type { RuntimeSession } from "./types.js";

export const MAX_COMPLETION_STATUS_TOKENS = 2_048;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function findingText(value: unknown): string {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  return rendered.length <= 1_000 ? rendered : `${rendered.slice(0, 1_000)}…`;
}

function topLevelSummary(paths: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const normalized = path.replaceAll("\\", "/");
    const top = normalized.includes("/") ? normalized.slice(0, normalized.indexOf("/")) : "(root)";
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  return [...counts].sort(([left], [right]) => left.localeCompare(right))
    .map(([directory, count]) => `${directory}:${count}`).join(", ") || "none";
}

function currentValidationLabel(
  hasChanges: boolean,
  validation: ReturnType<typeof currentFrontierValidationStatus>
): string {
  if (!hasChanges) return "not needed";
  if (!validation.hasRecord) return "not run for the current frontier";
  if (validation.passed) return "passed for the current frontier";
  if (validation.latestFailed) return "failed for the current frontier";
  return "recorded but incomplete for the current frontier";
}

function workspacePathLines(paths: readonly string[]): string[] {
  const representative = paths.slice(0, 32);
  return [
    `- net changed paths: ${paths.length}`,
    `- changed path digest: ${digest(paths)}`,
    `- top-level distribution: ${topLevelSummary(paths)}`,
    `- representative changed paths (up to 32): ${
      representative.length > 0 ? representative.join(", ") : "none"
    }`,
    ...(representative.length < paths.length
      ? [`- ${paths.length - representative.length} additional paths are available through read_workspace_frontier`]
      : [])
  ];
}

function environmentPathLines(paths: readonly string[]): string[] {
  return [
    `- enclosing-container changed paths: ${paths.length}`,
    `- enclosing-container path digest: ${digest(paths)}`,
    `- representative enclosing-container paths (up to 32): ${
      paths.length > 0 ? paths.slice(0, 32).join(", ") : "none"
    }`
  ];
}

function coverageTelemetryLines(
  coverage: ReturnType<typeof frontierValidationReadiness>
): string[] {
  return [
    ...(coverage.missingClaims.length > 0
      ? [`- telemetry-only inferred validation claim gaps: ${coverage.missingClaims.slice(0, 16).join(", ")}`]
      : []),
    ...(coverage.missingPaths.length > 0
      ? [`- non-authoritative declared-subject gaps (${coverage.missingPaths.length}): ${coverage.missingPaths.slice(0, 16).join(", ")}`]
      : [])
  ];
}

function reviewStatusLines(
  review: ReturnType<typeof latestFrontierReview>
): string[] {
  if (!review) return [];
  return [
    `- latest review: ${review.data.verdict} (${review.status})`,
    ...review.data.findings.slice(0, 12).map((item) => `  - ${findingText(item)}`)
  ];
}

/** Model-visible factual status. Evidence IDs and final policy decisions stay runtime-owned. */
export function evidenceLedger(session: RuntimeSession): ContextItem {
  const frontier = session.durable.state.mutationFrontier;
  const validation = currentFrontierValidationStatus(session);
  const coverageTelemetry = frontierValidationReadiness(session);
  const review = latestFrontierReview(session);
  const reviewMode = session.services.profile?.profile.mutationPolicy.reviewMode ?? "advisory";
  const changedPaths = [...frontier.changedPaths].sort();
  const environmentChangedPaths = [...(frontier.environmentChangedPaths ?? [])].sort();
  const validationStatus = currentValidationLabel(
    changedPaths.length + environmentChangedPaths.length > 0,
    validation
  );
  const lines = [
    "Current durable status (facts, not a prescribed next action):",
    `- mutation frontier revision: ${frontier.revision}`,
    ...workspacePathLines(changedPaths),
    ...environmentPathLines(environmentChangedPaths),
    `- validation: ${validationStatus}`,
    ...coverageTelemetryLines(coverageTelemetry),
    ...(validation.latestFailed
      ? [`- latest failed validation: ${validation.latestFailed.summary}`]
      : []),
    `- independent review mode: ${reviewMode}`,
    ...reviewStatusLines(review),
    reviewMode === "required"
      ? "- Strict completion requires current-frontier reviewer approval backed by at least one reviewer-executed check."
      : reviewMode === "advisory"
        ? "- Standard completion uses plan and validation evidence. Independent review runs only when explicitly requested."
        : "- Standard completion uses plan and validation evidence; independent review is disabled.",
    "When work is complete, stop naturally with the user-facing summary."
  ];
  const stateDigest = digest({
    frontier,
    validation: validation.validations.map((item) => ({
      evidenceId: item.evidenceId, status: item.status, summary: item.summary
    })),
    review: review ? { evidenceId: review.evidenceId, status: review.status } : null,
    reviewMode
  });
  const content = fitApproximateTokens(
    `${lines.join("\n")}\nCompletion/frontier state digest: ${stateDigest}`,
    MAX_COMPLETION_STATUS_TOKENS
  );
  return {
    id: `runtime:completion-status:${stateDigest}`,
    authority: "runtime",
    provenance: "completion_status",
    content,
    tokenCount: approximateTokens(content),
    priority: 9_900,
    cacheKey: stateDigest
  };
}
