import type {
  AgentEventOf,
  AgentEventPayloadMap,
  AgentEventType,
  ContextAuthority
} from "agent-protocol";
import type { RuntimeSession } from "./types.js";

/**
 * The single producer-side event contract. The event discriminant selects its
 * payload at compile time; broad envelopes remain reserved for replay/read APIs.
 */
export type RuntimeEventEmitter = <TType extends AgentEventType>(
  session: RuntimeSession,
  type: TType,
  authority: Exclude<ContextAuthority, "external_verifier">,
  payload: AgentEventPayloadMap[NoInfer<TType>]
) => Promise<AgentEventOf<TType>>;

export type BoundRuntimeEventEmitter = <TType extends AgentEventType>(
  type: TType,
  authority: Exclude<ContextAuthority, "external_verifier">,
  payload: AgentEventPayloadMap[NoInfer<TType>]
) => Promise<AgentEventOf<TType>>;
