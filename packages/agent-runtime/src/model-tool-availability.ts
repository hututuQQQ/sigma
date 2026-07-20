import type {
  JsonValue,
  ModelToolCall,
  ToolCallPlan,
  ToolDescriptor,
  ToolReceipt
} from "agent-protocol";
import type { ActiveModelTurn, PendingTool } from "agent-kernel";
import { assertDescriptorArguments } from "agent-tools";
import { failed } from "./tool-receipt.js";
import { capabilityRetryExhausted } from "./capability-failure-convergence.js";
import type { RuntimeSession } from "./types.js";
import { terminalOnlyToolDescriptor, terminalOnlyToolEffects } from "./terminal-tool-policy.js";

const PROCESS_CONTROL_TOOLS = new Set([
  "process_poll", "process_write", "process_terminate", "process_handoff"
]);
const CHILD_CONTROL_TOOLS = new Set([
  "message_agent", "join_agent", "list_agents", "integrate_agent"
]);
const SIMPLIFIED_EXECUTION_TOOLS = new Set(["exec", "shell", "validate"]);
const HIDDEN_EXECUTION_ARGUMENTS = new Set(["access", "writeRoots", "writePaths"]);

export interface ModelToolAvailabilityV1 {
  available: boolean;
  reason?: "process_state" | "child_state" | "checkpoint_state" | "review_state";
}

function objectArguments(value: JsonValue): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function pendingForCall(session: RuntimeSession, call: ModelToolCall): PendingTool | undefined {
  return session.durable.state.pendingTools.find((pending) =>
    pending.request.callId === call.id && pending.request.name === call.name);
}

/** Re-check the runtime-authored model-turn capability at the transaction
 * boundary. This is intentionally redundant with the kernel reducer: restored
 * or malformed pending work must not become executable merely because it
 * bypassed the normal model.completed transition. */
export function modelTurnToolPolicyFailure(
  session: RuntimeSession,
  call: ModelToolCall,
  descriptor: ToolDescriptor,
  modelTurn: ActiveModelTurn,
  startedAt: string
): ToolReceipt | undefined {
  const pending = pendingForCall(session, call);
  if (pending?.origin !== "model") return undefined;
  const boundTurn = pending.modelTurn;
  const policy = boundTurn.toolPolicy;
  const sameTurn = boundTurn.turnId === modelTurn.turnId
    && boundTurn.effectRevision === modelTurn.effectRevision;
  const authorized = sameTurn && policy?.allowedToolNames.includes(call.name) === true
    && (!policy.terminalOnly || terminalOnlyToolDescriptor(descriptor));
  if (authorized) return undefined;
  return failed(
    call,
    startedAt,
    `Tool '${call.name}' was not authorized by the runtime-bound policy for its originating model turn and was not started.`,
    "tool_not_authorized_for_turn",
    { status: "rejected", code: "tool_not_authorized_for_turn" }
  );
}

/** Dynamic planning can narrow an effect envelope, but it must never widen a
 * terminal-only model turn. Re-check the exact plan before emitting any tool
 * lifecycle event or entering approval/execution. */
export function modelTurnToolPlanPolicyFailure(
  session: RuntimeSession,
  call: ModelToolCall,
  plan: ToolCallPlan,
  modelTurn: ActiveModelTurn,
  startedAt: string
): ToolReceipt | undefined {
  const pending = pendingForCall(session, call);
  if (pending?.origin !== "model") return undefined;
  const boundTurn = pending.modelTurn;
  const policy = boundTurn.toolPolicy;
  if (policy?.terminalOnly !== true) return undefined;
  const sameTurn = boundTurn.turnId === modelTurn.turnId
    && boundTurn.effectRevision === modelTurn.effectRevision;
  const authorized = sameTurn && policy.allowedToolNames.includes(call.name)
    && terminalOnlyToolEffects(plan.exactEffects);
  if (authorized) return undefined;
  return failed(
    call,
    startedAt,
    `Tool '${call.name}' planned non-terminal effects for a terminal-only model turn and was not started.`,
    "tool_not_authorized_for_turn",
    { status: "rejected", code: "tool_not_authorized_for_turn" }
  );
}

/** State-dependent tools are absent until the durable resource that they
 * operate on exists. Initiators such as process_spawn and spawn_agent remain
 * ordinary execution tools; only follow-up control surfaces are phased. */
export function modelToolAvailability(
  session: RuntimeSession,
  descriptor: Pick<ToolDescriptor, "name">
): ModelToolAvailabilityV1 {
  const { state } = session.durable;
  if (PROCESS_CONTROL_TOOLS.has(descriptor.name)) {
    return state.activeProcessIds.length > 0
      ? { available: true }
      : { available: false, reason: "process_state" };
  }
  if (CHILD_CONTROL_TOOLS.has(descriptor.name)) {
    return state.childIds.length > 0
      ? { available: true }
      : { available: false, reason: "child_state" };
  }
  if (descriptor.name === "list_checkpoints") {
    return state.checkpointHead
      ? { available: true }
      : { available: false, reason: "checkpoint_state" };
  }
  if (descriptor.name === "restore_run_changes") {
    return state.checkpointHead?.status === "sealed" && state.checkpointHead.runId === state.runId
      ? { available: true }
      : { available: false, reason: "checkpoint_state" };
  }
  if (descriptor.name === "request_review") {
    return state.mutationFrontier.changedPaths.length > 0
      ? { available: true }
      : { available: false, reason: "review_state" };
  }
  return { available: true };
}

