import type { AgentRunResult } from "agent-core";

export function DiffPanel(result: AgentRunResult | null, diffText: string): string {
  const changed = result?.changedFiles ?? [];
  const lines = ["Diff"];
  if (changed.length > 0) {
    lines.push(`  changed: ${changed.join(", ")}`);
  }
  lines.push(...(diffText.trim() ? diffText.trim().split(/\r?\n/).map((line) => `  ${line}`) : ["  No diff available."]));
  return lines.join("\n");
}
