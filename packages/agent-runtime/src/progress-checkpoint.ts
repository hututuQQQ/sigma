import type { ContextItem } from "agent-protocol";
import type { RuntimeSession } from "./types.js";

/**
 * V10 removed the semantic 4/8/6 checkpoint state machine. Strategy guidance
 * is materialized through the durable long-horizon section only after an
 * objective trigger or an explicit model request. Evidence-attention
 * saturation delegates the semantic decision to that fresh-context model
 * instead of adding another main-loop checkpoint prompt.
 */
export function progressCheckpoints(_session: RuntimeSession): ContextItem[] {
  return [];
}