export function descriptorsAvailableToModel(
  session: RuntimeSession,
  descriptors: readonly ToolDescriptor[]
): ToolDescriptor[] {
  return descriptors.filter((descriptor) => modelToolAvailability(session, descriptor).available);
}

export function executionCapabilityRetryFailure(
  session: RuntimeSession,
  call: ModelToolCall,
  descriptor: ToolDescriptor,
  startedAt: string
): ToolReceipt | undefined {
  const processTool = descriptor.possibleEffects.some((effect) =>
    effect === "process.spawn" || effect === "process.spawn.readonly");
  if (!processTool || !capabilityRetryExhausted(session, call)) {
    return undefined;
  }
  return failed(
    call,
    startedAt,
    "Execution is blocked after the same sandbox capability failed twice. Do not substitute a weaker probe; report the typed environment blocker.",
    "capability_retry_exhausted"
  );
}

function liveResourceMatches(session: RuntimeSession, call: ModelToolCall): boolean {
  const input = objectArguments(call.arguments);
  if (PROCESS_CONTROL_TOOLS.has(call.name)) {
    return typeof input?.handleId === "string"
      && session.durable.state.activeProcessIds.includes(input.handleId);
  }
  if (CHILD_CONTROL_TOOLS.has(call.name) && call.name !== "list_agents") {
    return typeof input?.childId === "string"
      && session.durable.state.childIds.includes(input.childId);
  }
  return true;
}

function nextArgumentsForSimplifiedCall(
  descriptor: ToolDescriptor,
  call: ModelToolCall
): Record<string, JsonValue> | undefined {
  const input = objectArguments(call.arguments);
  if (!input) return undefined;
  const next = Object.fromEntries(Object.entries(input)
    .filter(([key]) => !HIDDEN_EXECUTION_ARGUMENTS.has(key))) as Record<string, JsonValue>;
  const legacyWritePaths = Array.isArray(input.writePaths) ? input.writePaths
    : Array.isArray(input.writeRoots) ? input.writeRoots : undefined;
  if (next.expectedChanges === undefined && legacyWritePaths
    && legacyWritePaths.every((item) => typeof item === "string")) {
    next.expectedChanges = [...legacyWritePaths];
  }
  if (input.access === "write" && next.expectedChanges === undefined) return undefined;
  try {
    assertDescriptorArguments(descriptor, next);
    return next;
  } catch {
    return undefined;
  }
}

function nextArgumentsAfterSchemaError(
  descriptor: ToolDescriptor,
  call: ModelToolCall
): Record<string, JsonValue> | undefined {
  const input = objectArguments(call.arguments);
  const properties = descriptor.inputSchema.properties;
  if (!input || !properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;
  const allowed = new Set(Object.keys(properties));
  const next = Object.fromEntries(Object.entries(input).filter(([key]) => allowed.has(key))) as Record<string, JsonValue>;
  try {
    assertDescriptorArguments(descriptor, next);
    return next;
  } catch {
    return undefined;
  }
}

function rejectedResult(
  code: "tool_call_stale" | "tool_arguments_stale" | "tool_arguments_invalid",
  nextArguments?: Record<string, JsonValue>
): JsonValue {
  return {
    status: "rejected",
    code,
    ...(nextArguments ? { nextArguments } : {})
  };
}

/** Enforce the exact model-visible contract at execution time. Legacy durable
 * calls without an origin marker remain replayable through the authoritative
 * schema, while every newly model-authored call is checked fail-closed. */
export function modelToolCallContractFailure(
  session: RuntimeSession,
  call: ModelToolCall,
  descriptor: ToolDescriptor,
  startedAt: string
): ToolReceipt | undefined {
  if (pendingForCall(session, call)?.origin !== "model") return undefined;
  const availability = modelToolAvailability(session, descriptor);
  if (!availability.available || !liveResourceMatches(session, call)) {
    return failed(
      call,
      startedAt,
      `Tool '${call.name}' is stale because its required durable resource is no longer available. Re-read the currently offered tools before acting.`,
      "tool_call_stale",
      rejectedResult("tool_call_stale")
    );
  }
  if (!SIMPLIFIED_EXECUTION_TOOLS.has(call.name)) return undefined;
  const input = objectArguments(call.arguments);
  if (!input || !Object.keys(input).some((key) => HIDDEN_EXECUTION_ARGUMENTS.has(key))) return undefined;
  const nextArguments = nextArgumentsForSimplifiedCall(descriptor, call);
  return failed(
    call,
    startedAt,
    `Tool '${call.name}' no longer accepts model-authored access, writeRoots, or writePaths. Omit them; expectedChanges is the only model-visible write declaration.`,
    "tool_arguments_stale",
    rejectedResult("tool_arguments_stale", nextArguments)
  );
}

export function modelToolArgumentFailure(
  session: RuntimeSession,
  call: ModelToolCall,
  descriptor: ToolDescriptor,
  startedAt: string,
  error: unknown
): ToolReceipt | undefined {
  if (pendingForCall(session, call)?.origin !== "model"
    || (error as { code?: unknown })?.code !== "tool_arguments_invalid") return undefined;
  const nextArguments = nextArgumentsAfterSchemaError(descriptor, call);
  return failed(
    call,
    startedAt,
    error instanceof Error ? error.message : String(error),
    "tool_arguments_invalid",
    rejectedResult("tool_arguments_invalid", nextArguments)
  );
}
