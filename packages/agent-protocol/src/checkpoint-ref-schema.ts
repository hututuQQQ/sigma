import { z } from "zod";
import {
  checkpointDeltaSchema,
  dateTimeSchema,
  nonEmptyStringSchema
} from "./domain-schema-primitives.js";

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
