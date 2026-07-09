import type { AgentEventEnvelope, ExternalEvaluationReport } from "./events.js";
import type { JsonValue } from "./json.js";

export interface SnapshotEnvelope {
  schemaVersion: 2;
  sessionId: string;
  seq: number;
  createdAt: string;
  state: JsonValue;
}

export interface StoreAppendResult {
  rotated: boolean;
}

export interface RunStore {
  append(event: AgentEventEnvelope, expectedSeq: number): Promise<StoreAppendResult>;
  events(sessionId: string, afterSeq?: number): AsyncIterable<AgentEventEnvelope>;
  writeSnapshot(snapshot: SnapshotEnvelope): Promise<void>;
  latestSnapshot(sessionId: string): Promise<SnapshotEnvelope | null>;
  listSessions(): Promise<Array<{ sessionId: string; updatedAt: string; lastSeq: number }>>;
}

export interface EvaluationSink {
  append(report: ExternalEvaluationReport): Promise<void>;
}
