import { createHash } from "node:crypto";
import type { TaskControlStateV1 } from "./task-control-state.js";
import { openTaskObligation } from "./task-control.js";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function restorationObligation(
  control: TaskControlStateV1,
  revision: number,
  nextDecisionCode?: string
): TaskControlStateV1 {
  return openTaskObligation(control, {
    kind: "restoration",
    stage: "restore",
    basisDigest: digest({
      kind: "restoration",
      goalEpoch: control.goalEpoch,
      nextDecisionCode: nextDecisionCode ?? null
    }),
    openedRevision: revision,
    attempts: 0,
    ...(nextDecisionCode ? { nextDecisionCode } : {})
  });
}
