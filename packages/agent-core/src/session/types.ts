import type { AgentEvent } from "../types.js";

export interface SessionRecord {
  id: string;
  timestamp: string;
  type: string;
  runId: string;
  parentId?: string;
  provider?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export type SessionAppendable = AgentEvent | SessionRecord;
