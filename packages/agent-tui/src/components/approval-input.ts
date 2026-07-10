export interface ApprovalDecision {
  requestId: string;
  decision: "allow" | "deny" | "always_allow";
}

export function parseApprovalInput(text: string, fallbackRequestId: string): ApprovalDecision | null {
  const explicit = text.match(/^\/approve\s+(\S+)\s+(\S+)$/i);
  const answer = (explicit?.[2] ?? text).toLowerCase();
  const decision = answer === "a" || answer === "always" ? "always_allow"
    : answer === "y" || answer === "yes" ? "allow"
      : answer === "n" || answer === "no" ? "deny" : null;
  if (!decision) {
    if (explicit) throw new Error("Approval decision must be y, n, or always.");
    return null;
  }
  return { requestId: explicit?.[1] ?? fallbackRequestId, decision };
}
