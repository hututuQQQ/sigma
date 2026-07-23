import { z } from "zod";
import { dateTimeSchema, nonEmptyStringSchema } from "./domain-schemas.js";
import {
  contextItemSchema,
  durableToolReceiptShape,
  modelMessageSchema,
  modelToolCallSchema,
  runModeSchema,
  sharedSchemas,
  toolCallPlanSchema,
  toolEffectSchema,
  turnSchema
} from "./event-payload-schemas-foundation.js";

const suspensionSchema = z.object({
  kind: z.literal("needs_input").optional(),
  requestId: nonEmptyStringSchema,
  message: nonEmptyStringSchema,
  outcomeRevision: z.number().int().nonnegative().optional(),
  callId: nonEmptyStringSchema.optional(),
  remainingDeadlineMs: z.number().int().nonnegative().optional(),
  checkpointId: nonEmptyStringSchema.optional(),
  choices: z.tuple([z.literal("restore"), z.literal("keep")]).optional(),
  sourceSessionId: nonEmptyStringSchema.optional(),
  childId: nonEmptyStringSchema.optional(),
  processIds: z.array(nonEmptyStringSchema).optional(),
  turnId: z.number().int().positive().optional(),
  effectRevision: z.number().int().nonnegative().optional()
}).strict();

const approvalRequestedSchema = z.object({
  requestId: nonEmptyStringSchema,
  callId: nonEmptyStringSchema,
  toolName: nonEmptyStringSchema,
  arguments: sharedSchemas.jsonValueSchema.optional(),
  childId: nonEmptyStringSchema.optional(),
  effects: z.array(toolEffectSchema),
  plan: toolCallPlanSchema.optional(),
  reason: nonEmptyStringSchema,
  delegated: z.literal(true).optional(),
  approvalMode: z.enum(["human", "automatic"]).optional(),
  turnId: z.number().int().positive().optional(),
  effectRevision: z.number().int().nonnegative().optional()
}).strict();

const approvalResolvedSchema = z.object({
  requestId: nonEmptyStringSchema,
  callId: nonEmptyStringSchema,
  decision: z.enum(["allow", "deny", "always_allow", "cancelled", "superseded"]),
  deadlineAt: dateTimeSchema.optional(),
  childId: nonEmptyStringSchema.optional(),
  delegated: z.literal(true).optional(),
  turnId: z.number().int().positive().optional(),
  effectRevision: z.number().int().nonnegative().optional()
}).strict();

const modelFailureDiagnosticsSchema = z.object({
  provider: nonEmptyStringSchema.optional(),
  model: nonEmptyStringSchema.optional(),
  category: z.enum([
    "rate_limit", "capacity", "network", "server", "timeout",
    "auth", "configuration", "content_filter", "protocol"
  ]).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  firstByteMs: z.number().int().nonnegative().optional(),
  lastFrameMs: z.number().int().nonnegative().optional(),
  idleDurationMs: z.number().int().nonnegative().optional(),
  totalDurationMs: z.number().int().nonnegative().optional(),
  doneReceived: z.boolean().optional(),
  transportEnded: z.boolean().optional(),
  lastEventType: nonEmptyStringSchema.optional(),
  hasContent: z.boolean().optional(),
  hasReasoning: z.boolean().optional(),
  hasToolCall: z.boolean().optional(),
  retryAttempts: z.number().int().positive().optional(),
  sseChunks: z.number().int().nonnegative().optional(),
  sseBytes: z.number().int().nonnegative().optional(),
  sseFrames: z.number().int().nonnegative().optional(),
  ssePayloads: z.number().int().nonnegative().optional(),
  sseTrailingBytes: z.number().int().nonnegative().optional(),
  abortReason: z.string().min(1).max(800).optional(),
  timeoutReason: z.string().min(1).max(800).optional()
}).strict();

const diagnosticSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("steering.restart"), ...turnSchema }).strict(),
  z.object({
    kind: z.literal("child.join_failed"),
    failures: sharedSchemas.jsonValueSchema,
    evidence: sharedSchemas.jsonValueSchema
  }).strict(),
  z.object({
    kind: z.literal("nested_instructions_loaded"),
    callId: nonEmptyStringSchema,
    provenance: z.array(z.string()),
    items: z.array(contextItemSchema),
    affectsMutation: z.boolean()
  }).strict(),
  z.object({
    kind: z.literal("hook_context_added"),
    event: nonEmptyStringSchema,
    items: z.array(contextItemSchema)
  }).strict(),
  z.object({ kind: z.literal("recovery.retry_model"), message: nonEmptyStringSchema }).strict(),
  z.object({
    kind: z.literal("runtime.dependency_observed"),
    protocolVersion: z.literal(1),
    callId: nonEmptyStringSchema,
    toolName: z.enum(["exec", "validate", "process_spawn"]),
    requestedExecutable: nonEmptyStringSchema,
    failureCode: z.enum(["executable_not_found", "executable_unavailable"]),
    runtimeClosureDigest: nonEmptyStringSchema,
    opportunityId: nonEmptyStringSchema,
    recoveryAvailable: z.boolean()
  }).strict(),
  z.object({
    kind: z.literal("runtime.dependency_prepared"),
    protocolVersion: z.literal(1),
    callId: nonEmptyStringSchema,
    requestedExecutable: nonEmptyStringSchema,
    opportunityId: nonEmptyStringSchema,
    previousRuntimeClosureDigest: nonEmptyStringSchema,
    runtimeClosureDigest: nonEmptyStringSchema
  }).strict(),
  z.object({
    kind: z.literal("runtime.dependency_reprobed"),
    protocolVersion: z.literal(1),
    callId: nonEmptyStringSchema,
    toolName: z.enum(["exec", "validate", "process_spawn"]),
    requestedExecutable: nonEmptyStringSchema,
    opportunityId: nonEmptyStringSchema,
    runtimeClosureDigest: nonEmptyStringSchema,
    ok: z.boolean(),
    failureCode: nonEmptyStringSchema.optional()
  }).strict(),
  z.object({
    kind: z.literal("tool.batch_settled"),
    callId: nonEmptyStringSchema,
    ok: z.boolean(),
    evidenceIds: z.array(nonEmptyStringSchema),
    diagnosticCodes: z.array(nonEmptyStringSchema)
  }).strict(),
  z.object({
    kind: z.literal("deadline.stage"),
    stage: z.enum(["normal", "converge", "stop"]),
    budgetStage: z.enum(["normal", "converge", "terminal"]).optional(),
    remainingMs: z.number(),
    nextModelEstimateMs: z.number().int().nonnegative(),
    outputReserveTokens: z.number().int().positive()
  }).strict(),
  z.object({
    kind: z.literal("context.composition"),
    contextWindowTokens: z.number().int().nonnegative(),
    outputReserveTokens: z.number().int().positive(),
    toolTokens: z.number().int().nonnegative(),
    systemTokens: z.number().int().nonnegative(),
    dynamicTokens: z.number().int().nonnegative(),
    historyTokens: z.number().int().nonnegative(),
    latestHistoryBlockTokens: z.number().int().nonnegative(),
    omittedHistoryTurns: z.number().int().nonnegative(),
    cacheMode: z.enum(["prefix_cache", "proactive_window", "provider_window"]),
    historyTokenLimit: z.number().int().nonnegative(),
    dynamicSuffixTokens: z.number().int().nonnegative(),
    modelVisibleOutputTruncatedBytes: z.number().int().nonnegative(),
    reviewCount: z.number().int().nonnegative(),
    deadlineStage: z.enum(["normal", "converge", "stop"]),
    executionMode: z.enum(["sandboxed", "container"])
  }).strict(),
  z.object({
    kind: z.literal("recovery.reset_tool"),
    callId: nonEmptyStringSchema,
    approval: z.literal("not_required")
  }).strict(),
  z.object({
    kind: z.literal("hook_model_recovered"),
    hookId: nonEmptyStringSchema,
    event: nonEmptyStringSchema,
    requestId: nonEmptyStringSchema,
    reservationId: nonEmptyStringSchema,
    policy: z.literal("commit_full_no_replay")
  }).strict()
]);

