import { z } from "zod";
import {
  budgetAmountsSchema,
  budgetLimitsSchema,
  budgetReservationSchema,
  dateTimeSchema,
  nonEmptyStringSchema
} from "./domain-schemas.js";

const mutationTotalsSchema = z.object({
  consumed: budgetAmountsSchema,
  reserved: budgetAmountsSchema
}).strict();

export const budgetReserveMutationSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("reserve"),
  reservation: budgetReservationSchema,
  totals: mutationTotalsSchema
}).strict();

export const budgetSettleMutationSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("settle"),
  reservationId: nonEmptyStringSchema,
  status: z.enum(["committed", "released"]),
  consumed: budgetAmountsSchema,
  settledAt: dateTimeSchema,
  totals: mutationTotalsSchema
}).strict();

export const budgetBindMutationSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("bind"),
  reservationId: nonEmptyStringSchema,
  ownerId: nonEmptyStringSchema
}).strict();

export const budgetLimitMutationSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("limit"),
  increase: budgetLimitsSchema,
  limits: budgetLimitsSchema
}).strict();

/** Fixed-size event-log mutations; complete ledgers live in snapshots. */
export const budgetMutationSchema = z.discriminatedUnion("kind", [
  budgetReserveMutationSchema,
  budgetSettleMutationSchema,
  budgetBindMutationSchema,
  budgetLimitMutationSchema
]);
