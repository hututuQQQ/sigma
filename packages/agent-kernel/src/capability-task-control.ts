import { createHash } from "node:crypto";
import type { TaskControlStateV1 } from "./task-control-state.js";
import { openTaskObligation } from "./task-control.js";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export interface CapabilityRecoveryObservationV1 {
  opportunityId: string;
  requestedExecutable: string;
  probeToolName: "exec" | "validate" | "process_spawn";
  runtimeClosureDigest: string;
}

export function capabilityRecoveryObligation(
  control: TaskControlStateV1,
  revision: number,
  observation: CapabilityRecoveryObservationV1
): TaskControlStateV1 {
  return openTaskObligation(control, {
    kind: "capability_recovery",
    stage: "prepare",
    basisDigest: digest({
      kind: "capability_recovery",
      goalEpoch: control.goalEpoch,
      ...observation
    }),
    openedRevision: revision,
    attempts: 0,
    ...observation
  });
}

export function advanceCapabilityRecovery(
  control: TaskControlStateV1,
  revision: number,
  runtimeClosureDigest: string
): TaskControlStateV1 {
  const obligation = control.obligation;
  if (obligation?.kind !== "capability_recovery" || obligation.stage !== "prepare") return control;
  return openTaskObligation(control, {
    ...obligation,
    stage: "re_probe",
    basisDigest: digest({
      priorBasis: obligation.basisDigest,
      stage: "re_probe",
      runtimeClosureDigest,
      goalEpoch: control.goalEpoch
    }),
    openedRevision: revision,
    attempts: obligation.attempts + 1,
    runtimeClosureDigest
  });
}
