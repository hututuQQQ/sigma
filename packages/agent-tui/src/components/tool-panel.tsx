import type { AgentEvent, AgentRunResult } from "agent-core";

export function ToolPanel(events: AgentEvent[], result: AgentRunResult | null): string {
  const toolEvents = events.filter((event) => event.type === "tool_end").slice(-8);
  const tools = result?.toolsAvailable?.join(", ") || "available after first run";
  const lines = ["Tools", `  available: ${tools}`];
  for (const event of toolEvents) {
    const meta = event.metadata ?? {};
    const res = meta.result as { ok?: boolean } | undefined;
    lines.push(`  ${meta.toolName ?? "unknown"} ok=${String(res?.ok ?? false)}`);
  }
  return lines.join("\n");
}
