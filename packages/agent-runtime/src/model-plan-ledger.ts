import { createHash } from "node:crypto";
import type { ContextItem } from "agent-protocol";
import { approximateTokens, fitApproximateTokens } from "agent-context";
import type { RuntimeSession } from "./types.js";

export const MAX_PLAN_STATUS_TOKENS = 1_024;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function planLedger(session: RuntimeSession): ContextItem {
  const plan = session.durable.state.plan;
  const stateDigest = digest(plan);
  const counts = new Map<string, number>();
  for (const node of plan.nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  const displayedNodes = plan.nodes.slice(0, 32);
  const nodes = displayedNodes.flatMap((node) => [
    `- ${node.id}: ${node.title} [${node.status}]${node.id === plan.activeNodeId ? " (active)" : ""}`,
    ...(node.acceptanceCriteria.length > 0
      ? [`  acceptance: ${node.acceptanceCriteria.slice(0, 4).join("; ")}`]
      : []),
    ...(node.blockedReason ? [`  blocked: ${node.blockedReason}`] : [])
  ]);
  const content = fitApproximateTokens([
    "Current durable work plan:",
    `- revision: ${plan.revision}`,
    `- goal: ${plan.goal || "(not yet defined)"}`,
    `- active node: ${plan.activeNodeId ?? "none"}`,
    `- status counts: ${[...counts].sort(([left], [right]) => left.localeCompare(right))
      .map(([status, count]) => `${status}:${count}`).join(", ") || "none"}`,
    ...nodes,
    ...(displayedNodes.length < plan.nodes.length
      ? [`- ${plan.nodes.length - displayedNodes.length} additional nodes omitted; use read_plan for the full graph`]
      : []),
    `Plan state digest: ${stateDigest}`
  ].join("\n"), MAX_PLAN_STATUS_TOKENS);
  return {
    id: `runtime:plan-status:${stateDigest}`,
    authority: "runtime",
    provenance: "plan_status",
    content,
    tokenCount: approximateTokens(content),
    priority: 9_800,
    cacheKey: stateDigest
  };
}
