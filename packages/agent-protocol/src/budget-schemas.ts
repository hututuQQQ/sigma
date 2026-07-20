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

const mutationTotalsSchema = z.object({
  consumed: budgetAmountsSchema,
  reserved: budgetAmountsSchema
}).strict();

export const budgetReserveMutationV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("reserve"),
  reservation: budgetReservationSchema,
  totals: mutationTotalsSchema
}).strict();

export const budgetSettleMutationV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("settle"),
  reservationId: nonEmptyStringSchema,
  status: z.enum(["committed", "released"]),
  consumed: budgetAmountsSchema,
  settledAt: dateTimeSchema,
  totals: mutationTotalsSchema
}).strict();

export const budgetBindMutationV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("bind"),
  reservationId: nonEmptyStringSchema,
  ownerId: nonEmptyStringSchema
}).strict();

export const budgetLimitMutationV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("limit"),
  increase: budgetLimitsSchema,
  limits: budgetLimitsSchema
}).strict();

/** Fixed-size event-log mutations; complete ledgers live in snapshots. */
export const budgetMutationV1Schema = z.discriminatedUnion("kind", [
  budgetReserveMutationV1Schema,
  budgetSettleMutationV1Schema,
  budgetBindMutationV1Schema,
  budgetLimitMutationV1Schema
]);
