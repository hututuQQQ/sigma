import type { AgentMessage, ToolCall } from "agent-ai";
import type { LoopGuardMode } from "./types.js";

const DEFAULT_REPEATED_CALL_THRESHOLD = 3;
const MAX_SIGNATURE_ARGUMENT_CHARS = 1200;

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
  streak?: number;
  message?: string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function callSignature(call: ToolCall): string {
  const args = stableJson(call.function.arguments);
  return `${call.function.name}:${args.length > MAX_SIGNATURE_ARGUMENT_CHARS ? `${args.slice(0, MAX_SIGNATURE_ARGUMENT_CHARS)}...` : args}`;
}

function callsSignature(calls: ToolCall[]): string {
  return calls.map(callSignature).join("\n");
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
    if (signature === this.lastSignature) {
      this.streak += 1;
    } else {
      this.lastSignature = signature;
      this.streak = 1;
    }
    if (this.streak < this.threshold) return { action: "none", signature, streak: this.streak };

    const alreadyNudged = this.nudgedForSignature.has(signature);
    if (alreadyNudged && this.mode === "stop") {
      return {
        action: "stop",
        signature,
        streak: this.streak,
        message: "Sigma stopped because the model repeated the same tool call sequence after a recovery nudge."
      };
    }

    this.nudgedForSignature.add(signature);
    return {
      action: "nudge",
      signature,
      streak: this.streak,
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
