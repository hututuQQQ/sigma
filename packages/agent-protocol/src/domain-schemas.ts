import { z } from "zod";
import type { JsonValue } from "./json.js";

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema)
]));

export const nonEmptyStringSchema = z.string().min(1);
export const dateTimeSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  "Expected an ISO-compatible date-time string"
);
export const nonNegativeIntegerSchema = z.number().int().nonnegative();

export const evidenceKindSchema = z.enum([
  "workspace_delta", "repository_delta", "command", "validation", "diagnostic",
  "input_access", "review", "checkpoint", "child_outcome", "user_waiver"
]);
export const evidenceStatusSchema = z.enum(["passed", "failed", "warning", "informational"]);
export const evidenceClaimSchema = z.enum([
  "acceptance_met", "validation_executed", "validation_passed"
]);
export const evidenceAuthoritySchema = z.enum(["system", "developer", "user", "project", "runtime", "tool"]);
export const evidenceProducerSchema = z.object({
  authority: evidenceAuthoritySchema,
  id: z.string().optional()
}).strict();

export const checkpointDeltaSchema = z.object({
  added: z.array(z.string()),
  modified: z.array(z.string()),
  deleted: z.array(z.string())
}).strict();

const opaqueArtifactIdentitySchema = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  sizeBytes: nonNegativeIntegerSchema
}).strict();

export const opaqueArtifactEvidenceSchema = z.object({
  path: nonEmptyStringSchema,
  representation: z.enum(["binary", "content_omitted"]).optional(),
  before: opaqueArtifactIdentitySchema.optional(),
  after: opaqueArtifactIdentitySchema.optional()
}).strict().refine(
  (value) => value.before !== undefined || value.after !== undefined,
  "Opaque artifact evidence must contain a before or after identity"
);

const evidenceBaseShape = {
  evidenceId: nonEmptyStringSchema,
  sessionId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  status: evidenceStatusSchema,
  createdAt: dateTimeSchema,
  producer: evidenceProducerSchema,
  summary: nonEmptyStringSchema
};

export const workspaceDeltaEvidenceSchema = z.object({
  ...evidenceBaseShape,
  kind: z.literal("workspace_delta"),
  data: z.object({
    delta: checkpointDeltaSchema,
    checkpointId: nonEmptyStringSchema,
    sourceSessionId: nonEmptyStringSchema.optional(),
    childId: nonEmptyStringSchema.optional(),
    reviewDiff: z.string().optional(),
    reviewDiffPaths: z.array(nonEmptyStringSchema).optional(),
    opaqueArtifacts: z.array(opaqueArtifactEvidenceSchema).optional(),
    reviewProblem: z.object({
      code: z.literal("review_scope_too_large"),
      message: nonEmptyStringSchema,
      action: nonEmptyStringSchema
    }).strict().optional()
  }).strict()
}).strict();

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const mutationFrontierSchema = z.object({
  revision: nonNegativeIntegerSchema,
  baselineManifestDigest: digestSchema,
  currentStateDigest: digestSchema,
  changedPaths: z.array(nonEmptyStringSchema),
  sourceCheckpointIds: z.array(nonEmptyStringSchema),
  repositoryStateDigest: digestSchema.optional()
}).strict();

export const repositoryDeltaEvidenceSchema = z.object({
  ...evidenceBaseShape,
  kind: z.literal("repository_delta"),
  data: z.object({
    operationCount: z.number().int().positive(),
    operations: z.array(nonEmptyStringSchema),
    beforeStateDigest: digestSchema,
    afterStateDigest: digestSchema,
    headBefore: z.string().nullable(),
    headAfter: z.string().nullable(),
    refsBeforeDigest: digestSchema,
    refsAfterDigest: digestSchema,
    indexBeforeDigest: digestSchema,
    indexAfterDigest: digestSchema,
    reachableObjectsBefore: nonNegativeIntegerSchema,
    reachableObjectsAfter: nonNegativeIntegerSchema
  }).strict()
}).strict();

export const commandEvidenceSchema = z.object({
  ...evidenceBaseShape,
  kind: z.literal("command"),
  data: z.object({
    command: nonEmptyStringSchema,
    exitCode: z.number().int().nullable(),
    signal: z.string().optional(),
    artifactIds: z.array(z.string()).optional(),
    stdoutArtifactId: z.string().optional(),
    stderrArtifactId: z.string().optional()
  }).strict()
}).strict();

