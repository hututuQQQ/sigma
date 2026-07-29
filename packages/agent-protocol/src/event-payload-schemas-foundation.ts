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
  toolCalls: z.array(modelToolCallSchema).optional(),
  providerState: z.object({
    provider: nonEmptyStringSchema,
    version: z.literal(1),
    data: jsonValueSchema
  }).strict().optional()
}).strict();

export const toolEffectSchema = z.enum([
  "filesystem.read", "filesystem.read.external", "filesystem.write", "repository.write",
  "process.spawn", "process.spawn.readonly", "process.handoff",
  "agent.spawn", "network", "validation", "outcome.propose", "outcome.report_blocked", "outcome.request_input",
  "runtime.control", "checkpoint.restore", "destructive", "open_world"
]);

export const toolCallPlanSchema = z.object({
  exactEffects: z.array(toolEffectSchema),
  readPaths: z.array(z.string()),
  writePaths: z.array(z.string()),
  network: z.enum(["none", "loopback", "full"]),
  networkTargets: z.array(z.object({
    origin: nonEmptyStringSchema,
    method: z.enum(["GET", "POST"])
  }).strict()).optional(),
  processMode: z.enum(["none", "pipe", "pty", "background"]),
  checkpointScope: z.array(z.string()),
  checkpointAction: z.object({
    kind: z.literal("restore"),
    checkpointId: nonEmptyStringSchema
  }).strict().optional(),
  mutationAuthority: z.enum([
    "broker_repository_transaction",
    "disposable_enclosing_container"
  ]).optional(),
  idempotence: z.enum(["read_only", "replay_safe", "non_replayable"]),
  executionIntent: z.object({
    invocation: z.object({
      executable: z.string(), args: z.array(z.string()), cwd: z.string()
    }).strict(),
    access: z.enum(["readonly", "write"]),
    expectedChanges: z.array(z.string()).optional(),
    network: z.enum(["none", "loopback", "full"]).optional(),
    purpose: z.enum(["probe", "build", "lint", "test", "serve", "custom"])
  }).strict().optional(),
  executionCapability: z.object({
    profileId: z.string(),
    traversalRoots: z.array(z.string()),
    workspaceReadRoots: z.array(z.string()),
    dependencyRoots: z.array(z.string()),
    runtimeRoots: z.array(z.string()),
    writeRoots: z.array(z.string()),
    tempRoots: z.array(z.string()),
    network: z.enum(["none", "loopback", "full"]),
    backend: z.enum(["native", "oci"])
  }).strict().optional()
}).strict();

