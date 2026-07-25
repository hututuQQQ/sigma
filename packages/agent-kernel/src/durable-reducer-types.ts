import type {
  AgentEventEnvelope,
  JsonValue
} from "agent-protocol";
import type { KernelState } from "./state.js";

export type KernelEventReducer = (
  state: KernelState,
  event: AgentEventEnvelope,
  payload: Record<string, JsonValue>
) => KernelState;
