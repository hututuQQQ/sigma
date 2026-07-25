import type { ModelToolCall, ToolReceipt } from "agent-protocol";
import { failed } from "./effect-helpers.js";
import { longHorizonDigest } from "./long-horizon-state.js";
import type { RuntimeSession } from "./types.js";

/**
 * Do not execute a fourth identical single-call batch when none of the prior
 * three changed a durable progress fact. This is a recoverable observation,
 * not a terminal outcome; different actions and new user instructions remain
 * unrestricted.
 */
export function repeatedExactCallFailure(
  session: RuntimeSession,
  call: ModelToolCall,
  startedAt: string
): ToolReceipt | undefined {
  const recent = session.durable.state.longHorizon.recentOutcomes.slice(-3);
  if (recent.length < 3) return undefined;
  const digest = longHorizonDigest([{ name: call.name, arguments: call.arguments }]);
  const resultDigest = recent[0]!.resultDigest;
  const exactRepeat = recent.every((outcome) =>
    outcome.toolNames.length === 1
    && outcome.callDigest === digest
    && outcome.resultDigest === resultDigest);
  if (!exactRepeat) return undefined;
  return failed(
    call,
    startedAt,
    "This exact tool call already returned the same semantic result three times without changing the workspace frontier, plan, validation/review ledger, user decision, or blocker. The fourth execution was not repeated. Use the durable results to change the hypothesis or choose a discriminating action; a new user instruction resets this guard.",
    "repeated_tool_call"
  );
}
