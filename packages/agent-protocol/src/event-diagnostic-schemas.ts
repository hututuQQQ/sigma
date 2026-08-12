import { z } from "zod";
import { nonEmptyStringSchema } from "./domain-schemas.js";

export const contextCapacityRecoveryDiagnosticSchema = z.object({
  kind: z.literal("context.capacity_recovery"),
  source: z.enum(["planner", "router"]),
  action: z.enum(["terminal_fallback", "budget_exhausted"]),
  routeId: nonEmptyStringSchema.optional(),
  rejections: z.array(z.object({
    modelSpecId: nonEmptyStringSchema,
    detail: nonEmptyStringSchema
  }).strict()).max(32)
}).strict();