export const validationEvidenceSchema = z.object({
  ...evidenceBaseShape,
  kind: z.literal("validation"),
  data: z.object({
    validator: nonEmptyStringSchema,
    command: z.string().optional(),
    exitCode: z.number().int().nullable().optional(),
    termination: z.object({
      processStarted: z.boolean(),
      state: z.enum(["exited", "terminated"]),
      exitCode: z.number().int().nullable(),
      signal: z.string().nullable(),
      timedOut: z.boolean(),
      idleTimedOut: z.boolean(),
      cancelled: z.boolean(),
      failureCode: nonEmptyStringSchema.optional()
    }).strict().optional(),
    artifactIds: z.array(z.string()).optional(),
    frontierRevision: nonNegativeIntegerSchema,
    stateDigest: digestSchema,
    coveredPaths: z.array(nonEmptyStringSchema),
    sourceSessionId: nonEmptyStringSchema.optional(),
    childId: nonEmptyStringSchema.optional()
  }).strict()
}).strict();

export const diagnosticEvidenceSchema = z.object({
  ...evidenceBaseShape,
  kind: z.literal("diagnostic"),
  data: z.object({
    source: nonEmptyStringSchema,
    diagnostic: jsonValueSchema
  }).strict()
}).strict();

export const inputAccessEvidenceSchema = z.object({
  ...evidenceBaseShape,
  kind: z.literal("input_access"),
  data: z.object({
    path: nonEmptyStringSchema,
    scope: z.enum(["workspace", "external"]),
    sha256: digestSchema.optional(),
    byteLength: nonNegativeIntegerSchema.optional(),
    failureCode: nonEmptyStringSchema.optional()
  }).strict()
}).strict();

export const reviewEvidenceSchema = z.object({
  ...evidenceBaseShape,
  kind: z.literal("review"),
  data: z.object({
    reviewerId: nonEmptyStringSchema,
    verdict: z.enum(["approved", "changes_requested"]),
    findings: z.array(jsonValueSchema),
    frontierRevision: nonNegativeIntegerSchema,
    stateDigest: digestSchema,
    reviewBasisDigest: digestSchema.optional(),
    validationEvidenceIds: z.array(z.string()).optional(),
    failureKind: z.enum(["infrastructure", "interrupted"]).optional(),
    failureCode: z.literal("review_scope_too_large").optional(),
    checkpointId: z.string().optional()
  }).strict()
}).strict();

export const checkpointEvidenceSchema = z.object({
  ...evidenceBaseShape,
  kind: z.literal("checkpoint"),
  data: z.object({
    checkpointId: nonEmptyStringSchema,
    checkpointStatus: z.enum(["open", "sealed", "restored"]),
    preManifestDigest: nonEmptyStringSchema,
    postManifestDigest: z.string().optional(),
    sourceSessionId: nonEmptyStringSchema.optional(),
    childId: nonEmptyStringSchema.optional()
  }).strict()
}).strict();

export const childOutcomeEvidenceSchema = z.object({
  ...evidenceBaseShape,
  kind: z.literal("child_outcome"),
  data: z.object({
    childId: nonEmptyStringSchema,
    outcome: z.enum(["completed", "failed", "cancelled", "blocked"]),
    planNodeIds: z.array(z.string()),
    recoveryReason: z.string().optional()
  }).strict()
}).strict();

export const userWaiverEvidenceSchema = z.object({
  ...evidenceBaseShape,
  kind: z.literal("user_waiver"),
  data: z.object({
    scope: z.enum(["review", "validation"]),
    reason: nonEmptyStringSchema,
    checkpointId: z.string().optional()
  }).strict()
}).strict();

export const evidenceRecordSchema = z.discriminatedUnion("kind", [
  workspaceDeltaEvidenceSchema,
  repositoryDeltaEvidenceSchema,
  commandEvidenceSchema,
  validationEvidenceSchema,
  diagnosticEvidenceSchema,
  inputAccessEvidenceSchema,
  reviewEvidenceSchema,
  checkpointEvidenceSchema,
  childOutcomeEvidenceSchema,
  userWaiverEvidenceSchema
]);

export const modelExecutionRoleSchema = z.enum([
  "orchestrator", "planner", "reviewer", "child_analyze", "child_write", "summarizer"
]);

