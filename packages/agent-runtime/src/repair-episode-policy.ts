import type { ContextItem } from "agent-protocol";
import { approximateTokens } from "agent-context";
import {
  rawAvailableBudget,
  reviewRepairActive
} from "./assurance-budget.js";
import type { RuntimeSession } from "./types.js";

export interface RepairEpisodeWindow {
  active: boolean;
  closureRequired: boolean;
  toolCapableTurnsRemaining: number;
  toolCallsRemaining: number;
  protectedToolCallsRemaining: number;
}

export function repairEpisodeWindow(
  session: RuntimeSession
): RepairEpisodeWindow {
  const assurance = session.durable.state.longHorizon.assurance;
  const active = reviewRepairActive(session);
  const toolCapableTurnsRemaining = active
    ? assurance.protectedRepairTurnsRemaining
    : 0;
  const protectedToolCallsRemaining = active
    ? assurance.protectedToolCallsRemaining
    : 0;
  const toolCallsRemaining = active
    ? rawAvailableBudget(session).toolCalls
    : 0;
  return {
    active,
    // Protected turns and tool calls are reserve floors. The repair may keep
    // using ordinary hard-ledger capacity after either reserve reaches zero;
    // only the actual hard boundary removes tools and requests closure.
    closureRequired: active && toolCallsRemaining <= 0,
    toolCapableTurnsRemaining,
    toolCallsRemaining,
    protectedToolCallsRemaining
  };
}

export function repairEpisodeNotice(
  session: RuntimeSession
): ContextItem | undefined {
  const window = repairEpisodeWindow(session);
  if (!window.active) return undefined;
  const content = window.closureRequired
    ? [
        "Independent-review repair hard boundary:",
        "No hard-ledger tool calls remain.",
        "Summarize the latest receipts concisely for independent re-review."
      ].join("\n")
    : window.toolCapableTurnsRemaining > 0
      ? [
          "Independent-review repair resource window:",
          `- protected turns: ${window.toolCapableTurnsRemaining}; protected tool-call reserve: ${window.protectedToolCallsRemaining}`,
          `- hard-ledger tool calls available: ${window.toolCallsRemaining}`,
          "Address actionable findings and run the highest-value check.",
          "Protected counts are reserve floors, not completion limits."
        ].join("\n")
      : [
          "Independent-review repair resource window:",
          `- protected turns: 0; protected tool-call reserve: ${window.protectedToolCallsRemaining}`,
          `- hard-ledger tool calls available: ${window.toolCallsRemaining}`,
          "Continue the concrete repair and highest-value check.",
          "Only hard-budget exhaustion removes tools."
        ].join("\n");
  return {
    id: `runtime:review-repair:${window.closureRequired ? "closure" : "active"}:${
      window.toolCapableTurnsRemaining
    }:${window.protectedToolCallsRemaining}:${window.toolCallsRemaining}`,
    authority: "runtime",
    provenance: "verification_repair_resource",
    content,
    tokenCount: approximateTokens(content),
    priority: 10_150
  };
}
