import { redactSecretText, type AgentRunResult } from "agent-core";

export type DiffMode = "stat" | "patch";

export function parseDiffMode(value: string): DiffMode | null {
  if (!value || value === "stat") return "stat";
  if (value === "patch") return "patch";
  return null;
}

export function DiffPanel(result: AgentRunResult | null, diffText: string, mode: DiffMode = "stat"): string {
  const changed = result?.changedFiles ?? [];
  const lines = [`Diff (${mode})`];
  if (changed.length > 0) {
    lines.push(`  changed: ${changed.join(", ")}`);
  }
  lines.push(...(diffText.trim() ? redactSecretText(diffText).trim().split(/\r?\n/).map((line) => `  ${line}`) : ["  No diff available."]));
  return lines.join("\n");
}
