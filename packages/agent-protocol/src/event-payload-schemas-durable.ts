import { z } from "zod";
import { nonEmptyStringSchema } from "./domain-schemas.js";
import {
  sourceSchema,
  sharedSchemas,
  toolCallPlanSchema
} from "./event-payload-schemas-foundation.js";

const budgetEventSchema = z.object({
  ledger: sharedSchemas.budgetLedgerStateSchema,
  reservationId: nonEmptyStringSchema
}).strict();

const budgetOverrunDimensionSchema = z.object({
  dimension: z.enum(["inputTokens", "outputTokens", "costMicroUsd", "modelTurns", "toolCalls", "children"]),
  reserved: z.number().int().nonnegative(),
  actual: z.number().int().nonnegative(),
  overReservation: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  consumed: z.number().int().nonnegative(),
  overLimit: z.number().int().nonnegative()
}).strict();

const hookOutcomeSchema = z.object({
  hookId: nonEmptyStringSchema,
  event: nonEmptyStringSchema,
  required: z.boolean(),
  status: z.enum(["allowed", "denied", "observed", "failed"]),
  durationMs: z.number().finite().nonnegative(),
  reason: z.string().optional()
}).strict();

const hookSettledSchema = z.object({
  hookId: nonEmptyStringSchema,
  event: nonEmptyStringSchema,
  required: z.boolean(),
  durationMs: z.number().finite().nonnegative(),
  outcome: hookOutcomeSchema
}).strict();

const checkpointRecoverySchema = z.object({
  checkpointId: nonEmptyStringSchema,
  decision: z.enum(["restore", "keep"]),
  sourceSessionId: nonEmptyStringSchema.optional(),
  childId: nonEmptyStringSchema.optional(),
  applied: z.boolean().optional()
}).strict();

