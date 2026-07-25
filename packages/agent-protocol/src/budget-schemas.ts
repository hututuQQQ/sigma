import { z } from "zod";
import {
  dateTimeSchema,
  nonEmptyStringSchema,
  nonNegativeIntegerSchema
} from "./domain-schema-primitives.js";

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
