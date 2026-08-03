import { z } from "zod";
import type { AnyTypedAgentEvent, ExternalEvaluationReport, ProtocolValidationIssue } from "./events.js";
import { jsonValueSchema } from "./domain-schemas.js";
import type { JsonValue } from "./json.js";
import { SNAPSHOT_SCHEMA_VERSION } from "./versions.js";

export interface SnapshotEnvelope<TState extends JsonValue = JsonValue> {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
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
  /** Append one contiguous session transaction with a single durability
   * boundary. Stores that do not implement batching remain compatible and the
   * runtime falls back to append(). */
  appendBatch?(
    events: readonly AnyTypedAgentEvent[],
    expectedSeq: number
  ): Promise<StoreAppendResult>;
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
  sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  createdAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), "Invalid date-time"),
  state: jsonValueSchema
}).strict();

export class SnapshotValidationError extends Error {
  readonly code: "invalid_snapshot_envelope" | "unsupported_schema_version";
  readonly path?: string;
  readonly expected?: number;
  readonly actual?: unknown;

  constructor(
    readonly issues: readonly ProtocolValidationIssue[],
    version?: { path: string; expected: number; actual: unknown }
  ) {
    const details = issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
    super(`Invalid SnapshotEnvelope schema ${SNAPSHOT_SCHEMA_VERSION}: ${details}`);
    this.name = "SnapshotValidationError";
    this.code = version ? "unsupported_schema_version" : "invalid_snapshot_envelope";
    if (version) {
      this.path = version.path;
      this.expected = version.expected;
      this.actual = version.actual;
    }
  }
}

export function isSnapshotEnvelope(value: unknown): value is SnapshotEnvelope {
  return snapshotEnvelopeSchema.safeParse(value).success;
}

export function assertSnapshotEnvelope(value: unknown): asserts value is SnapshotEnvelope {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const actual = (value as Record<string, unknown>).schemaVersion;
    if (actual !== SNAPSHOT_SCHEMA_VERSION) {
      throw new SnapshotValidationError([{
        path: ["schemaVersion"],
        code: "unsupported_schema_version",
        message: `Snapshot schema expected ${SNAPSHOT_SCHEMA_VERSION}, received ${String(actual)}`
      }], { path: "schemaVersion", expected: SNAPSHOT_SCHEMA_VERSION, actual });
    }
  }
  const result = snapshotEnvelopeSchema.safeParse(value);
  if (result.success) return;
  throw new SnapshotValidationError(result.error.issues.map((issue) => ({
    path: issue.path.map((part) => typeof part === "symbol" ? String(part) : part),
    code: issue.code,
    message: issue.message
  })));
}
