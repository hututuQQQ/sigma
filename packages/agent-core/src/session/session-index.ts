import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { redactSecrets, redactSecretText } from "../redaction.js";
import type {
  DurableSessionMeta,
  SessionIndexRecord,
  SessionResumeContext,
  SessionSearchResult
} from "./session-types.js";

export function defaultSessionRootDir(workspacePath: string): string {
  return path.join(path.resolve(workspacePath), ".agent", "sessions");
}

export function sessionIndexPath(rootDir: string): string {
  return path.join(path.resolve(rootDir), "index.jsonl");
}

export function sessionDir(rootDir: string, sessionId: string): string {
  return path.join(path.resolve(rootDir), sessionId);
}

export async function appendSessionIndexRecord(rootDir: string, record: SessionIndexRecord): Promise<void> {
  const indexPath = sessionIndexPath(rootDir);
  await mkdir(path.dirname(indexPath), { recursive: true });
  await appendFile(indexPath, `${JSON.stringify(redactSecrets(record))}\n`, "utf8");
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function readSessionIndex(rootDir: string): Promise<SessionIndexRecord[]> {
  let content = "";
  try {
    content = await readFile(sessionIndexPath(rootDir), "utf8");
  } catch {
    return [];
  }
  const latest = new Map<string, SessionIndexRecord>();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as SessionIndexRecord;
      if (typeof record.sessionId === "string") latest.set(record.sessionId, record);
    } catch {
      // A partially written JSONL line should not make the whole history unreadable.
    }
  }
  return [...latest.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function listSessions(options: {
  workspacePath?: string;
  sessionRootDir?: string;
  limit?: number;
} = {}): Promise<SessionIndexRecord[]> {
  const rootDir = options.sessionRootDir ?? defaultSessionRootDir(options.workspacePath ?? process.cwd());
  const workspace = options.workspacePath ? path.resolve(options.workspacePath) : null;
  const limit = Math.max(1, Math.floor(options.limit ?? 50));
  return (await readSessionIndex(rootDir))
    .filter((record) => (workspace ? path.resolve(record.workspacePath) === workspace : true))
    .slice(0, limit);
}

export async function loadSessionMeta(options: {
  sessionId: string;
  workspacePath?: string;
  sessionRootDir?: string;
}): Promise<DurableSessionMeta | null> {
  const rootDir = options.sessionRootDir ?? defaultSessionRootDir(options.workspacePath ?? process.cwd());
  const direct = await readJsonFile<DurableSessionMeta>(path.join(sessionDir(rootDir, options.sessionId), "meta.json"));
  if (direct) return direct;

  const indexed = (await readSessionIndex(rootDir)).find((record) => record.sessionId === options.sessionId);
  if (!indexed) return null;
  return await readJsonFile<DurableSessionMeta>(path.join(path.dirname(indexed.eventsPath), "meta.json"));
}

export async function readSessionEventsText(eventsPath: string): Promise<string> {
  try {
    return await readFile(eventsPath, "utf8");
  } catch {
    return "";
  }
}

export async function readSessionSummaryText(summaryPath: string): Promise<string> {
  try {
    return await readFile(summaryPath, "utf8");
  } catch {
    return "";
  }
}

function compactText(value: string, maxChars: number): string {
  const normalized = redactSecretText(value).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 15))}...[truncated]`;
}

function eventSearchText(rawEventLine: string): string {
  try {
    const event = JSON.parse(rawEventLine) as {
      type?: string;
      timestamp?: string;
      metadata?: Record<string, unknown>;
    };
    return compactText(JSON.stringify({
      type: event.type,
      timestamp: event.timestamp,
      metadata: event.metadata
    }), 800);
  } catch {
    return compactText(rawEventLine, 800);
  }
}

export async function searchSessions(options: {
  query: string;
  workspacePath?: string;
  sessionRootDir?: string;
  limit?: number;
}): Promise<SessionSearchResult[]> {
  const tokens = options.query.toLowerCase().split(/\s+/).map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0) return [];
  const sessions = await listSessions({
    workspacePath: options.workspacePath,
    sessionRootDir: options.sessionRootDir,
    limit: 500
  });
  const results: SessionSearchResult[] = [];
  for (const session of sessions) {
    const summaryText = await readSessionSummaryText(session.summaryPath);
    const eventsText = await readSessionEventsText(session.eventsPath);
    const haystacks = [
      { label: "title", text: session.title },
      { label: "instruction", text: session.instruction },
      { label: "final", text: session.finalMessage ?? "" },
      { label: "error", text: session.lastError ?? "" },
      { label: "summary", text: summaryText },
      { label: "events", text: eventsText }
    ];
    let score = 0;
    const matches: string[] = [];
    for (const haystack of haystacks) {
      const lower = haystack.text.toLowerCase();
      const hits = tokens.filter((token) => lower.includes(token));
      if (hits.length === 0) continue;
      score += hits.length * (haystack.label === "title" || haystack.label === "instruction" ? 6 : 2);
      matches.push(`${haystack.label}: ${compactText(haystack.text, 220)}`);
    }
    if (score > 0) results.push({ session, score, matches });
  }
  return results
    .sort((a, b) => b.score - a.score || b.session.updatedAt.localeCompare(a.session.updatedAt))
    .slice(0, Math.max(1, Math.floor(options.limit ?? 20)));
}

export async function loadSessionResumeContext(options: {
  sessionId: string;
  workspacePath?: string;
  sessionRootDir?: string;
  maxEvents?: number;
}): Promise<SessionResumeContext | null> {
  const session = await loadSessionMeta(options);
  if (!session) return null;
  const summaryText = await readSessionSummaryText(session.summaryPath);
  const eventLines = (await readSessionEventsText(session.eventsPath)).trim().split(/\r?\n/).filter(Boolean);
  const recentEvents = eventLines.slice(-Math.max(1, Math.floor(options.maxEvents ?? 12))).map((line) => {
    try {
      const event = JSON.parse(line) as { type?: string; timestamp?: string };
      return {
        type: event.type ?? "event",
        timestamp: event.timestamp,
        text: eventSearchText(line)
      };
    } catch {
      return { type: "event", text: eventSearchText(line) };
    }
  });
  return {
    session,
    summaryText: compactText(summaryText, 4000),
    finalMessage: session.finalMessage ? compactText(session.finalMessage, 1200) : undefined,
    recentEvents
  };
}

export function buildResumeInstruction(options: {
  context: SessionResumeContext;
  instruction: string;
  mode: "resume" | "fork";
}): string {
  const lines = [
    `Previous Sigma session context (${options.mode}):`,
    `- sessionId: ${options.context.session.sessionId}`,
    `- workspacePath: ${options.context.session.workspacePath}`,
    `- status: ${options.context.session.status}`,
    options.context.session.finishReason ? `- finishReason: ${options.context.session.finishReason}` : "",
    options.context.session.changedFiles.length > 0
      ? `- changedFiles: ${options.context.session.changedFiles.join(", ")}`
      : "",
    "",
    "Prior final message:",
    options.context.finalMessage ?? "(none recorded)",
    "",
    "Prior summary:",
    options.context.summaryText || "(none recorded)",
    "",
    "Recent prior events:",
    ...options.context.recentEvents.map((event) => `- ${event.timestamp ?? ""} ${event.type}: ${event.text}`.trim()),
    "",
    "New instruction:",
    options.instruction
  ].filter((line) => line !== "");
  return lines.join("\n");
}

export function sessionIndexRecordFromMeta(meta: DurableSessionMeta): SessionIndexRecord {
  return {
    sessionId: meta.sessionId,
    title: meta.title,
    instruction: meta.instruction,
    workspacePath: meta.workspacePath,
    provider: meta.provider,
    model: meta.model,
    status: meta.status,
    ...(meta.finishReason ? { finishReason: meta.finishReason } : {}),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...(meta.durationMs !== undefined ? { durationMs: meta.durationMs } : {}),
    changedFiles: meta.changedFiles,
    summaryPath: meta.summaryPath,
    eventsPath: meta.eventsPath,
    ...(meta.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
    ...(meta.forkedFromSessionId ? { forkedFromSessionId: meta.forkedFromSessionId } : {}),
    ...(meta.finalMessage ? { finalMessage: meta.finalMessage } : {}),
    ...(meta.lastError !== undefined ? { lastError: meta.lastError } : {})
  };
}
