import { createHash } from "node:crypto";
import type { ContextItem } from "agent-protocol";
import { approximateTokens, fitApproximateTokens } from "agent-context";
import type { RuntimeSession } from "./types.js";
import { longHorizonProgressBasisDigest } from "./long-horizon-state.js";

export const MAX_LONG_HORIZON_STATUS_TOKENS = 1_536;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function longHorizonLedger(session: RuntimeSession): ContextItem {
  const state = session.durable.state.longHorizon;
  const strategy = state.strategy;
  const strategyCurrent = strategy?.basisDigest
    === longHorizonProgressBasisDigest(session);
  const stateDigest = digest({
    duplicateStreak: state.duplicateStreak,
    strategyRequested: state.strategyRequested,
    resourceBandTriggered: state.resourceBandTriggered,
    strategy,
    strategyCurrent,
    assurance: state.assurance
  });
  const lines = [
    "Durable long-horizon state (objective action/resource signals; never wall-clock based):",
    `- settled batches without durable marginal progress: ${state.duplicateStreak}/${Math.max(2, state.assurance.duplicateThreshold - 1)}`,
    `- main model requested strategy help: ${state.strategyRequested ? "yes" : "no"}`,
    `- configured resource band crossed: ${state.resourceBandTriggered ? "yes" : "no"}`,
    ...(strategy && strategyCurrent
      ? [
          "Fresh-context strategy reset:",
          `- trigger: ${strategy.trigger}`,
          `- established facts: ${strategy.establishedFacts.join(" | ") || "none recorded"}`,
          `- falsified routes: ${strategy.falsifiedApproaches.join(" | ") || "none recorded"}`,
          `- current hypothesis: ${strategy.hypothesis}`,
          ...(strategy.decision
            ? [`- semantic recommendation: ${strategy.decision}`]
            : []),
          ...(strategy.decisionRationale
            ? [`- recommendation rationale: ${strategy.decisionRationale}`]
            : []),
          `- next discriminating action: ${strategy.nextDiscriminatingAction}`,
          `- expected signal: ${strategy.expectedSignal}`,
          ...(strategy.validationTarget
            ? [`- validation target: ${strategy.validationTarget}`]
            : [])
        ]
      : strategy
        ? [
            "The prior fresh-context strategy reset is historical: newer objective receipts changed its basis.",
            "Use the current plan, frontier, validation state, and newest tool results rather than carrying forward its old facts."
          ]
        : []),
    `- assurance calls used: strategist=${state.assurance.strategistCalls}/${state.assurance.strategistMode === "off" ? 0 : 1}, reviewer=${state.assurance.reviewerCalls}/${state.assurance.reviewRounds}`,
    `Long-horizon state digest: ${stateDigest}`
  ];
  const content = fitApproximateTokens(lines.join("\n"), MAX_LONG_HORIZON_STATUS_TOKENS);
  return {
    id: `runtime:long-horizon:${stateDigest}`,
    authority: "runtime",
    provenance: "long_horizon_status",
    content,
    tokenCount: approximateTokens(content),
    priority: 9_850,
    cacheKey: stateDigest
  };
}
