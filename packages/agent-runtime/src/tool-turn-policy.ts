import type { ToolDescriptor, ToolEffect } from "agent-protocol";
import type { RuntimeSession } from "./types.js";

export type CompletionRepairPhase =
  | "none"
  | "focused"
  | "generic_repair"
  | "completion_evidence"
  | "review_mutate"
  | "review_validate"
  | "review_review"
  | "capability_prepare"
  | "capability_re_probe"
  | "repository_inspect"
  | "repository_select"
  | "repository_transact"
  | "repository_validate"
  | "terminal";

const REVIEW_REPAIR_PHASES = {
  mutate: "review_mutate",
  validate: "review_validate",
  re_review: "review_review"
} as const;

const REPOSITORY_CONFLICT_TOOL_NAMES = new Set([
  "read", "write", "edit", "apply_patch", "delete_file"
]);

function obligationRepairPhase(session: RuntimeSession): CompletionRepairPhase | null {
  const obligation = session.durable.state.taskControl.obligation;
  if (obligation?.kind === "review_repair") return REVIEW_REPAIR_PHASES[obligation.stage];
  if (obligation?.kind === "capability_recovery") {
    return obligation.stage === "prepare" ? "capability_prepare" : "capability_re_probe";
  }
  if (obligation?.kind === "repository_recovery") {
    return `repository_${obligation.stage}`;
  }
  if (obligation?.kind === "completion_evidence") {
    return obligation.stage === "acquire" ? "completion_evidence" : "terminal";
  }
  if (obligation?.kind === "terminal_resolution" || obligation?.kind === "user_decision") return "terminal";
  return null;
}

export function completionRepairPhase(session: RuntimeSession): CompletionRepairPhase {
  const control = session.durable.state.taskControl;
  const obligationPhase = obligationRepairPhase(session);
  if (obligationPhase) return obligationPhase;
  if (control.phase === "terminal") return "terminal";
  if (control.phase === "repair_only") return "generic_repair";
  return control.phase === "focused" ? "focused" : "none";
}

function terminalEffect(effect: ToolEffect): boolean {
  return effect === "outcome.propose" || effect === "outcome.report_blocked" || effect === "outcome.request_input";
}

function userInputAllowed(session: RuntimeSession): boolean {
  return session.durable.state.taskControl.obligation?.kind === "user_decision";
}

type DirectedRepairPhase = Extract<CompletionRepairPhase,
  "capability_prepare" | "capability_re_probe" | `repository_${string}`>;
type BaseRepairPhase = Exclude<CompletionRepairPhase, DirectedRepairPhase>;

function baseDescriptorAllowedForRepair(
  session: RuntimeSession,
  descriptor: ToolDescriptor,
  phase: BaseRepairPhase
): boolean {
  switch (phase) {
    case "none":
    case "focused": return descriptor.name !== "environment_prepare";
    case "generic_repair": return descriptor.possibleEffects.some((effect) =>
      effect === "filesystem.write" || effect === "repository.write"
        || effect === "validation" || terminalEffect(effect));
    case "completion_evidence":
      return descriptor.name === "validate" || descriptor.name === "request_review"
        || descriptor.possibleEffects.includes("filesystem.read");
    case "review_mutate": return descriptor.possibleEffects.includes("filesystem.write");
    case "review_validate": return descriptor.possibleEffects.includes("validation");
    case "review_review": return descriptor.name === "request_review";
    case "terminal":
      if (descriptor.name === "request_user_input") return userInputAllowed(session);
      return descriptor.possibleEffects.length > 0 && descriptor.possibleEffects.every(terminalEffect);
  }
}

export function descriptorAllowedForRepair(
  session: RuntimeSession,
  descriptor: ToolDescriptor,
  phase = completionRepairPhase(session)
): boolean {
  if (phase === "capability_prepare") return descriptor.name === "environment_prepare";
  if (phase === "capability_re_probe") {
    const obligation = session.durable.state.taskControl.obligation;
    return obligation?.kind === "capability_recovery"
      && descriptor.name === obligation.probeToolName;
  }
  const repository = repositoryDescriptorAllowed(session, descriptor, phase);
  if (repository !== undefined) return repository;
  return baseDescriptorAllowedForRepair(session, descriptor, phase as BaseRepairPhase);
}

function repositoryDescriptorAllowed(
  session: RuntimeSession,
  descriptor: ToolDescriptor,
  phase: CompletionRepairPhase
): boolean | undefined {
  if (phase === "repository_inspect" || phase === "repository_select") {
    return descriptor.name === "repository_inspect";
  }
  if (phase === "repository_transact") {
    const obligation = session.durable.state.taskControl.obligation;
    if (obligation?.kind !== "repository_recovery") return false;
    if (descriptor.name === "git_transaction") return true;
    return Boolean(obligation.transactionId && obligation.scopePaths?.length)
      && REPOSITORY_CONFLICT_TOOL_NAMES.has(descriptor.name);
  }
  if (phase === "repository_validate") {
    return descriptor.name === "repository_inspect"
      || descriptor.possibleEffects.includes("validation");
  }
  return undefined;
}

function baseEffectsAllowedForRepair(
  effects: readonly ToolEffect[],
  phase: BaseRepairPhase
): boolean {
  switch (phase) {
    case "none":
    case "focused": return true;
    case "generic_repair": return effects.some((effect) =>
      effect === "filesystem.write" || effect === "repository.write"
        || effect === "validation" || terminalEffect(effect));
    case "completion_evidence":
      return effects.includes("validation") || effects.includes("filesystem.read")
        || effects.includes("runtime.control");
    case "review_mutate": return effects.includes("filesystem.write");
    case "review_validate": return effects.includes("validation");
    case "review_review": return effects.length === 1 && effects[0] === "runtime.control";
    case "terminal": return effects.length > 0 && effects.every(terminalEffect);
  }
}

export function effectsAllowedForRepair(
  session: RuntimeSession,
  effects: readonly ToolEffect[],
  phase = completionRepairPhase(session)
): boolean {
  if (phase === "capability_prepare") return effects.includes("process.spawn")
    && effects.includes("network") && effects.includes("open_world");
  if (phase === "capability_re_probe") return effects.includes("process.spawn")
    || effects.includes("process.spawn.readonly");
  const repository = repositoryEffectsAllowed(effects, phase);
  return repository ?? baseEffectsAllowedForRepair(effects, phase as BaseRepairPhase);
}

function repositoryEffectsAllowed(
  effects: readonly ToolEffect[],
  phase: CompletionRepairPhase
): boolean | undefined {
  if (phase === "repository_inspect" || phase === "repository_select") {
    return effects.includes("filesystem.read")
      && !effects.includes("filesystem.write")
      && !effects.includes("repository.write");
  }
  if (phase === "repository_transact") return effects.includes("repository.write")
    || effects.includes("filesystem.read") || effects.includes("filesystem.write");
  if (phase === "repository_validate") return effects.includes("validation")
    || effects.includes("filesystem.read");
  return undefined;
}

export function descriptorsAllowedForRepair(
  session: RuntimeSession,
  descriptors: readonly ToolDescriptor[],
  phase = completionRepairPhase(session)
): ToolDescriptor[] {
  return descriptors.filter((descriptor) => descriptorAllowedForRepair(session, descriptor, phase));
}

export function maximumTaskControlCalls(session: RuntimeSession): number {
  return completionRepairPhase(session) === "none" ? Number.MAX_SAFE_INTEGER : 1;
}
