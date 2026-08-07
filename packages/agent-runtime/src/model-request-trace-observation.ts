import {
  messageTokens,
  type ContextPlan
} from "agent-context";
import type { PreparedModelTurn } from "./model-budget-convergence.js";

export function modelRequestTraceObservation(plan: ContextPlan, turn: PreparedModelTurn) {
  const toolResults = plan.messages
    .filter((message) => message.role === "tool")
    .reduce((total, message) => total + messageTokens(message), 0);
  const estimatedTokens = {
    systemBaseContext: plan.budget.systemTokens + plan.budget.dynamicTokens,
    toolSchema: plan.budget.toolTokens,
    conversationHistory: Math.max(0, plan.budget.historyTokens - toolResults),
    toolResults
  };
  return {
    schemaVersion: 1 as const,
    tokenEstimator: "context_plan_approximate_tokens" as const,
    tokenAccuracy: "estimated" as const,
    estimatedTokens: {
      ...estimatedTokens,
      total: Object.values(estimatedTokens).reduce((total, value) => total + value, 0)
    },
    visibleToolNames: [...new Set(turn.tools.map((tool) => tool.name))].sort()
  };
}
