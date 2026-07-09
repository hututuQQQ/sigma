import { createHash } from "node:crypto";
import type { AgentMessage, ToolCall } from "agent-ai";
import type { LoopGuardMode } from "./types.js";

const DEFAULT_REPEATED_CALL_THRESHOLD = 3;
const MAX_SIGNATURE_PREVIEW_CHARS = 1200;

export type QueuedAgentMessage =
  | { role: "user" | "system"; content: string }
  | { role: "stop"; reason?: string };

export class AgentMessageQueue {
  private readonly queue: QueuedAgentMessage[] = [];

  push(message: QueuedAgentMessage): void {
    this.queue.push(message);
  }

  drain(): QueuedAgentMessage[] {
    return this.queue.splice(0, this.queue.length);
  }
}

export interface LoopGuardDecision {
  action: "none" | "nudge" | "stop";
  signature?: string;
  signaturePreview?: string;
  streak?: number;
  message?: string;
  skipToolCalls?: boolean;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function previewText(value: string): string {
  return value.length > MAX_SIGNATURE_PREVIEW_CHARS ? `${value.slice(0, MAX_SIGNATURE_PREVIEW_CHARS)}...` : value;
}

function callSignature(call: ToolCall): { key: string; preview: string } {
  const args = stableJson(call.function.arguments);
  return {
    key: `${call.function.name}:${hashText(args)}`,
    preview: `${call.function.name}:${previewText(args)}`
  };
}

function callsSignature(calls: ToolCall[]): { key: string; preview: string } {
  const signatures = calls.map(callSignature);
  return {
    key: signatures.map((item) => item.key).join("\n"),
    preview: signatures.map((item) => item.preview).join("\n")
  };
}

export class RepeatedToolCallGuard {
  private lastSignature = "";
  private streak = 0;
  private nudgedForSignature = new Set<string>();

  constructor(
    private readonly mode: LoopGuardMode = "stop",
    private readonly threshold = DEFAULT_REPEATED_CALL_THRESHOLD
  ) {}

  observe(calls: ToolCall[]): LoopGuardDecision {
    if (this.mode === "off" || calls.length === 0) return { action: "none" };
    const signature = callsSignature(calls);
    if (signature.key === this.lastSignature) {
      this.streak += 1;
    } else {
      this.lastSignature = signature.key;
      this.streak = 1;
    }
    if (this.streak < this.threshold) {
      return { action: "none", signature: signature.key, signaturePreview: signature.preview, streak: this.streak };
    }

    const alreadyNudged = this.nudgedForSignature.has(signature.key);
    if (alreadyNudged && this.mode === "stop") {
      return {
        action: "stop",
        signature: signature.key,
        signaturePreview: signature.preview,
        streak: this.streak,
        message: "Sigma stopped because the model repeated the same tool call sequence after a recovery nudge."
      };
    }

    this.nudgedForSignature.add(signature.key);
    return {
      action: "nudge",
      signature: signature.key,
      signaturePreview: signature.preview,
      streak: this.streak,
      skipToolCalls: this.mode === "stop",
      message: [
        "Loop guard: you have repeated the same tool call sequence several times.",
        "Do not repeat that exact call again. Reassess the result, change the approach, or explain why no further tool use is useful."
      ].join("\n")
    };
  }
}

export class AgentLoopEngine {
  readonly queue = new AgentMessageQueue();
  readonly loopGuard: RepeatedToolCallGuard;

  constructor(options: { loopGuardMode?: LoopGuardMode } = {}) {
    this.loopGuard = new RepeatedToolCallGuard(options.loopGuardMode ?? "stop");
  }

  drainQueuedMessages(messages: AgentMessage[]): { stopReason?: string; appended: number } {
    let appended = 0;
    for (const item of this.queue.drain()) {
      if (item.role === "stop") return { stopReason: item.reason ?? "Stopped by queued control message.", appended };
      messages.push({ role: item.role, content: item.content });
      appended += 1;
    }
    return { appended };
  }
}
