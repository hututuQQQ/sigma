import type { KernelState } from "./state.js";

/** Only trusted durable dimensions can forgive previous output truncation.
 * Messages, model deltas, call IDs, timestamps, and raw output are excluded. */
export function trustedProgressFingerprint(state: KernelState): string {
  return JSON.stringify({
    frontier: [
      state.mutationFrontier.revision,
      state.mutationFrontier.currentStateDigest,
      [...state.mutationFrontier.changedPaths].sort()
    ],
    semantic: [state.semanticProgress.workspaceChanges, state.semanticProgress.durableEvidence],
    evidence: state.progressEvidenceDigest ?? null,
    processes: [...state.activeProcessIds].sort()
  });
}

export function stickyLengthDebt(state: KernelState): number {
  const debt = state.lengthFinishDebt ?? state.continuationAttempts;
  if (debt <= 0) return 0;
  return state.lengthProgressFingerprint === undefined
    || state.lengthProgressFingerprint === trustedProgressFingerprint(state) ? debt : 0;
}

/** The single long continuation has already been spent when a tool turn reset
 * the consecutive counter but did not advance any trusted progress dimension. */
export function lengthConvergenceRequired(state: KernelState): boolean {
  const debt = stickyLengthDebt(state);
  return debt >= 2 || (debt > 0 && state.continuationAttempts === 0);
}