export const coreEventPayloadSchemas = {
  "session.created": z.object({
    workspacePath: nonEmptyStringSchema,
    mode: runModeSchema,
    title: z.string(),
    writeScope: z.array(z.string()),
    strictWriteScope: z.boolean(),
    modelRole: sharedSchemas.modelExecutionRoleSchema,
    budgetLimits: sharedSchemas.budgetLimitsSchema.optional(),
    parentSessionId: nonEmptyStringSchema.optional()
  }).strict(),
  "run.started": z.object({ mode: runModeSchema, deadlineAt: dateTimeSchema }).strict(),
  "run.suspended": suspensionSchema,
  "run.completed": z.object({
    kind: z.literal("completed"),
    message: z.string(),
    evidence: z.array(sharedSchemas.evidenceRecordSchema),
    coordinator: z.object({
      modelStopped: z.literal(true),
      assuranceSatisfied: z.literal(true),
      reviewSatisfied: z.literal(true),
      runCompleted: z.literal(true)
    }).strict().optional(),
    outcomeRevision: z.number().int().nonnegative().optional()
  }).strict(),
  "run.cancelled": z.object({
    kind: z.literal("cancelled"),
    reason: z.string(),
    outcomeRevision: z.number().int().nonnegative().optional()
  }).strict(),
  "run.failed": z.object({
    kind: z.enum(["recoverable_failure", "fatal"]),
    code: nonEmptyStringSchema,
    message: z.string(),
    resumeToken: z.string().optional(),
    failureKind: z.literal("blocked").optional(),
    failureCode: nonEmptyStringSchema.optional(),
    outcomeRevision: z.number().int().nonnegative().optional()
  }).strict(),
  "user.message": z.object({ text: z.string() }).strict(),
  "user.steer": z.object({ text: z.string() }).strict(),
  "user.follow_up": z.object({
    text: z.string(), queueId: nonEmptyStringSchema, status: z.enum(["queued", "delivered"])
  }).strict(),
  "model.started": z.object({
    provider: nonEmptyStringSchema, model: nonEmptyStringSchema, ...turnSchema
  }).strict(),
  "model.delta": z.object({ turnId: z.number().int().positive(), delta: z.string() }).strict(),
  "model.reasoning_delta": z.object({ turnId: z.number().int().positive(), delta: z.string() }).strict(),
  "model.completed": z.object({
    model: nonEmptyStringSchema,
    ...turnSchema,
    text: z.string(),
    finishReason: z.enum(["stop", "length", "tool_calls", "content_filter", "protocol_error"]),
    message: modelMessageSchema,
    toolCalls: z.array(modelToolCallSchema),
    usage: sharedSchemas.usageRecordSchema
  }).strict(),
  "model.failed": z.object({
    ...turnSchema,
    code: nonEmptyStringSchema,
    message: z.string(),
    diagnostics: modelFailureDiagnosticsSchema.optional()
  }).strict(),
  "tool.requested": z.object({
    callId: nonEmptyStringSchema, name: nonEmptyStringSchema, arguments: sharedSchemas.jsonValueSchema, ...turnSchema
  }).strict(),
  "tool.approval_requested": approvalRequestedSchema,
  "tool.approval_resolved": approvalResolvedSchema,
  "tool.started": z.object({ callId: nonEmptyStringSchema, name: nonEmptyStringSchema, ...turnSchema }).strict(),
  "tool.progress": z.object({
    callId: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    ...turnSchema,
    message: z.string(),
    percent: z.number().finite().min(0).max(100).optional()
  }).strict(),
  "tool.completed": z.object(durableToolReceiptShape).strict(),
  "tool.failed": z.object(durableToolReceiptShape).strict(),
  "context.compacted": z.object({ item: contextItemSchema, omittedHistoryTurns: z.number().int().nonnegative() }).strict(),
  "child.spawned": z.object({ childId: nonEmptyStringSchema, payload: sharedSchemas.jsonValueSchema }).strict(),
  "child.message": z.object({ childId: nonEmptyStringSchema, payload: sharedSchemas.jsonValueSchema }).strict(),
  "child.completed": z.object({ childId: nonEmptyStringSchema, payload: sharedSchemas.jsonValueSchema }).strict(),
  diagnostic: diagnosticSchema
} as const;
