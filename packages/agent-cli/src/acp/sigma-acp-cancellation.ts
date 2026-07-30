import type { ResolvedSession } from "./sigma-acp-shared.js";

export function cancellationReason(signal: AbortSignal, fallback: string): string {
  return signal.reason instanceof Error ? signal.reason.message : fallback;
}

export async function cancelResolvedSession(
  resolved: ResolvedSession,
  reason: string
): Promise<void> {
  await resolved.handle.runtime.command({
    type: "cancel",
    sessionId: resolved.record.runtimeSessionId,
    reason
  });
}
