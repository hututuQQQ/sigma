import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { truncateMiddle } from "../compaction.js";
import { isPathInside } from "../policy.js";

export type MemoryKind = "user" | "feedback" | "project" | "reference" | "agent" | "subagent";

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string[];
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySearchResult extends MemoryRecord {
  score: number;
  reason: string;
}

const MEMORY_KINDS = new Set<MemoryKind>(["user", "feedback", "project", "reference", "agent", "subagent"]);

function memoryRoot(workspacePath: string): string {
  return path.join(path.resolve(workspacePath), ".agent", "memory");
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || randomUUID();
}

function kindValue(value: unknown): MemoryKind {
  return MEMORY_KINDS.has(value as MemoryKind) ? value as MemoryKind : "project";
}

function parseFrontmatter(text: string): { metadata: Record<string, string>; body: string } {
  if (!text.startsWith("---\n")) return { metadata: {}, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { metadata: {}, body: text };
  const metadata: Record<string, string> = {};
  for (const line of text.slice(4, end).split(/\r?\n/)) {
    const boundary = line.indexOf(":");
    if (boundary === -1) continue;
    metadata[line.slice(0, boundary).trim()] = line.slice(boundary + 1).trim();
  }
  return { metadata, body: text.slice(end + 5).trimStart() };
}

function formatMemory(record: Omit<MemoryRecord, "path">): string {
  return [
    "---",
    `id: ${record.id}`,
    `kind: ${record.kind}`,
    `title: ${record.title}`,
    `tags: ${record.tags.join(", ")}`,
    `createdAt: ${record.createdAt}`,
    `updatedAt: ${record.updatedAt}`,
    "---",
    "",
    record.content.trim(),
    ""
  ].join("\n");
}

function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9_.@/$+-]+/).filter((token) => token.length >= 2))];
}

function scoreMemory(record: MemoryRecord, tokens: string[]): MemorySearchResult | null {
  if (tokens.length === 0) return null;
  const haystack = `${record.title}\n${record.tags.join(" ")}\n${record.content}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (record.title.toLowerCase().includes(token)) score += 8;
    if (record.tags.some((tag) => tag.toLowerCase().includes(token))) score += 5;
    if (haystack.includes(token)) score += 2;
  }
  if (score <= 0) return null;
  return { ...record, score, reason: "lexical memory match" };
}

async function memoryFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }
  await visit(root);
  return files;
}

function allowedScopes(scopes?: MemoryKind[]): Set<MemoryKind> | null {
  if (!scopes || scopes.length === 0) return null;
  return new Set(scopes.filter((scope) => MEMORY_KINDS.has(scope)));
}

export async function listMemories(workspacePath: string, options: { scopes?: MemoryKind[] } = {}): Promise<MemoryRecord[]> {
  const root = memoryRoot(workspacePath);
  const scopes = allowedScopes(options.scopes);
  const records: MemoryRecord[] = [];
  for (const filePath of await memoryFiles(root)) {
    const text = await readFile(filePath, "utf8");
    const parsed = parseFrontmatter(text);
    const id = parsed.metadata.id || path.basename(filePath, ".md");
    const kind = kindValue(parsed.metadata.kind);
    if (scopes && !scopes.has(kind)) continue;
    const info = await stat(filePath);
    records.push({
      id,
      kind,
      title: parsed.metadata.title || id,
      content: parsed.body.trim(),
      tags: (parsed.metadata.tags ?? "").split(",").map((tag) => tag.trim()).filter(Boolean),
      path: path.relative(path.resolve(workspacePath), filePath).split(path.sep).join("/"),
      createdAt: parsed.metadata.createdAt || new Date(info.birthtimeMs).toISOString(),
      updatedAt: parsed.metadata.updatedAt || new Date(info.mtimeMs).toISOString()
    });
  }
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title, "en"));
}

export async function readMemory(workspacePath: string, idOrPath: string, options: { scopes?: MemoryKind[] } = {}): Promise<MemoryRecord | null> {
  const normalized = idOrPath.replace(/\\/g, "/");
  const records = await listMemories(workspacePath, options);
  return records.find((record) => record.id === normalized || record.path === normalized || record.path.endsWith(`/${normalized}.md`)) ?? null;
}

export async function writeMemory(options: {
  workspacePath: string;
  kind?: unknown;
  title: string;
  content: string;
  tags?: string[];
  id?: string;
}): Promise<MemoryRecord> {
  const root = memoryRoot(options.workspacePath);
  const kind = kindValue(options.kind);
  const now = new Date().toISOString();
  const id = safeId(options.id ?? `${kind}-${options.title.toLowerCase()}`);
  const filePath = path.join(root, kind, `${id}.md`);
  if (!isPathInside(root, filePath)) throw new Error("Memory path escaped memory root.");
  await mkdir(path.dirname(filePath), { recursive: true });
  const existing = await readMemory(options.workspacePath, id);
  const record: Omit<MemoryRecord, "path"> = {
    id,
    kind,
    title: options.title.trim() || id,
    content: options.content.trim(),
    tags: options.tags ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  await writeFile(filePath, formatMemory(record), "utf8");
  return {
    ...record,
    path: path.relative(path.resolve(options.workspacePath), filePath).split(path.sep).join("/")
  };
}

export async function searchMemories(options: {
  workspacePath: string;
  query: string;
  limit?: number;
  scopes?: MemoryKind[];
}): Promise<MemorySearchResult[]> {
  const tokens = tokenize(options.query);
  const scored = (await listMemories(options.workspacePath, { scopes: options.scopes }))
    .map((record) => scoreMemory(record, tokens))
    .filter((record): record is MemorySearchResult => Boolean(record));
  return scored
    .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(1, Math.min(20, options.limit ?? 5)));
}

export function formatMemorySnippet(record: MemoryRecord, maxChars = 1200): string {
  const content = truncateMiddle(record.content.replace(/\s+/g, " ").trim(), maxChars).text;
  return `- [${record.kind}] ${record.title} (${record.id}): ${content}`;
}
