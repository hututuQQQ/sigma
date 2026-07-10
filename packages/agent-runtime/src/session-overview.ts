import type { JsonValue, RunStore, SessionOverview } from "agent-protocol";

export async function storedSessionOverview(
  store: RunStore,
  item: { sessionId: string; updatedAt: string; lastSeq: number }
): Promise<SessionOverview> {
  let workspacePath = "";
  let mode: SessionOverview["mode"] = "change";
  let status: SessionOverview["status"] = "idle";
  let lastMessage: string | undefined;
  for await (const event of store.events(item.sessionId)) {
    const data = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? event.payload as Record<string, JsonValue> : {};
    if (event.type === "session.created") {
      if (typeof data.workspacePath === "string") workspacePath = data.workspacePath;
      if (data.mode === "analyze") mode = "analyze";
    } else if (event.type === "run.started") status = "running";
    else if (event.type === "run.suspended") status = "needs_input";
    else if (event.type === "run.completed") status = "completed";
    else if (event.type === "run.cancelled") status = "cancelled";
    else if (event.type === "run.failed") status = "failed";
    if (event.type === "model.completed" && typeof data.text === "string") lastMessage = data.text;
  }
  return { ...item, workspacePath, mode, status, lastMessage };
}
