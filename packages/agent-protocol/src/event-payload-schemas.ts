import type { z } from "zod";
import { coreEventPayloadSchemas } from "./event-payload-schemas-core.js";
import { durableEventPayloadSchemas } from "./event-payload-schemas-durable.js";

export const agentEventPayloadSchemas = {
  ...coreEventPayloadSchemas,
  ...durableEventPayloadSchemas
} as const;

export type AgentEventType = keyof typeof agentEventPayloadSchemas;
export type AgentEventPayloadMap = {
  [TType in AgentEventType]: z.infer<(typeof agentEventPayloadSchemas)[TType]>
};

export const AGENT_EVENT_TYPES = Object.freeze(
  Object.keys(agentEventPayloadSchemas) as AgentEventType[]
);

export function parseAgentEventPayload<TType extends AgentEventType>(
  type: TType,
  payload: unknown
): AgentEventPayloadMap[TType] {
  return agentEventPayloadSchemas[type].parse(payload) as AgentEventPayloadMap[TType];
}

export function isAgentEventPayload<TType extends AgentEventType>(
  type: TType,
  payload: unknown
): payload is AgentEventPayloadMap[TType] {
  return agentEventPayloadSchemas[type].safeParse(payload).success;
}
