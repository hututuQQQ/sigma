import path from "node:path";
import type { RuntimeSession } from "./types.js";
import type { ReviewerWorkspaceRead } from "./reviewer.js";

const MAX_REVIEW_WORKSPACE_READS = 8;
const MAX_REVIEW_WORKSPACE_READ_CHARS = 64_000;
const MAX_REVIEW_WORKSPACE_READ_CHARS_PER_FILE = 24_000;

interface WorkspaceReadCandidate {
  key: string;
  snapshot: ReviewerWorkspaceRead;
  receiptIndex: number;
}

interface RecordedToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function normalizedWorkspacePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "");
}

function goalMentionsPath(goal: string, candidate: string): boolean {
  const normalizedGoal = goal.replaceAll("\\", "/").toLowerCase();
  const normalized = normalizedWorkspacePath(candidate).toLowerCase();
  const basename = path.posix.basename(normalized);
  return normalized.length >= 3 && normalizedGoal.includes(normalized)
    || basename.length >= 3 && normalizedGoal.includes(basename);
}

function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? Number(value) : undefined;
}

function workspaceReadMetadata(
  result: Record<string, unknown>,
  requestedPath: string
): Omit<ReviewerWorkspaceRead, "content"> {
  const offset = safeInteger(result.offset);
  const returnedLines = safeInteger(result.returnedLines);
  const totalLines = safeInteger(result.totalLines);
  const metadata: Omit<ReviewerWorkspaceRead, "content"> = {
    path: normalizedWorkspacePath(typeof result.path === "string" ? result.path : requestedPath),
    complete: offset === 0 && returnedLines !== undefined
      && totalLines !== undefined && returnedLines === totalLines
  };
  if (typeof result.sha256 === "string") metadata.sha256 = result.sha256;
  const byteLength = safeInteger(result.byteLength);
  if (byteLength !== undefined) metadata.byteLength = byteLength;
  if (offset !== undefined) metadata.offset = offset;
  if (returnedLines !== undefined) metadata.returnedLines = returnedLines;
  if (totalLines !== undefined) metadata.totalLines = totalLines;
  return metadata;
}

function workspaceReadSnapshot(
  session: RuntimeSession,
  callId: string,
  requestedPath: string
): ReviewerWorkspaceRead | null {
  const receipt = session.durable.state.receipts.find((item) => item.callId === callId);
  const result = record(receipt?.result);
  if (!receipt?.ok || !result || result.status !== "read" || result.scope !== "workspace") return null;
  const content = receipt.output.slice(0, MAX_REVIEW_WORKSPACE_READ_CHARS_PER_FILE);
  const metadata = workspaceReadMetadata(result, requestedPath);
  return {
    ...metadata,
    complete: metadata.complete && content.length === receipt.output.length,
    content
  };
}

function lastWorkspaceMutationByPath(session: RuntimeSession): Map<string, number> {
  const lastMutationByPath = new Map<string, number>();
  for (const [index, receipt] of session.durable.state.receipts.entries()) {
    const delta = receipt.workspaceDelta;
    for (const changedPath of [
      ...(delta?.added ?? []),
      ...(delta?.modified ?? []),
      ...(delta?.deleted ?? [])
    ]) {
      lastMutationByPath.set(normalizedWorkspacePath(changedPath).toLowerCase(), index);
    }
  }
  return lastMutationByPath;
}

function recordedAssistantToolCalls(session: RuntimeSession): RecordedToolCall[] {
  const calls: RecordedToolCall[] = [];
  for (const message of session.durable.state.messages) {
    if (message.role !== "assistant") continue;
    calls.push(...(message.toolCalls ?? []));
  }
  return calls;
}

function workspaceReadCandidate(
  session: RuntimeSession,
  call: RecordedToolCall,
  goal: string,
  receiptPositions: ReadonlyMap<string, number>
): WorkspaceReadCandidate | null {
  if (call.name !== "read") return null;
  const argumentsValue = record(call.arguments);
  const requestedPath = typeof argumentsValue?.path === "string" ? argumentsValue.path : "";
  const normalized = normalizedWorkspacePath(requestedPath);
  if (!normalized || !goalMentionsPath(goal, normalized)) return null;
  const snapshot = workspaceReadSnapshot(session, call.id, normalized);
  const receiptIndex = receiptPositions.get(call.id);
  if (!snapshot || receiptIndex === undefined) return null;
  return {
    key: normalizedWorkspacePath(snapshot.path).toLowerCase(),
    snapshot,
    receiptIndex
  };
}

function preferredWorkspaceRead(
  previous: WorkspaceReadCandidate | undefined,
  candidate: WorkspaceReadCandidate
): WorkspaceReadCandidate {
  if (!previous || candidate.receiptIndex <= previous.receiptIndex) return previous ?? candidate;
  const sameContent = previous.snapshot.sha256 !== undefined
    && previous.snapshot.sha256 === candidate.snapshot.sha256;
  // A later partial read can prove that an earlier complete snapshot is
  // still current when both receipts carry the same authenticated digest.
  // Otherwise the latest read must win, even when it is incomplete.
  return sameContent && previous.snapshot.complete && !candidate.snapshot.complete
    ? { ...previous, receiptIndex: candidate.receiptIndex }
    : candidate;
}

function boundedCurrentWorkspaceReads(
  selected: ReadonlyMap<string, WorkspaceReadCandidate>,
  lastMutationByPath: ReadonlyMap<string, number>
): ReviewerWorkspaceRead[] {
  const current = [...selected.values()]
    .filter((candidate) =>
      candidate.receiptIndex > (lastMutationByPath.get(candidate.key) ?? -1))
    .sort((left, right) => right.receiptIndex - left.receiptIndex)
    .slice(0, MAX_REVIEW_WORKSPACE_READS);
  const snapshots: ReviewerWorkspaceRead[] = [];
  let remainingChars = MAX_REVIEW_WORKSPACE_READ_CHARS;
  for (const candidate of current) {
    if (remainingChars === 0) break;
    const content = candidate.snapshot.content.slice(0, remainingChars);
    snapshots.push({
      ...candidate.snapshot,
      complete: candidate.snapshot.complete
        && content.length === candidate.snapshot.content.length,
      content
    });
    remainingChars -= content.length;
  }
  return snapshots;
}

export function goalReferencedWorkspaceReads(session: RuntimeSession): ReviewerWorkspaceRead[] {
  const receiptPositions = new Map(
    session.durable.state.receipts.map((receipt, index) => [receipt.callId, index])
  );
  const selected = new Map<string, WorkspaceReadCandidate>();
  for (const call of recordedAssistantToolCalls(session)) {
    const candidate = workspaceReadCandidate(
      session,
      call,
      session.durable.state.plan.goal,
      receiptPositions
    );
    if (!candidate) continue;
    selected.set(candidate.key, preferredWorkspaceRead(selected.get(candidate.key), candidate));
  }
  return boundedCurrentWorkspaceReads(selected, lastWorkspaceMutationByPath(session));
}
