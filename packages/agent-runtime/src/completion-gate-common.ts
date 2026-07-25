import { createHash } from "node:crypto";
import type { DecisionAuthority } from "agent-protocol";
import type { RuntimeSession } from "./types.js";

const ADVISORY_PREFIX = "[sigma-completion-advisory:";

export function completionGateDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function completionFindingText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface CompletionCandidate {
  answer: string;
  digest: string;
}

export function completionCandidate(session: RuntimeSession): CompletionCandidate | undefined {
  const proposed = session.durable.state.proposedOutcome;
  const answer = proposed?.kind === "completed"
    ? proposed.message.trim()
    : [...session.durable.state.messages].reverse().find((message) =>
        message.role === "assistant"
        && (message.toolCalls?.length ?? 0) === 0
        && message.content.trim().length > 0)?.content.trim() ?? "";
  return answer
    ? { answer, digest: completionGateDigest({ answer }) }
    : undefined;
}

export type CompletionGateDecision =
  | {
      action: "complete";
      validationStatus: "not_needed" | "passed" | "failed" | "unverified";
      statusNote?: string;
      authority: DecisionAuthority;
    }
  | {
      action: "continue";
      basisDigest: string;
      message: string;
      authority: DecisionAuthority;
    }
  | {
      action: "fail";
      code: "strict_policy_failure" | "verification_failed" | "verification_unavailable";
      message: string;
      authority: DecisionAuthority;
    };

export function hasCompletionAdvisory(
  session: RuntimeSession,
  basisDigest: string
): boolean {
  const marker = `${ADVISORY_PREFIX}${basisDigest}]`;
  return session.durable.state.messages.some((message) =>
    message.role === "developer" && message.content.includes(marker));
}

export function completionAdvisory(
  basisDigest: string,
  body: string,
  authority: DecisionAuthority = "user_policy"
): Extract<CompletionGateDecision, { action: "continue" }> {
  return {
    action: "continue",
    basisDigest,
    authority,
    message: `${ADVISORY_PREFIX}${basisDigest}]\n${body}`
  };
}
