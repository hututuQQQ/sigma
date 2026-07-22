import { z } from "zod";
import {
  checkpointDeltaSchema,
  digestSchema,
  evidenceBaseShape,
  nonEmptyStringSchema,
  nonNegativeIntegerSchema
} from "./domain-schema-primitives.js";

const objectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);

export const repositorySemanticAssertionsV3Schema = z.object({
  schemaVersion: z.literal(3),
  head: objectIdSchema.nullable(),
  symbolicRef: nonEmptyStringSchema.nullable(),
  refsDigest: digestSchema,
  reachabilityDigest: digestSchema,
  reachableObjectCount: nonNegativeIntegerSchema,
  indexDigest: digestSchema,
  conflictsDigest: digestSchema,
  conflictCount: nonNegativeIntegerSchema,
  trackedDigest: digestSchema,
  trackedCount: nonNegativeIntegerSchema,
  untrackedDigest: digestSchema,
  untrackedCount: nonNegativeIntegerSchema,
  targetAssertions: z.object({
    schemaVersion: z.literal(3),
    selectedHead: objectIdSchema,
    selectedSymbolicRef: nonEmptyStringSchema.nullable(),
    requiredReachableObjects: z.array(objectIdSchema),
    satisfied: z.literal(true)
  }).strict().optional()
}).strict();

export const repositoryDeltaEvidenceSchema = z.object({
  ...evidenceBaseShape,
  kind: z.literal("repository_delta"),
  data: z.object({
    repositoryRoot: nonEmptyStringSchema.optional(),
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
    reachableObjectsAfter: nonNegativeIntegerSchema,
    worktreeDelta: checkpointDeltaSchema.optional(),
    reviewDiff: z.string().optional(),
    reviewDiffPaths: z.array(nonEmptyStringSchema).optional(),
    semanticAssertions: repositorySemanticAssertionsV3Schema.optional(),
    transactionHandle: nonEmptyStringSchema.optional(),
    selectionEvidenceId: nonEmptyStringSchema.optional(),
    candidateId: digestSchema.optional(),
    selectedObject: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u).optional()
  }).strict()
}).strict();

export const repositoryRecoverySelectionEvidenceV1Schema = z.object({
  ...evidenceBaseShape,
  kind: z.literal("repository_recovery_selection"),
  status: z.literal("passed"),
  data: z.object({
    schemaVersion: z.literal(1),
    goalEpoch: nonNegativeIntegerSchema,
    repositoryRoot: nonEmptyStringSchema,
    candidateId: digestSchema,
    selectedObject: objectIdSchema,
    selectionKind: z.enum(["unique", "user_selected"]),
    inspectionBasisDigest: digestSchema,
    inspectedHead: objectIdSchema.nullable(),
    inspectedSymbolicRef: nonEmptyStringSchema.nullable(),
    statusDigest: digestSchema,
    refsDigest: digestSchema,
    reflogDigest: digestSchema,
    repositoryStateDigest: digestSchema
  }).strict()
}).strict();

export const repositoryRecoveryDecisionEvidenceV1Schema = z.object({
  ...evidenceBaseShape,
  kind: z.literal("repository_recovery_decision"),
  status: z.literal("passed"),
  data: z.object({
    schemaVersion: z.literal(1),
    goalEpoch: nonNegativeIntegerSchema,
    repositoryRoot: nonEmptyStringSchema,
    inspectionBasisDigest: digestSchema,
    candidateSetDigest: digestSchema,
    repositoryStateDigest: digestSchema,
    candidates: z.array(z.object({
      candidateId: digestSchema,
      timestamp: z.number().int(),
      relationToHead: z.enum([
        "same", "ancestor_of_head", "descendant_of_head", "diverged", "unknown"
      ]),
      action: z.string().max(128),
      subject: z.string().max(512),
      subjectTrusted: z.literal(false)
    }).strict()).min(2).max(32)
  }).strict()
}).strict();

export const repositoryAcceptanceEvidenceV1Schema = z.object({
  ...evidenceBaseShape,
  kind: z.literal("repository_acceptance"),
  status: z.literal("passed"),
  data: z.object({
    schemaVersion: z.literal(1),
    goalEpoch: nonNegativeIntegerSchema,
    frontierRevision: nonNegativeIntegerSchema,
    frontierStateDigest: digestSchema,
    repositoryRoot: nonEmptyStringSchema,
    transactionHandle: nonEmptyStringSchema,
    operationClasses: z.array(nonEmptyStringSchema).min(1),
    repositoryStateDigest: digestSchema,
    selectionEvidenceId: nonEmptyStringSchema.optional(),
    candidateId: digestSchema.optional(),
    semanticAssertions: repositorySemanticAssertionsV3Schema
  }).strict().superRefine((value, context) => {
    if ((value.selectionEvidenceId === undefined) !== (value.candidateId === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["selectionEvidenceId"],
        message: "Repository recovery acceptance must bind both selection evidence and candidate id"
      });
    }
  })
}).strict();