const artifactRefSchema = z.object({
  artifactId: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  digest: nonEmptyStringSchema,
  mediaType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  contentTrust: z.literal("external_untrusted").optional()
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
  actualEffects: z.array(toolEffectSchema),
  workspaceDelta: checkpointDeltaSchema.optional(),
  artifacts: z.array(z.string()),
  artifactRefs: z.array(artifactRefSchema).optional(),
  contentTrust: z.literal("external_untrusted").optional(),
  diagnostics: z.array(z.string()),
  evidence: z.array(evidenceRecordSchema),
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

export const runtimePromptStateSchema = z.object({
  schemaVersion: z.literal(1),
  sectionDigests: z.object({
    repository: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    completion: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    plan: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    budget: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    longHorizon: z.string().regex(/^[a-f0-9]{64}$/u).optional()
  }).strict(),
  budgetBand: z.union([
    z.literal(100), z.literal(50), z.literal(25), z.literal(10), z.literal(0)
  ]),
  archiveSourceDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional()
}).strict();

export const strategyResetSchema = z.object({
  schemaVersion: z.literal(1),
  basisDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  establishedFacts: z.array(nonEmptyStringSchema).max(12),
  falsifiedApproaches: z.array(nonEmptyStringSchema).max(8),
  hypothesis: nonEmptyStringSchema,
  nextDiscriminatingAction: nonEmptyStringSchema,
  expectedSignal: nonEmptyStringSchema,
  validationTarget: nonEmptyStringSchema.optional(),
  decision: z.enum([
    "continue_exploring",
    "implement_candidate",
    "revise_plan",
    "validate_current",
    "request_user_input"
  ]),
  decisionRationale: nonEmptyStringSchema,
  trigger: z.enum([
    "model_request",
    "input_request",
    "duplicate_result",
    "evidence_window",
    "resource_band"
  ])
}).strict();

export const assuranceResourcePolicySchema = z.object({
  budgetPercent: z.number().int().min(1).max(100),
  reviewRounds: z.number().int().min(1).max(8),
  repairRounds: z.number().int().min(0).max(4),
  reviewerMaxTurns: z.number().int().min(1).max(32),
  reviewerMaxToolCalls: z.number().int().min(0).max(128),
  repairMaxTurns: z.number().int().min(1).max(32),
  repairMaxToolCalls: z.number().int().min(0).max(128),
  strategistMode: z.enum(["off", "on_demand", "adaptive"]),
  duplicateThreshold: z.number().int().min(2).max(16),
  strategyRemainingPercent: z.number().int().min(1).max(100)
}).strict();

export const longHorizonStateSchema = z.object({
  schemaVersion: z.literal(1),
  goalEpoch: z.number().int().nonnegative(),
  settledBatchCount: z.number().int().nonnegative(),
  recentOutcomes: z.array(z.object({
    batch: z.number().int().nonnegative(),
    toolNames: z.array(nonEmptyStringSchema).min(1),
    callDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    resultDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    summary: z.string()
  }).strict()).max(8),
  duplicateStreak: z.number().int().nonnegative(),
  strategyRequested: z.boolean(),
  resourceBandTriggered: z.boolean(),
  strategy: strategyResetSchema.optional(),
  assurance: assuranceResourcePolicySchema.extend({
    schemaVersion: z.literal(1),
    maxAuxiliaryCalls: z.number().int().nonnegative(),
    maxAuxiliaryBudgetBps: z.number().int().min(100).max(10_000),
    strategistCalls: z.number().int().nonnegative(),
    reviewerCalls: z.number().int().nonnegative(),
    repairEpisodes: z.number().int().nonnegative(),
    auxiliaryInputTokens: z.number().int().nonnegative(),
    auxiliaryOutputTokens: z.number().int().nonnegative(),
    auxiliaryCostMicroUsd: z.number().int().nonnegative(),
    protectedRepairTurnsRemaining: z.number().int().nonnegative(),
    protectedToolCallsRemaining: z.number().int().nonnegative()
  }).strict()
}).strict()
  .refine((state) => state.duplicateStreak <= state.settledBatchCount, {
    path: ["duplicateStreak"],
    message: "Duplicate streak cannot exceed settled batch count"
  })
  .refine((state) => state.assurance.maxAuxiliaryBudgetBps
    === state.assurance.budgetPercent * 100, {
    path: ["assurance", "maxAuxiliaryBudgetBps"],
    message: "Auxiliary budget basis points must match budgetPercent"
  })
  .refine((state) => state.assurance.maxAuxiliaryCalls
    === state.assurance.reviewRounds * state.assurance.reviewerMaxTurns
      + (state.assurance.strategistMode === "off" ? 0 : 1), {
    path: ["assurance", "maxAuxiliaryCalls"],
    message: "Auxiliary model-turn capacity must match review and strategist policy"
  })
  .refine((state) => state.assurance.strategistCalls
    <= (state.assurance.strategistMode === "off" ? 0 : 1)
    && state.assurance.reviewerCalls <= state.assurance.reviewRounds
    && state.assurance.repairEpisodes <= state.assurance.repairRounds, {
    path: ["assurance"],
    message: "Assurance usage exceeds configured capacity"
  });

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
