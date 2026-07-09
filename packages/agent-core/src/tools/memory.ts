import { truncateMiddle } from "../compaction.js";
import {
  formatMemorySnippet,
  listMemories,
  readMemory,
  searchMemories,
  writeMemory,
  type MemoryKind
} from "../memory/local-memory.js";
import { requestToolPermission } from "../policy.js";
import type { ToolExecutionContext, ToolResult } from "../types.js";

interface MemoryArgs {
  action?: unknown;
  id?: unknown;
  kind?: unknown;
  title?: unknown;
  content?: unknown;
  query?: unknown;
  tags?: unknown;
  limit?: unknown;
  maxChars?: unknown;
}

function numberOrDefault(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function actionValue(value: unknown): "list" | "read" | "search" | "write" {
  return value === "read" || value === "search" || value === "write" ? value : "list";
}

function kindValue(value: unknown): MemoryKind | undefined {
  return value === "user" || value === "feedback" || value === "project" || value === "reference" ? value : undefined;
}

export async function executeMemoryTool(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  const parsed = (args && typeof args === "object" ? args : {}) as MemoryArgs;
  const action = actionValue(parsed.action);
  const maxChars = numberOrDefault(parsed.maxChars, context.maxToolOutputChars, 500, 50000);

  try {
    if (action === "list") {
      const memories = await listMemories(context.workspacePath);
      const content = JSON.stringify({ memories: memories.map(({ content, ...record }) => ({ ...record, chars: content.length })) }, null, 2);
      return {
        ok: true,
        modelContent: truncateMiddle(content, maxChars).text,
        structured: memories,
        modelMetadata: { count: memories.length },
        actualResources: [{ kind: "memory", mode: "read" }]
      };
    }

    if (action === "read") {
      if (typeof parsed.id !== "string" || parsed.id.trim().length === 0) {
        return { ok: false, modelContent: "memory.read requires id" };
      }
      const memory = await readMemory(context.workspacePath, parsed.id);
      if (!memory) return { ok: false, modelContent: `Memory not found: ${parsed.id}` };
      return {
        ok: true,
        modelContent: truncateMiddle(formatMemorySnippet(memory, maxChars), maxChars).text,
        structured: memory,
        modelMetadata: { id: memory.id, kind: memory.kind, path: memory.path },
        actualResources: [{ kind: "memory", mode: "read", path: memory.path }]
      };
    }

    if (action === "search") {
      if (typeof parsed.query !== "string" || parsed.query.trim().length === 0) {
        return { ok: false, modelContent: "memory.search requires query" };
      }
      const results = await searchMemories({
        workspacePath: context.workspacePath,
        query: parsed.query,
        limit: numberOrDefault(parsed.limit, 5, 1, 20)
      });
      const content = results.length > 0
        ? results.map((record) => formatMemorySnippet(record, 1000)).join("\n")
        : "No relevant memories found.";
      return {
        ok: true,
        modelContent: truncateMiddle(content, maxChars).text,
        structured: results,
        modelMetadata: { count: results.length },
        actualResources: [{ kind: "memory", mode: "read" }]
      };
    }

    if (typeof parsed.title !== "string" || parsed.title.trim().length === 0) {
      return { ok: false, modelContent: "memory.write requires title" };
    }
    if (typeof parsed.content !== "string" || parsed.content.trim().length === 0) {
      return { ok: false, modelContent: "memory.write requires content" };
    }
    const kind = kindValue(parsed.kind);
    const denied = await requestToolPermission(context, {
      toolName: "memory",
      arguments: parsed,
      risk: "write",
      reason: `Write durable memory ${kind ?? "project"}/${parsed.title.trim()}`,
      resources: [{ kind: "memory", mode: "write", description: "durable local memory" }]
    });
    if (denied) return denied;

    const memory = await writeMemory({
      workspacePath: context.workspacePath,
      id: typeof parsed.id === "string" ? parsed.id : undefined,
      kind,
      title: parsed.title,
      content: parsed.content,
      tags: stringArray(parsed.tags)
    });
    return {
      ok: true,
      modelContent: `Saved memory ${memory.id} at ${memory.path}.`,
      structured: memory,
      modelMetadata: { id: memory.id, kind: memory.kind, path: memory.path },
      actualResources: [{ kind: "memory", mode: "write", path: memory.path }]
    };
  } catch (error) {
    return { ok: false, modelContent: error instanceof Error ? error.message : String(error) };
  }
}
