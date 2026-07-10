export interface TranscriptItem {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  streaming: boolean;
  occurredAt: string;
}

export interface ActivityItem {
  id: string;
  kind: "model" | "tool" | "child" | "diagnostic";
  title: string;
  detail: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  occurredAt: string;
}

export interface ApprovalItem {
  requestId: string;
  toolName: string;
  reason: string;
  status: "pending" | "allowed" | "denied";
}

export interface PresentationState {
  sessionId?: string;
  runId?: string;
  status: "idle" | "running" | "needs_input" | "completed" | "failed" | "cancelled";
  transcript: TranscriptItem[];
  activity: ActivityItem[];
  approvals: ApprovalItem[];
  lastSeq: number;
  contextTokens?: number;
}

export function createPresentationState(): PresentationState {
  return { status: "idle", transcript: [], activity: [], approvals: [], lastSeq: 0 };
}
