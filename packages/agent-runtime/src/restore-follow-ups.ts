import type { AgentEventEnvelope, JsonValue } from "agent-protocol";
import type { QueuedFollowUp } from "./types.js";

export type RecoveredFollowUps = Map<string, QueuedFollowUp>;

export function trackRecoveredFollowUp(
  followUps: RecoveredFollowUps,
  event: AgentEventEnvelope
): void {
  if (event.type !== "user.follow_up" || !event.payload
    || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
  const payload = event.payload as Record<string, JsonValue>;
  if (typeof payload.queueId !== "string" || typeof payload.text !== "string") return;
  if (payload.status === "queued") followUps.set(payload.queueId, {
    id: payload.queueId,
    text: payload.text,
    ...(payload.validationRequirement === "default" || payload.validationRequirement === "required"
      ? { validationRequirement: payload.validationRequirement } : {})
  });
  if (payload.status === "delivered") followUps.delete(payload.queueId);
}
