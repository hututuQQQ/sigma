import type { TodoItem, TodoStatus, ToolExecutionContext, ToolResult } from "../types.js";

interface TodoArgs {
  action?: unknown;
  items?: unknown;
  text?: unknown;
  id?: unknown;
  status?: unknown;
  note?: unknown;
}

function isStatus(value: unknown): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "done" || value === "blocked";
}

function normalizeItem(value: unknown, fallbackId: string): TodoItem {
  if (!value || typeof value !== "object") throw new Error("todo items must be objects");
  const item = value as Partial<TodoItem>;
  if (typeof item.text !== "string" || item.text.trim().length === 0) {
    throw new Error("todo items require non-empty text");
  }
  if (item.status !== undefined && !isStatus(item.status)) {
    throw new Error("todo item status must be pending, in_progress, done, or blocked");
  }
  return {
    id: typeof item.id === "string" || typeof item.id === "number" ? String(item.id) : fallbackId,
    text: item.text,
    status: item.status ?? "pending",
    ...(typeof item.note === "string" ? { note: item.note } : {})
  };
}

function result(items: TodoItem[], changed: boolean): ToolResult {
  return {
    ok: true,
    content: JSON.stringify({ items }, null, 2),
    metadata: { todoItems: items, todoChanged: changed }
  };
}

export async function executeTodoTool(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  const parsed = (args && typeof args === "object" ? args : {}) as TodoArgs;
  const action = parsed.action;
  if (action !== "list" && action !== "set" && action !== "add" && action !== "update" && action !== "clear") {
    return { ok: false, content: "todo requires action: list, set, add, update, or clear" };
  }

  try {
    if (action === "list") {
      return result(context.runState.todos, false);
    }

    if (action === "clear") {
      context.runState.todos = [];
      return result(context.runState.todos, true);
    }

    if (action === "set") {
      if (!Array.isArray(parsed.items)) return { ok: false, content: "todo set requires items array" };
      context.runState.todos = parsed.items.map((item) =>
        normalizeItem(item, String(context.runState.nextTodoId++))
      );
      return result(context.runState.todos, true);
    }

    if (action === "add") {
      if (typeof parsed.text !== "string" || parsed.text.trim().length === 0) {
        return { ok: false, content: "todo add requires non-empty text" };
      }
      const item: TodoItem = {
        id: String(context.runState.nextTodoId++),
        text: parsed.text,
        status: "pending",
        ...(typeof parsed.note === "string" ? { note: parsed.note } : {})
      };
      context.runState.todos.push(item);
      return result(context.runState.todos, true);
    }

    const id = typeof parsed.id === "string" || typeof parsed.id === "number" ? String(parsed.id) : "";
    if (!id) return { ok: false, content: "todo update requires id" };
    const item = context.runState.todos.find((candidate) => candidate.id === id);
    if (!item) return { ok: false, content: `Unknown todo id: ${id}` };
    if (parsed.status !== undefined) {
      if (!isStatus(parsed.status)) return { ok: false, content: "todo status must be pending, in_progress, done, or blocked" };
      item.status = parsed.status;
    }
    if (typeof parsed.text === "string" && parsed.text.trim().length > 0) item.text = parsed.text;
    if (typeof parsed.note === "string") item.note = parsed.note;
    return result(context.runState.todos, true);
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }
}

