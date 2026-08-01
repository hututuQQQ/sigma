import type { CheckpointRef } from "agent-protocol";
import type { EffectRunnerOptions } from "./effect-runner.js";
import type { RuntimeSession } from "./types.js";
import { executionFailureCode } from "./tool-transaction-support.js";

export async function settleCheckpointAfterToolFailure(
  control: EffectRunnerOptions["control"],
  session: RuntimeSession,
  checkpoint: CheckpointRef,
  executionError: unknown
): Promise<void> {
  try {
    const recovery = await control.recoverOpen(session);
    if (recovery.kind !== "needs_input") return;
    session.recovery.openCheckpointRecovery = {
      checkpointId: recovery.checkpointId,
      currentManifestDigest: recovery.currentManifestDigest
    };
    if (
      executionFailureCode(executionError) === "effect_plan_violation"
      && recovery.checkpointId === checkpoint.checkpointId
    ) {
      await control.restorePolicyViolation(
        session,
        recovery.checkpointId,
        recovery.currentManifestDigest
      );
      session.recovery.openCheckpointRecovery = undefined;
    }
  } catch (recoveryError) {
    const durableHead = session.durable.state.checkpointHead;
    if (durableHead?.checkpointId === checkpoint.checkpointId && durableHead.status === "sealed") {
      session.recovery.openCheckpointRecovery = undefined;
      throw Object.assign(new AggregateError(
        [executionError],
        "The mutation checkpoint is sealed, but its evidence could not be reconciled.",
        { cause: recoveryError }
      ), { code: "checkpoint_evidence_failed" });
    }
    session.recovery.openCheckpointRecovery ??= {
      checkpointId: checkpoint.checkpointId,
      // A preimage digest cannot authorize keeping/restoring a changed
      // postimage; it only provides a fail-closed placeholder until a later
      // inspection refreshes the recovery state.
      currentManifestDigest: checkpoint.preManifestDigest
    };
    throw Object.assign(new AggregateError(
      [executionError],
      "Failed to settle the mutation checkpoint after tool failure.",
      { cause: recoveryError }
    ), { code: "checkpoint_recovery_failed" });
  }
}
