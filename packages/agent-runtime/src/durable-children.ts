import type { AgentEventEnvelope, JsonValue, RunStore } from "agent-protocol";
import type { ChildJoinSummary } from "./types.js";

interface DurableChild {
  childId: string;
  detached: boolean;
  completed?: Record<string, JsonValue>;
  integrated: boolean;
}

function record(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function childEvent(event: AgentEventEnvelope): { childId: string; detail: Record<string, JsonValue> } | null {
  if (!event.type.startsWith("child.")) return null;
  const outer = record(event.payload);
  if (typeof outer.childId !== "string") return null;
  return { childId: outer.childId, detail: record(outer.payload ?? null) };
}

function failure(child: DurableChild): string | null {
  if (!child.completed) return `Child ${child.childId} was interrupted before a durable terminal outcome; spawn a replacement or resolve it explicitly.`;
  const status = typeof child.completed.status === "string" ? child.completed.status : "unknown";
  if (status !== "completed") return `Child ${child.childId} ended as ${status}.`;
  const isolation = record(child.completed.isolation ?? null);
  if (isolation.kind === "git_worktree" && isolation.cleanup === "retained" && !child.integrated) {
    return `Child ${child.childId} has an unintegrated worktree at ${String(isolation.worktreePath ?? "unknown")}.`;
  }
  return null;
}

export async function auditDurableChildren(
  store: RunStore,
  parentSessionId: string,
  excludeIds: ReadonlySet<string> = new Set()
): Promise<ChildJoinSummary> {
  const children = new Map<string, DurableChild>();
  for await (const event of store.events(parentSessionId)) {
    const parsed = childEvent(event);
    if (!parsed || excludeIds.has(parsed.childId)) continue;
    if (event.type === "child.spawned") {
      children.set(parsed.childId, {
        childId: parsed.childId,
        detached: parsed.detail.detached === true,
        integrated: false
      });
      continue;
    }
    const child = children.get(parsed.childId);
    if (!child) continue;
    if (event.type === "child.completed") child.completed = parsed.detail;
    if (event.type === "child.message" && parsed.detail.kind === "integrated") child.integrated = true;
  }
  const joined = [...children.values()].filter((child) => !child.detached);
  return {
    evidence: joined.map((child) => ({
      childId: child.childId,
      status: child.completed?.status ?? "interrupted",
      isolation: child.completed?.isolation ?? null,
      integrated: child.integrated
    })),
    failures: joined.flatMap((child) => {
      const value = failure(child);
      return value ? [value] : [];
    })
  };
}
