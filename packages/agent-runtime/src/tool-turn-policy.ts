import type { JsonValue, ToolDescriptor, ToolEffect } from "agent-protocol";
import type { RuntimeSession } from "./types.js";

export type CompletionRepairPhase =
  | "none"
  | "protocol_repair"
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
  | "restoration_quiesce"
  | "restoration_restore"
  | "restoration_confirm"
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
  if (!obligation) return null;
  switch (obligation.kind) {
    case "review_repair": return REVIEW_REPAIR_PHASES[obligation.stage];
    case "capability_recovery":
      return obligation.stage === "prepare" ? "capability_prepare" : "capability_re_probe";
    case "repository_recovery": return `repository_${obligation.stage}`;
    case "restoration": return `restoration_${obligation.stage}`;
    case "completion_evidence":
      return obligation.stage === "acquire" ? "completion_evidence" : "terminal";
    case "terminal_resolution":
    case "user_decision": return "terminal";
    case "process_settlement": return "generic_repair";
  }
}

export function completionRepairPhase(session: RuntimeSession): CompletionRepairPhase {
  const control = session.durable.state.taskControl;
  const obligationPhase = obligationRepairPhase(session);
  if (obligationPhase) return obligationPhase;
  if (control.phase === "focused"
    && control.episode.noProgressBatches < 2
    && control.policyCorrection?.failureCode === "tool_arguments_invalid") {
    return "protocol_repair";
  }
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
  "capability_prepare" | "capability_re_probe" | `repository_${string}` | `restoration_${string}`>;
type BaseRepairPhase = Exclude<CompletionRepairPhase, DirectedRepairPhase>;

function baseDescriptorAllowedForRepair(
  session: RuntimeSession,
  descriptor: ToolDescriptor,
  phase: BaseRepairPhase
): boolean {
  switch (phase) {
    case "none":
    case "protocol_repair":
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
  if (phase === "restoration_quiesce") {
    return descriptor.name === "process_terminate" || descriptor.name === "process_list";
  }
  if (phase === "restoration_restore") return descriptor.name === "restore_run_changes";
  if (phase === "restoration_confirm") return descriptor.name === "confirm_run_restored";
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
    case "protocol_repair":
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
  if (phase === "restoration_quiesce") return effects.includes("runtime.control")
    || effects.includes("process.spawn");
  if (phase === "restoration_restore") return effects.includes("checkpoint.restore")
    && effects.includes("filesystem.write");
  if (phase === "restoration_confirm") return effects.includes("runtime.control")
    && effects.includes("filesystem.read") && !effects.includes("filesystem.write");
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
  return descriptors
    .filter((descriptor) => descriptorAllowedForRepair(session, descriptor, phase))
    .map((descriptor) => projectedDirectedDescriptor(session, descriptor, phase));
}

function schemaObject(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue> : null;
}

function projectedConflictMutationDescriptor(
  descriptor: ToolDescriptor,
  scopePaths: readonly string[]
): ToolDescriptor {
  if (!descriptor.possibleEffects.includes("filesystem.write")) return descriptor;
  const description = `${descriptor.description} During repository conflict resolution, writes are limited to: ${scopePaths.join(", ")}.`;
  const properties = schemaObject(descriptor.inputSchema.properties);
  const pathSchema = schemaObject(properties?.path);
  if (!properties || !pathSchema) return { ...descriptor, description };
  const { const: _priorConst, enum: _priorEnum, ...basePathSchema } = pathSchema;
  const projectedPath: Record<string, JsonValue> = scopePaths.length === 1
    ? { ...basePathSchema, const: scopePaths[0]! }
    : { ...basePathSchema, enum: [...scopePaths] };
  return {
    ...descriptor,
    description,
    inputSchema: {
      ...descriptor.inputSchema,
      properties: { ...properties, path: projectedPath }
    }
  };
}

function projectedDirectedDescriptor(
  session: RuntimeSession,
  descriptor: ToolDescriptor,
  phase: CompletionRepairPhase
): ToolDescriptor {
  if (phase !== "repository_transact") return descriptor;
  const obligation = session.durable.state.taskControl.obligation;
  if (obligation?.kind !== "repository_recovery") return descriptor;
  if (obligation.transactionId && obligation.scopePaths?.length) {
    if (descriptor.name !== "git_transaction") {
      return projectedConflictMutationDescriptor(descriptor, obligation.scopePaths);
    }
    return {
      ...descriptor,
      description: "Continue or abort only the active broker-journaled recovery transaction. Continue accepts add operations only for the broker-observed conflict paths; non-conflicting changes are already applied."
    };
  }
  if (descriptor.name !== "git_transaction"
    || !obligation.candidateId || !obligation.selectionEvidenceId) return descriptor;
  return {
    ...descriptor,
    description: "Recover the runtime-selected Git candidate with its bound selection evidence. The action and evidence fields are fixed by task control; call git_transaction exactly as projected.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", const: "recover" },
        candidateId: { type: "string", const: obligation.candidateId },
        selectionEvidenceId: { type: "string", const: obligation.selectionEvidenceId }
      },
      required: ["action", "candidateId", "selectionEvidenceId"],
      additionalProperties: false
    }
  };
}

export function maximumTaskControlCalls(session: RuntimeSession): number {
  return ["none", "protocol_repair"].includes(completionRepairPhase(session))
    ? Number.MAX_SAFE_INTEGER : 1;
}
