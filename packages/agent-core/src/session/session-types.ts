import type { AgentRunStatus, AgentFinishReason } from "../types.js";

export interface SessionPaths {
  rootDir: string;
  sessionDir: string;
  metaPath: string;
  eventsPath: string;
  summaryPath: string;
  checkpointsDir: string;
  indexPath: string;
}

export interface DurableSessionMeta {
  sessionId: string;
  runId: string;
  title: string;
  instruction: string;
  workspacePath: string;
  provider: string;
  model: string;
  status: AgentRunStatus | "running";
  finishReason?: AgentFinishReason;
  createdAt: string;
  updatedAt: string;
  durationMs?: number;
  changedFiles: string[];
  summaryPath: string;
  eventsPath: string;
  checkpointsDir: string;
  traceJsonlPath?: string;
  sessionJsonlPath?: string;
  compatibilitySummaryPath?: string;
  parentSessionId?: string;
  forkedFromSessionId?: string;
  finalMessage?: string;
  lastError?: string | null;
  toolsAvailable?: string[];
}

export interface SessionIndexRecord {
  sessionId: string;
  title: string;
  instruction: string;
  workspacePath: string;
  provider: string;
  model: string;
  status: DurableSessionMeta["status"];
  finishReason?: AgentFinishReason;
  createdAt: string;
  updatedAt: string;
  durationMs?: number;
  changedFiles: string[];
  summaryPath: string;
  eventsPath: string;
  parentSessionId?: string;
  forkedFromSessionId?: string;
  finalMessage?: string;
  lastError?: string | null;
}

export interface SessionSearchResult {
  session: SessionIndexRecord;
  score: number;
  matches: string[];
}

export interface SessionResumeContext {
  session: DurableSessionMeta;
  summaryText: string;
  finalMessage?: string;
  recentEvents: Array<{
    type: string;
    timestamp?: string;
    text: string;
  }>;
}

export interface CheckpointRecord {
  id: string;
  sessionId: string;
  sequence: number;
  createdAt: string;
  workspacePath: string;
  mode?: "git" | "file";
  toolName: string;
  toolCallId: string;
  ok: boolean;
  changedFiles: string[];
  patchPath?: string;
  fileSnapshotPath?: string;
  skippedFiles?: string[];
  beforeTree?: string;
  afterTree?: string;
  resultSummary: string;
}

export interface CheckpointRestoreResult {
  ok: boolean;
  checkpointId: string;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}
