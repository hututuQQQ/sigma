import type { ToolDescriptor } from "agent-protocol";
import { isToolAllowed } from "agent-tools";
import type { EffectRunnerOptions } from "./effect-runner.js";
import { descriptorsAvailableToModel } from "./model-tool-availability.js";
import { profileAllowsTool } from "./profile-policy.js";
import {
  completionRepairPhase,
  descriptorsAllowedForRepair,
  type CompletionRepairPhase
} from "./tool-turn-policy.js";
import type { RuntimeSession } from "./types.js";

export interface TurnDescriptorProjection {
  repairPhase: CompletionRepairPhase;
  repairPending: boolean;
  modelDescriptors: readonly ToolDescriptor[];
  descriptors: readonly ToolDescriptor[];
  terminalDescriptors: readonly ToolDescriptor[];
}

export function turnDescriptorProjection(
  options: EffectRunnerOptions,
  session: RuntimeSession
): TurnDescriptorProjection {
  const repairPhase = completionRepairPhase(session);
  const registered = options.runtime.tools.descriptors();
  const modelDescriptors = options.runtime.tools.modelDescriptors?.() ?? registered;
  const stageInternal = repairPhase === "no_change_confirmation"
    ? registered.filter((item) => item.name === "confirm_no_change") : [];
  const terminalDescriptors = repairPhase === "no_change_confirmation"
    ? [] : registered.filter((item) => item.name === "runtime_finalize");
  const ordinary = descriptorsAvailableToModel(session, modelDescriptors).filter((item) =>
    isToolAllowed(item, session.durable.mode) && profileAllowsTool(session, item));
  const available = [...new Map([...ordinary, ...stageInternal]
    .map((item) => [item.name, item])).values()];
  return {
    repairPhase,
    repairPending: repairPhase !== "none",
    modelDescriptors,
    descriptors: descriptorsAllowedForRepair(available, repairPhase),
    terminalDescriptors
  };
}
