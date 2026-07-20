import { createHash } from "node:crypto";

export interface CompletionReviewCandidateV1 {
  message: string;
  summary: string;
  warnings: string[];
}

/** Independent of either solver or reviewer tokenization. The serialized cap
 * bounds exactly the candidate bytes embedded in the reviewer JSON payload. */
export const COMPLETION_CANDIDATE_MAX_SERIALIZED_UTF8_BYTES = 8_192;
export const COMPLETION_CANDIDATE_MAX_TEXT_CODE_UNITS = 8_192;
export const COMPLETION_CANDIDATE_MAX_WARNINGS = 32;

export interface CompletionCandidateEnvelopeFailureV1 {
  code: "completion_candidate_too_large";
  message: string;
  serializedUtf8Bytes: number;
  textCodeUnits: number;
  warningCount: number;
}

export function completionCandidateEnvelopeFailure(
  candidate: CompletionReviewCandidateV1
): CompletionCandidateEnvelopeFailureV1 | undefined {
  const serializedUtf8Bytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
  const textCodeUnits = candidate.message.length + candidate.summary.length
    + candidate.warnings.reduce((total, warning) => total + warning.length, 0);
  const warningCount = candidate.warnings.length;
  if (serializedUtf8Bytes <= COMPLETION_CANDIDATE_MAX_SERIALIZED_UTF8_BYTES
    && textCodeUnits <= COMPLETION_CANDIDATE_MAX_TEXT_CODE_UNITS
    && warningCount <= COMPLETION_CANDIDATE_MAX_WARNINGS) return undefined;
  return {
    code: "completion_candidate_too_large",
    message: "Completion candidate exceeds the bounded delivery envelope; provide a shorter final response.",
    serializedUtf8Bytes,
    textCodeUnits,
    warningCount
  };
}

export function completionCandidateDigest(candidate: CompletionReviewCandidateV1): string {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    message: candidate.message,
    summary: candidate.summary,
    warnings: candidate.warnings
  })).digest("hex");
}
