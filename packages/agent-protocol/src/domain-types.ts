import type { JsonValue } from "./json.js";
import type { z } from "zod";
import type {
  budgetAmountsSchema,
  budgetLedgerStateSchema,
  budgetLimitsSchema,
  budgetReservationSchema,
  checkpointDeltaSchema,
  checkpointEvidenceSchema,
  checkpointRefSchema,
  childOutcomeEvidenceSchema,
  commandEvidenceSchema,
  diagnosticEvidenceSchema,
  evidenceAuthoritySchema,
  evidenceKindSchema,
  evidenceProducerSchema,
  evidenceRecordSchema,
  evidenceRefSchema,
  evidenceStatusSchema,
  modelExecutionRoleSchema,
  planGraphSchema,
  reviewEvidenceSchema,
  usageRecordSchema,
  userWaiverEvidenceSchema,
  validationEvidenceSchema,
  workspaceDeltaEvidenceSchema
} from "./domain-schemas.js";

export type JsonObject = { [key: string]: JsonValue };

export type EvidenceKind = z.infer<typeof evidenceKindSchema>;
export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;
export type EvidenceAuthority = z.infer<typeof evidenceAuthoritySchema>;
export type EvidenceProducer = z.infer<typeof evidenceProducerSchema>;

export interface EvidenceBase<TKind extends EvidenceKind, TData> {
  evidenceId: string;
  sessionId: string;
  runId: string;
  kind: TKind;
  status: EvidenceStatus;
  createdAt: string;
  producer: EvidenceProducer;
  summary: string;
  data: TData;
}

export type CheckpointDelta = z.infer<typeof checkpointDeltaSchema>;
export type WorkspaceDeltaEvidence = z.infer<typeof workspaceDeltaEvidenceSchema>;
export type CommandEvidence = z.infer<typeof commandEvidenceSchema>;
export type ValidationEvidence = z.infer<typeof validationEvidenceSchema>;
export type DiagnosticEvidence = z.infer<typeof diagnosticEvidenceSchema>;
export type ReviewEvidence = z.infer<typeof reviewEvidenceSchema>;
export type CheckpointEvidence = z.infer<typeof checkpointEvidenceSchema>;
export type ChildOutcomeEvidence = z.infer<typeof childOutcomeEvidenceSchema>;
export type UserWaiverEvidence = z.infer<typeof userWaiverEvidenceSchema>;
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

export interface ArtifactRef {
  artifactId: string;
  name: string;
  digest: string;
  mediaType?: string;
  sizeBytes?: number;
}

export type ModelExecutionRole = z.infer<typeof modelExecutionRoleSchema>;
export type UsageRecord = z.infer<typeof usageRecordSchema>;
export type PlanGraph = z.infer<typeof planGraphSchema>;
export type PlanNode = PlanGraph["nodes"][number];
export type PlanNodeStatus = PlanNode["status"];
export type PlanNodeOwner = PlanNode["owner"];
export type BudgetAmounts = z.infer<typeof budgetAmountsSchema>;
export type BudgetLimits = z.infer<typeof budgetLimitsSchema>;
export type BudgetReservation = z.infer<typeof budgetReservationSchema>;
export type BudgetReservationStatus = BudgetReservation["status"];
export type BudgetLedgerState = z.infer<typeof budgetLedgerStateSchema>;

export const DEFAULT_ROOT_BUDGET_LIMITS: BudgetLimits = {
  inputTokens: 8_000_000,
  outputTokens: 1_000_000,
  costMicroUsd: 50_000_000,
  modelTurns: 256,
  toolCalls: 2_048,
  children: 32,
  maxDepth: 4
};

export const DEFAULT_CHILD_BUDGET_LIMITS: BudgetLimits = {
  inputTokens: 1_000_000,
  outputTokens: 128_000,
  costMicroUsd: 8_000_000,
  modelTurns: 64,
  toolCalls: 512,
  children: 4,
  maxDepth: 4
};

export type CheckpointStatus = z.infer<typeof checkpointRefSchema>["status"];

export type CheckpointEntryKind = "file" | "directory" | "symlink" | "missing";

export interface CheckpointManifestEntry {
  path: string;
  kind: CheckpointEntryKind;
  mode?: number;
  sizeBytes?: number;
  digest?: string;
  symlinkTarget?: string;
}

export interface CheckpointManifest {
  manifestVersion: 1;
  digest: string;
  entries: CheckpointManifestEntry[];
  fileCount: number;
  totalBytes: number;
}

export type CheckpointRef = z.infer<typeof checkpointRefSchema>;

export interface FrozenArtifactRef {
  artifactId: string;
  digest: string;
  source: "home" | "workspace" | "builtin";
  qualifiedName: string;
  /** Optional for legacy loaded skills. New skill-process execution requires
   * this digest-bound, content-addressed resource manifest. */
  executionManifestArtifactId?: string;
  executionManifestDigest?: string;
}

export interface FrozenCustomizationRef {
  artifactId: string;
  digest: string;
}
