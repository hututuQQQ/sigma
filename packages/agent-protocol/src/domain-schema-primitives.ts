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
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const evidenceKindSchema = z.enum([
  "workspace_delta", "repository_delta", "command", "validation", "diagnostic",
  "input_access", "review", "checkpoint", "child_outcome", "user_waiver", "restoration"
  , "repository_recovery_selection", "repository_recovery_decision", "repository_acceptance"
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

export const evidenceBaseShape = {
  evidenceId: nonEmptyStringSchema,
  sessionId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  status: evidenceStatusSchema,
  createdAt: dateTimeSchema,
  producer: evidenceProducerSchema,
  summary: nonEmptyStringSchema
};