export const durableEventPayloadSchemas = {
  "execution.planned": z.object({
    executionId: nonEmptyStringSchema,
    toolCallId: nonEmptyStringSchema,
    plan: toolCallPlanSchema
  }).strict(),
  "execution.started": z.object({ executionId: nonEmptyStringSchema }).strict(),
  "execution.completed": z.object({
    executionId: nonEmptyStringSchema,
    evidenceIds: z.array(nonEmptyStringSchema)
  }).strict(),
  "execution.failed": z.object({
    executionId: nonEmptyStringSchema,
    code: nonEmptyStringSchema,
    message: z.string()
  }).strict(),
  "process.spawned": z.object({
    processId: nonEmptyStringSchema,
    executionId: nonEmptyStringSchema,
    mode: z.enum(["pipe", "pty", "background"]),
    brokerInstanceId: nonEmptyStringSchema,
    lifecycle: z.enum(["session", "deliverable"]).default("session")
  }).strict(),
  "process.output": z.object({
    processId: nonEmptyStringSchema,
    stream: z.enum(["stdout", "stderr"]),
    chunk: z.string()
  }).strict(),
  "process.exited": z.object({
    processId: nonEmptyStringSchema,
    exitCode: z.number().int().nullable(),
    signal: z.string().optional(),
    state: nonEmptyStringSchema,
    reason: z.string().optional()
  }).strict(),
  "process.lost": z.object({ processId: nonEmptyStringSchema, reason: nonEmptyStringSchema }).strict(),
  "process.handed_off": z.object({
    processId: nonEmptyStringSchema,
    handoffId: nonEmptyStringSchema,
    systemProcessId: z.number().int().positive().optional()
  }).strict(),
  "evidence.recorded": sharedSchemas.evidenceRecordSchema,
  "usage.recorded": sharedSchemas.usageRecordSchema,
  "model.route_resolved": z.object({
    role: sharedSchemas.modelExecutionRoleSchema,
    routeId: nonEmptyStringSchema,
    modelSpecId: nonEmptyStringSchema,
    attempt: z.number().int().positive(),
    tokenizerAssetDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional()
  }).strict(),
  "model.route_failed": z.object({
    role: sharedSchemas.modelExecutionRoleSchema,
    routeId: nonEmptyStringSchema,
    modelSpecId: nonEmptyStringSchema,
    attempt: z.number().int().positive(),
    category: nonEmptyStringSchema,
    semanticDelta: z.boolean()
  }).strict(),
  "profile.resolved": z.object({
    profileId: nonEmptyStringSchema,
    digest: nonEmptyStringSchema,
    artifactId: nonEmptyStringSchema,
    source: sourceSchema
  }).strict(),
  "customization.frozen": z.object({
    digest: nonEmptyStringSchema,
    artifactId: nonEmptyStringSchema,
    skillCount: z.number().int().nonnegative(),
    hookCount: z.number().int().nonnegative(),
    profileCount: z.number().int().nonnegative().optional()
  }).strict(),
  "skill.loaded": z.object({
    qualifiedName: nonEmptyStringSchema,
    digest: nonEmptyStringSchema,
    artifactId: nonEmptyStringSchema,
    source: sourceSchema,
    executionManifestArtifactId: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    executionManifestDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional()
  }).strict().superRefine((skill, context) => {
    if ((skill.executionManifestArtifactId === undefined) !== (skill.executionManifestDigest === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["executionManifestArtifactId"],
        message: "Execution manifest artifact and digest must be provided together"
      });
    }
  }),
  "hook.started": z.object({
    hookId: nonEmptyStringSchema,
    event: nonEmptyStringSchema,
    required: z.boolean(),
    kind: nonEmptyStringSchema
  }).strict(),
  "hook.completed": hookSettledSchema,
  "hook.failed": hookSettledSchema,
  "plan.updated": z.object({
    plan: sharedSchemas.planGraphSchema,
    previousRevision: z.number().int().nonnegative()
  }).strict(),
  "budget.reserved": budgetEventSchema,
  "budget.reservation_bound": z.object({
    ledger: sharedSchemas.budgetLedgerStateSchema,
    reservationId: nonEmptyStringSchema,
    ownerId: nonEmptyStringSchema
  }).strict(),
  "budget.committed": budgetEventSchema,
  "budget.released": budgetEventSchema,
  "budget.exhausted": z.object({
    dimension: nonEmptyStringSchema,
    requested: z.number().int().nonnegative(),
    available: z.number().int().nonnegative()
  }).strict(),
  "budget.overrun": z.object({
    reservationId: nonEmptyStringSchema,
    dimensions: z.array(budgetOverrunDimensionSchema).min(1)
  }).strict(),
  "budget.limit_increased": z.object({
    previousLimits: sharedSchemas.budgetLimitsSchema,
    increase: sharedSchemas.budgetLimitsSchema.partial(),
    ledger: sharedSchemas.budgetLedgerStateSchema
  }).strict(),
  "checkpoint.created": sharedSchemas.checkpointRefSchema.refine(
    (checkpoint) => checkpoint.status === "open",
    { path: ["status"], message: "Created checkpoints must be open" }
  ),
  "checkpoint.sealed": sharedSchemas.checkpointRefSchema.refine(
    (checkpoint) => checkpoint.status === "sealed",
    { path: ["status"], message: "Sealed checkpoint event requires sealed status" }
  ),
  "checkpoint.restored": sharedSchemas.checkpointRefSchema.refine(
    (checkpoint) => checkpoint.status === "restored",
    { path: ["status"], message: "Restored checkpoint event requires restored status" }
  ),
  "checkpoint.recovery_resolved": checkpointRecoverySchema,
  "review.started": z.object({
    reviewerId: nonEmptyStringSchema,
    requestId: nonEmptyStringSchema.optional(),
    workspaceDeltaEvidenceIds: z.array(nonEmptyStringSchema),
    validationEvidenceIds: z.array(nonEmptyStringSchema).optional(),
    reviewRelevantEvidenceIds: z.array(nonEmptyStringSchema).optional()
  }).strict(),
  "review.completed": sharedSchemas.reviewEvidenceSchema,
  "review.waived": sharedSchemas.userWaiverEvidenceSchema
} as const;
