import type {
  JsonValue,
  ToolDescriptor,
  ToolReceipt,
  ToolRequest
} from "agent-protocol";
import type { EffectToolRegistry, RegisteredEffectTool } from "./registry.js";

export interface BlockedReport {
  code: string;
  summary: string;
  recoveryAttempted?: string;
}

export type TerminalProtocolAction = "report_blocked" | "request_input";

/** Classify only explicit, pure terminal descriptors. Natural stop completes. */
export function terminalProtocolAction(
  descriptor: Pick<ToolDescriptor, "possibleEffects" | "maximumEffects">
): TerminalProtocolAction | null {
  const possible = descriptor.possibleEffects;
  const maximum = descriptor.maximumEffects ?? possible;
  if (possible.length !== 1 || maximum.length !== 1 || possible[0] !== maximum[0]) return null;
  if (possible[0] === "outcome.report_blocked") return "report_blocked";
  return possible[0] === "outcome.request_input" ? "request_input" : null;
}

function record(value: JsonValue): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function parseBlockedReport(value: JsonValue): BlockedReport | null {
  const input = record(value);
  if (input && Object.keys(input).some((key) =>
    key !== "code" && key !== "summary" && key !== "recoveryAttempted")) return null;
  const code = typeof input?.code === "string" ? input.code.trim() : "";
  const summary = typeof input?.summary === "string" ? input.summary.trim() : "";
  const recoveryAttempted = typeof input?.recoveryAttempted === "string"
    ? input.recoveryAttempted.trim()
    : undefined;
  if (!code || !summary || (input?.recoveryAttempted !== undefined && !recoveryAttempted)) return null;
  return { code, summary, ...(recoveryAttempted ? { recoveryAttempted } : {}) };
}

function blockedReceipt(
  request: ToolRequest,
  startedAt: string,
  value: BlockedReport | null
): ToolReceipt {
  return {
    callId: request.callId,
    ok: value !== null,
    output: value ? JSON.stringify(value) : "Blocked report does not match the required schema.",
    observedEffects: value ? ["outcome.report_blocked"] : [],
    artifacts: [],
    diagnostics: value ? [] : ["invalid_blocked_report"],
    startedAt,
    completedAt: new Date().toISOString()
  };
}

function reportBlockedTool(): RegisteredEffectTool {
  const descriptor: ToolDescriptor = {
    name: "report_blocked",
    description: "End with an honest recoverable failure when the task cannot proceed. Do not use this when a concrete user decision is required.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Stable, task-independent blocker code." },
        summary: { type: "string", description: "What remains blocked and why." },
        recoveryAttempted: { type: "string", description: "Optional concise repair attempts already made." }
      },
      required: ["code", "summary"],
      additionalProperties: false
    },
    possibleEffects: ["outcome.report_blocked"],
    executionMode: "sequential",
    resourceKeys: ["run:outcome"],
    approval: "auto",
    idempotent: true,
    timeoutMs: 5_000
  };
  return {
    descriptor,
    async execute(request): Promise<ToolReceipt> {
      const startedAt = new Date().toISOString();
      return blockedReceipt(request, startedAt, parseBlockedReport(request.arguments));
    }
  };
}

function requestUserInputTool(): RegisteredEffectTool {
  const descriptor: ToolDescriptor = {
    name: "request_user_input",
    description: "End in a typed waiting state only when a concrete user decision or missing fact is required.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The concise question or information needed." }
      },
      required: ["message"],
      additionalProperties: false
    },
    possibleEffects: ["outcome.request_input"],
    executionMode: "sequential",
    resourceKeys: ["run:outcome"],
    approval: "auto",
    idempotent: false,
    timeoutMs: 5_000
  };
  return {
    descriptor,
    async execute(request): Promise<ToolReceipt> {
      const startedAt = new Date().toISOString();
      const input = record(request.arguments);
      const message = typeof input?.message === "string" ? input.message.trim() : "";
      return {
        callId: request.callId,
        ok: message.length > 0,
        output: message
          ? JSON.stringify({ message })
          : "User-input request requires a non-empty message.",
        observedEffects: message ? ["outcome.request_input"] : [],
        artifacts: [],
        diagnostics: message ? [] : ["invalid_user_input_request"],
        startedAt,
        completedAt: new Date().toISOString()
      };
    }
  };
}

export function registerCompletionTool(registry: EffectToolRegistry): EffectToolRegistry {
  registry.register(reportBlockedTool());
  registry.register(requestUserInputTool());
  return registry;
}
