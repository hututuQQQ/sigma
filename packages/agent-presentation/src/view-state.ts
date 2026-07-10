export interface TranscriptItem {
  id: string;
  role: "user" | "assistant" | "system";
  delivery?: "submit" | "steer" | "follow_up";
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
  progressPercent?: number;
  occurredAt: string;
}

export interface ApprovalItem {
  requestId: string;
  toolName: string;
  reason: string;
  effects: string[];
  argumentPreview: string;
  argumentPreviewTruncated: boolean;
  status: "pending" | "allowed" | "denied";
}

export interface QueuedFollowUp {
  queueId: string;
  text: string;
  occurredAt: string;
}

export interface PresentationState {
  sessionId?: string;
  runId?: string;
  status: "idle" | "running" | "needs_input" | "completed" | "failed" | "cancelled";
  transcript: TranscriptItem[];
  activity: ActivityItem[];
  approvals: ApprovalItem[];
  queuedFollowUps: QueuedFollowUp[];
  lastSeq: number;
  contextTokens?: number;
}

export function createPresentationState(): PresentationState {
  return { status: "idle", transcript: [], activity: [], approvals: [], queuedFollowUps: [], lastSeq: 0 };
}
