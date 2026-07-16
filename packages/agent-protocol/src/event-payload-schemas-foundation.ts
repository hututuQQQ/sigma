import { z } from "zod";
import {
  budgetAmountsSchema,
  budgetLedgerStateSchema,
  budgetLimitsSchema,
  checkpointDeltaSchema,
  checkpointRefSchema,
  dateTimeSchema,
  evidenceRecordSchema,
  jsonValueSchema,
  modelExecutionRoleSchema,
  nonEmptyStringSchema,
  planGraphSchema,
  reviewEvidenceSchema,
  usageRecordSchema,
  userWaiverEvidenceSchema
} from "./domain-schemas.js";

export const authoritySchema = z.enum(["system", "developer", "user", "project", "runtime", "tool"]);
export const runModeSchema = z.enum(["analyze", "change"]);
export const sourceSchema = z.enum(["home", "workspace", "builtin"]);
export const turnSchema = {
  turnId: z.number().int().positive(),
  effectRevision: z.number().int().nonnegative()
};

export const modelToolCallSchema = z.object({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  arguments: jsonValueSchema
}).strict();

export const modelMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.string(),
  reasoningContent: z.string().optional(),
  toolCallId: z.string().optional(),
  toolCalls: z.array(modelToolCallSchema).optional()
}).strict();

export const toolEffectSchema = z.enum([
  "filesystem.read", "filesystem.write", "repository.write", "process.spawn", "process.spawn.readonly",
  "agent.spawn", "network", "validation", "outcome.propose", "outcome.report_blocked", "outcome.request_input",
  "runtime.control", "checkpoint.restore", "destructive", "open_world"
]);

export const toolCallPlanSchema = z.object({
  exactEffects: z.array(toolEffectSchema),
  readPaths: z.array(z.string()),
  writePaths: z.array(z.string()),
  network: z.enum(["none", "full"]),
  processMode: z.enum(["none", "pipe", "pty", "background"]),
  checkpointScope: z.array(z.string()),
  checkpointAction: z.object({
    kind: z.literal("restore"),
    checkpointId: nonEmptyStringSchema
  }).strict().optional(),
  idempotence: z.enum(["read_only", "replay_safe", "non_replayable"])
}).strict();

const artifactRefSchema = z.object({
  artifactId: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  digest: nonEmptyStringSchema,
  mediaType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional()
}).strict();

const toolOutcomeSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  output: z.string(),
  diagnosticCodes: z.array(z.string())
}).strict();

export const durableToolReceiptShape = {
  callId: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  ok: z.boolean(),
  output: z.string(),
  result: jsonValueSchema.optional(),
  outcome: toolOutcomeSchema,
  observedEffects: z.array(toolEffectSchema),
  actualEffects: z.array(toolEffectSchema).optional(),
  workspaceDelta: checkpointDeltaSchema.optional(),
  artifacts: z.array(z.string()),
  artifactRefs: z.array(artifactRefSchema).optional(),
  diagnostics: z.array(z.string()),
  evidence: z.array(evidenceRecordSchema).optional(),
  startedAt: dateTimeSchema,
  completedAt: dateTimeSchema,
  ...turnSchema
};

export const contextItemSchema = z.object({
  id: nonEmptyStringSchema,
  authority: authoritySchema,
  provenance: nonEmptyStringSchema,
  content: z.string(),
  tokenCount: z.number().int().nonnegative(),
  priority: z.number().finite(),
  cacheKey: z.string().optional()
}).strict();

export const sharedSchemas = {
  budgetAmountsSchema,
  budgetLedgerStateSchema,
  budgetLimitsSchema,
  checkpointRefSchema,
  evidenceRecordSchema,
  jsonValueSchema,
  modelExecutionRoleSchema,
  planGraphSchema,
  reviewEvidenceSchema,
  usageRecordSchema,
  userWaiverEvidenceSchema
};
