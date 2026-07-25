import { createHash } from "node:crypto";
import type { JsonValue, ToolExecutor } from "agent-protocol";
import type { RuntimeControlService } from "./runtime-control.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import type { RuntimeSession } from "./types.js";

export interface ActiveReviewerToolEnvironmentOptions {
  session: RuntimeSession;
  tools: ToolExecutor;
  control: RuntimeControlService;
  emit: RuntimeEventEmitter;
  createArtifact(sessionId: string, content: string | Uint8Array): Promise<string>;
  networkMode: "none" | "loopback" | "full";
  allowEnclosingContainerRead: boolean;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function jsonObject(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

export function utf8PageRange(
  content: Buffer,
  requestedOffset: number,
  maximum: number
): { start: number; end: number } {
  let start = Math.min(content.byteLength, requestedOffset);
  while (start > 0 && (content[start] ?? 0) >> 6 === 2) start -= 1;
  let end = Math.min(content.byteLength, start + maximum);
  while (end > start && end < content.byteLength
    && (content[end] ?? 0) >> 6 === 2) end -= 1;
  if (end !== start || end >= content.byteLength) return { start, end };
  end += 1;
  while (end < content.byteLength && (content[end] ?? 0) >> 6 === 2) end += 1;
  return { start, end };
}
