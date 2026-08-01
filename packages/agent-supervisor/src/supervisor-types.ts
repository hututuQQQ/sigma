import type { JsonValue, RunOutcome, ToolEffect } from "agent-protocol";
import type { ChildRunIntent, ChildWorkspaceIsolation } from "./workspace-isolation.js";

export interface ChildMessage {
  type: "follow_up" | "cancel";
  text?: string;
}

export interface ChildAgentContext {
  childId: string;
  parentId: string;
  runId: string;
  instruction: string;
  intent: ChildRunIntent;
  workspacePath: string;
  sourceWorkspacePath: string;
  isolation: ChildWorkspaceIsolation;
  writeScope: string[];
  delegatedEffects: ToolEffect[];
  signal: AbortSignal;
  mailbox: AsyncIterable<ChildMessage>;
  metadata: JsonValue;
  started(sessionId: string): Promise<void>;
  notify(payload: JsonValue): Promise<void>;
  settling(): void;
}

export interface SpawnChildInput {
  childId?: string;
  parentId: string;
  runId: string;
  instruction: string;
  workspacePath: string;
  intent?: ChildRunIntent;
  writeScope?: string[];
  delegatedEffects?: ToolEffect[];
  detached?: boolean;
  metadata?: JsonValue;
}

export interface ChildAgentResult {
  childId: string;
  outcome: RunOutcome;
  report: JsonValue;
}

export type ChildAgentFactory = (context: ChildAgentContext) => Promise<ChildAgentResult>;

export interface ChildSupervisorEvent {
  type: "child.spawned" | "child.message" | "child.completed";
  parentId: string;
  runId: string;
  childId: string;
  payload: JsonValue;
}

export type ChildEventSink = (event: ChildSupervisorEvent) => Promise<void>;

export interface ChildJob {
  id: string;
  parentId: string;
  runId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  detached: boolean;
  writeScope: string[];
  isolation?: ChildWorkspaceIsolation;
  sessionId?: string;
  result?: ChildAgentResult;
  error?: string;
}
