import type { JsonValue, ReviewEvidence } from "agent-protocol";
import type { KernelState } from "./state.js";

const MAX_REVIEW_FINDINGS = 8;
const MAX_REVIEW_PROJECTION_CHARS = 4 * 1024;

function currentFrontierReview(state: KernelState): ReviewEvidence | undefined {
  const frontier = state.mutationFrontier;
  return state.evidence.filter((item): item is ReviewEvidence => item.kind === "review"
    && item.data.frontierRevision === frontier.revision
    && item.data.stateDigest === frontier.currentStateDigest
    && (item.data.reviewBasisVersion === 2 || item.data.reviewBasisVersion === 3)).at(-1);
}

export function boundedReviewFindings(review: ReviewEvidence): string {
  const source = review.data.findings.length > 0 ? review.data.findings : [review.summary];
  const lines: string[] = [];
  let chars = 0;
  for (const finding of source.slice(0, MAX_REVIEW_FINDINGS)) {
    const raw = typeof finding === "string" ? finding : JSON.stringify(finding);
    const remaining = MAX_REVIEW_PROJECTION_CHARS - chars;
    if (remaining <= 4) break;
    const line = `- ${raw.slice(0, Math.max(1, remaining - 2))}`;
    lines.push(line);
    chars += line.length + 1;
  }
  const omitted = source.length - lines.length;
  if (omitted > 0 && chars < MAX_REVIEW_PROJECTION_CHARS) {
    lines.push(`- ... ${omitted} additional finding${omitted === 1 ? "" : "s"} omitted; full evidence: ${review.evidenceId}`);
  }
  return lines.join("\n");
}

function actionableErrorFinding(value: JsonValue): boolean {
  if (value && typeof value === "object" && !Array.isArray(value)
    && Object.hasOwn(value, "actionable") && Object.hasOwn(value, "severity")) {
    return value.actionable === true && value.severity === "error";
  }
  // Legacy durable findings were arbitrary JSON. Preserve the conservative
  // interpretation used by the runtime reviewer when no typed severity exists.
  return true;
}

export function actionableReview(state: KernelState): ReviewEvidence | undefined {
  const review = currentFrontierReview(state);
  return review
    && review.status === "failed"
    && review.data.verdict === "changes_requested"
    && review.data.failureKind === undefined
    && review.data.findings.some(actionableErrorFinding)
    ? review : undefined;
}

export function advisoryReviewWarnings(state: KernelState): string {
  const review = currentFrontierReview(state);
  if (!review || (review.status === "passed" && review.data.findings.length === 0)) return "";
  return `\n\nIndependent review findings:\n${boundedReviewFindings(review)}`;
}
