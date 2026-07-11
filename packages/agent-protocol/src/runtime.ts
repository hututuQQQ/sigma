import type { AgentEventEnvelope } from "./events.js";
import type { CheckpointRef } from "./domain.js";
import type { RunCommand, RunMode, RunOutcome } from "./outcomes.js";

export interface SessionRef {
  sessionId: string;
  runId: string;
}

export interface StartSession {
  workspacePath: string;
  mode: RunMode;
  title?: string;
  writeScope?: string[];
  strictWriteScope?: boolean;
  reviewerWaiverReason?: string;
}

export interface SessionOverview {
  sessionId: string;
  workspacePath: string;
  mode: RunMode;
  status: "idle" | "running" | "needs_input" | "completed" | "cancelled" | "failed";
  updatedAt: string;
  lastSeq: number;
  lastMessage?: string;
}

export interface RuntimeClient {
  createSession(input: StartSession): Promise<SessionRef>;
  command(command: RunCommand): Promise<void>;
  subscribe(sessionId: string, signal?: AbortSignal): AsyncIterable<AgentEventEnvelope>;
  waitForOutcome(sessionId: string, signal?: AbortSignal): Promise<RunOutcome>;
  listSessions(limit?: number): Promise<SessionOverview[]>;
  sessionEvents(sessionId: string, afterSeq?: number): AsyncIterable<AgentEventEnvelope>;
  releaseSession?(sessionId: string): Promise<void>;
  /** User control-plane operation; never exposed as a model tool. */
  undoLatestCheckpoint?(sessionId: string): Promise<CheckpointRef>;
}
