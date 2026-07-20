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
