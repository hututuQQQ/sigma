import { z } from "zod";
import type { AnyTypedAgentEvent, ExternalEvaluationReport, ProtocolValidationIssue } from "./events.js";
import { jsonValueSchema } from "./domain-schemas.js";
import type { JsonValue } from "./json.js";
import { SNAPSHOT_SCHEMA_VERSION, STORE_LAYOUT_VERSION } from "./versions.js";

export interface SnapshotEnvelope<TState extends JsonValue = JsonValue> {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  storeLayoutVersion: typeof STORE_LAYOUT_VERSION;
  sessionId: string;
  seq: number;
  createdAt: string;
  state: TState;
}

export interface StoreAppendResult {
  rotated: boolean;
}

export interface RunStore {
  append(event: AnyTypedAgentEvent, expectedSeq: number): Promise<StoreAppendResult>;
  events(sessionId: string, afterSeq?: number): AsyncIterable<AnyTypedAgentEvent>;
  writeSnapshot(snapshot: SnapshotEnvelope): Promise<void>;
  latestSnapshot(sessionId: string): Promise<SnapshotEnvelope | null>;
  listSessions(): Promise<Array<{ sessionId: string; updatedAt: string; lastSeq: number }>>;
}

export interface EvaluationSink {
  append(report: ExternalEvaluationReport): Promise<void>;
}

const snapshotEnvelopeSchema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
  storeLayoutVersion: z.literal(STORE_LAYOUT_VERSION),
  sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  createdAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), "Invalid date-time"),
  state: jsonValueSchema
}).strict();

export class SnapshotValidationError extends Error {
  readonly code = "invalid_snapshot_envelope";

  constructor(readonly issues: readonly ProtocolValidationIssue[]) {
    const details = issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
    super(`Invalid SnapshotEnvelope V${SNAPSHOT_SCHEMA_VERSION}: ${details}`);
    this.name = "SnapshotValidationError";
  }
}

export function isSnapshotEnvelope(value: unknown): value is SnapshotEnvelope {
  return snapshotEnvelopeSchema.safeParse(value).success;
}

export function assertSnapshotEnvelope(value: unknown): asserts value is SnapshotEnvelope {
  const result = snapshotEnvelopeSchema.safeParse(value);
  if (result.success) return;
  throw new SnapshotValidationError(result.error.issues.map((issue) => ({
    path: issue.path.map((part) => typeof part === "symbol" ? String(part) : part),
    code: issue.code,
    message: issue.message
  })));
}