export const usageRecordSchema = z.object({
  usageId: nonEmptyStringSchema,
  requestId: nonEmptyStringSchema,
  sessionId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  role: modelExecutionRoleSchema,
  routeId: nonEmptyStringSchema,
  providerId: nonEmptyStringSchema,
  modelId: nonEmptyStringSchema,
  tokenizerId: nonEmptyStringSchema,
  tokenizerAccuracy: z.enum(["exact", "approximate"]),
  tokenizerAssetDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  providerReported: z.boolean(),
  inputTokens: nonNegativeIntegerSchema,
  outputTokens: nonNegativeIntegerSchema,
  reasoningTokens: nonNegativeIntegerSchema,
  cacheReadTokens: nonNegativeIntegerSchema,
  cacheWriteTokens: nonNegativeIntegerSchema,
  costMicroUsd: nonNegativeIntegerSchema,
  latencyMs: nonNegativeIntegerSchema,
  attempt: z.number().int().min(1),
  occurredAt: dateTimeSchema
}).strict();

export const evidenceRefSchema = z.object({
  evidenceId: nonEmptyStringSchema,
  kind: evidenceKindSchema,
  claim: evidenceClaimSchema.optional()
}).strict();

const planNodeOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root") }).strict(),
  z.object({ kind: z.literal("child"), childId: nonEmptyStringSchema }).strict()
]);

const planNodeSchema = z.object({
  id: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  dependencies: z.array(z.string()),
  status: z.enum(["pending", "in_progress", "blocked", "completed", "cancelled"]),
  owner: planNodeOwnerSchema,
  acceptanceCriteria: z.array(z.string()),
  evidence: z.array(evidenceRefSchema),
  blockedReason: z.string().optional(),
  reopenReason: z.string().optional()
}).strict().superRefine((node, context) => {
  if (node.status === "blocked" && !node.blockedReason) {
    context.addIssue({ code: "custom", path: ["blockedReason"], message: "Blocked plan nodes require a reason" });
  }
  if (node.status === "completed" && node.evidence.length === 0) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "Completed plan nodes require evidence" });
  }
});

function hasDependencyCycle(dependencies: ReadonlyMap<string, readonly string[]>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) if (visit(dependency)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...dependencies.keys()].some(visit);
}

export const planGraphSchema = z.object({
  revision: nonNegativeIntegerSchema,
  goal: z.string(),
  activeNodeId: z.string().optional(),
  nodes: z.array(planNodeSchema).max(128)
}).strict().superRefine((graph, context) => {
  const identifiers = new Set(graph.nodes.map((node) => node.id));
  if (identifiers.size !== graph.nodes.length) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "Plan node identifiers must be unique" });
  }
  if (graph.activeNodeId !== undefined && !identifiers.has(graph.activeNodeId)) {
    context.addIssue({ code: "custom", path: ["activeNodeId"], message: "Active plan node does not exist" });
  }
  const dependencies = new Map(graph.nodes.map((node) => [node.id, node.dependencies]));
  for (const [index, node] of graph.nodes.entries()) {
    for (const dependency of node.dependencies) {
      if (!identifiers.has(dependency)) {
        context.addIssue({ code: "custom", path: ["nodes", index, "dependencies"], message: "Plan dependency does not exist" });
      }
    }
  }
  if (hasDependencyCycle(dependencies)) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "Plan dependencies must be acyclic" });
  }
});

export const budgetAmountsSchema = z.object({
  inputTokens: nonNegativeIntegerSchema,
  outputTokens: nonNegativeIntegerSchema,
  costMicroUsd: nonNegativeIntegerSchema,
  modelTurns: nonNegativeIntegerSchema,
  toolCalls: nonNegativeIntegerSchema,
  children: nonNegativeIntegerSchema
}).strict();

export const budgetLimitsSchema = budgetAmountsSchema.extend({
  maxDepth: nonNegativeIntegerSchema
}).strict();

export const budgetReservationSchema = z.object({
  reservationId: nonEmptyStringSchema,
  ownerId: nonEmptyStringSchema,
  status: z.enum(["reserved", "committed", "released"]),
  requested: budgetAmountsSchema,
  consumed: budgetAmountsSchema,
  createdAt: dateTimeSchema,
  settledAt: dateTimeSchema.optional()
}).strict();

export const budgetLedgerStateSchema = z.object({
  limits: budgetLimitsSchema,
  consumed: budgetAmountsSchema,
  reserved: budgetAmountsSchema,
  reservations: z.array(budgetReservationSchema)
}).strict();

export const checkpointRefSchema = z.object({
  checkpointId: nonEmptyStringSchema,
  sessionId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  status: z.enum(["open", "sealed", "restored"]),
  createdAt: dateTimeSchema,
  sealedAt: dateTimeSchema.optional(),
  restoredAt: dateTimeSchema.optional(),
  preManifestDigest: nonEmptyStringSchema,
  postManifestDigest: z.string().min(1).optional(),
  delta: checkpointDeltaSchema.optional()
}).strict();
