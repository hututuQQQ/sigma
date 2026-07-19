import type {
  EvidenceKind,
  EvidenceRecord,
  JsonValue,
  ToolDescriptor,
  ToolReceipt,
  ToolRequest
} from "agent-protocol";
import type { EffectToolRegistry, RegisteredEffectTool } from "./registry.js";

export interface CompletionProposal {
  summary: string;
  warnings?: string[];
}

export interface BlockedReport {
  code?: string;
  summary: string;
  recoveryAttempted?: string;
}

export type TerminalProtocolAction = "complete" | "report_blocked" | "request_input";

/** Classify only pure terminal descriptors. */
export function terminalProtocolAction(
  descriptor: Pick<ToolDescriptor, "possibleEffects" | "maximumEffects">
): TerminalProtocolAction | null {
  const possible = descriptor.possibleEffects;
  const maximum = descriptor.maximumEffects ?? possible;
  if (possible.length !== 1 || maximum.length !== 1 || possible[0] !== maximum[0]) return null;
  if (possible[0] === "outcome.propose") return "complete";
  if (possible[0] === "outcome.report_blocked") return "report_blocked";
  return possible[0] === "outcome.request_input" ? "request_input" : null;
}

function record(value: JsonValue): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringList(value: JsonValue | undefined): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) return null;
  return [...new Set(value as string[])];
}

function optionalString(
  input: Record<string, JsonValue>,
  key: string
): { valid: boolean; value?: string } {
  const raw = input[key];
  if (raw === undefined) return { valid: true };
  if (typeof raw !== "string" || !raw.trim()) return { valid: false };
  return { valid: true, value: raw.trim() };
}

export function parseCompletionProposal(value: JsonValue): CompletionProposal | null {
  const input = record(value);
  if (input && Object.keys(input).some((key) => key !== "summary" && key !== "warnings")) return null;
  const summary = typeof input?.summary === "string" ? input.summary.trim() : "";
  const warnings = input ? stringList(input.warnings) : null;
  if (!summary || warnings === null) return null;
  return { summary, ...(warnings.length > 0 ? { warnings } : {}) };
}

export function parseBlockedReport(value: JsonValue): BlockedReport | null {
  const input = record(value);
  if (!input) return null;
  if (input && Object.keys(input).some((key) =>
    key !== "code" && key !== "summary" && key !== "recoveryAttempted")) return null;
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  const code = optionalString(input, "code");
  const recovery = optionalString(input, "recoveryAttempted");
  if (!summary || !code.valid || !recovery.valid) return null;
  return {
    ...(code.value ? { code: code.value } : {}),
    summary,
    ...(recovery.value ? { recoveryAttempted: recovery.value } : {})
  };
}

/** @deprecated V5 completion evidence is selected by the runtime. */
export function completionEvidenceError(
  _proposal: CompletionProposal,
  _availableEvidence: ReadonlyMap<string, EvidenceKind | EvidenceRecord>
): null {
  return null;
}

function terminalReceipt(
  request: ToolRequest,
  startedAt: string,
  value: CompletionProposal | BlockedReport | null,
  effect: "outcome.propose" | "outcome.report_blocked",
  diagnostic: string
): ToolReceipt {
  return {
    callId: request.callId,
    ok: value !== null,
    output: value ? JSON.stringify(value) : "Terminal report does not match the required schema.",
    observedEffects: value ? [effect] : [],
    artifacts: [],
    diagnostics: value ? [] : [diagnostic],
    startedAt,
    completedAt: new Date().toISOString()
  };
}

function completionTool(): RegisteredEffectTool {
  const descriptor: ToolDescriptor = {
    name: "runtime_finalize",
    description: "Internal completion-coordinator action derived from a natural model stop.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Concise description of the completed result." },
        warnings: {
          type: "array",
          items: { type: "string" },
          description: "Optional remaining non-blocking limitations."
        }
      },
      required: ["summary"],
      additionalProperties: false
    },
    possibleEffects: ["outcome.propose"],
    executionMode: "sequential",
    resourceKeys: ["run:outcome"],
    approval: "auto",
    idempotent: true,
    timeoutMs: 5_000
  };
  return {
    descriptor,
    modelVisible: false,
    async execute(request): Promise<ToolReceipt> {
      const startedAt = new Date().toISOString();
      return terminalReceipt(
        request, startedAt, parseCompletionProposal(request.arguments),
        "outcome.propose", "invalid_completion_proposal"
      );
    }
  };
}

function confirmNoChangeTool(): RegisteredEffectTool {
  const descriptor: ToolDescriptor = {
    name: "confirm_no_change",
    description: "Confirm that the protected original answer correctly explains why no workspace change is required.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    possibleEffects: ["outcome.propose"],
    executionMode: "sequential",
    resourceKeys: ["run:outcome"],
    approval: "auto",
    idempotent: true,
    timeoutMs: 5_000
  };
  return {
    descriptor,
    modelVisible: false,
    async execute(request): Promise<ToolReceipt> {
      const startedAt = new Date().toISOString();
      return terminalReceipt(
        request,
        startedAt,
        { summary: "No workspace change is required." },
        "outcome.propose",
        "invalid_no_change_confirmation"
      );
    }
  };
}

function reportBlockedTool(): RegisteredEffectTool {
  const descriptor: ToolDescriptor = {
    name: "report_blocked",
    description: "End with an honest recoverable failure after concrete repair attempts could not satisfy a validation or capability blocker. Do not use this when a user decision is required.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Optional backward-compatible blocker hint. The runtime assigns the durable failure taxonomy."
        },
        summary: { type: "string", description: "What remains blocked and why." },
        recoveryAttempted: { type: "string", description: "Optional concise repair attempts already made." }
      },
      required: ["summary"],
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
      return terminalReceipt(
        request, startedAt, parseBlockedReport(request.arguments),
        "outcome.report_blocked", "invalid_blocked_report"
      );
    }
  };
}

function requestUserInputTool(): RegisteredEffectTool {
  const descriptor: ToolDescriptor = {
    name: "request_user_input",
    description: "End in a typed waiting state only when a concrete user decision is required for a supported follow-up operation.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "The concise question or information needed." } },
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
        output: message ? JSON.stringify({ message }) : "User-input request requires a non-empty message.",
        observedEffects: message ? ["outcome.request_input"] : [],
        artifacts: [], diagnostics: message ? [] : ["invalid_user_input_request"],
        startedAt, completedAt: new Date().toISOString()
      };
    }
  };
}

export function registerCompletionTool(registry: EffectToolRegistry): EffectToolRegistry {
  registry.register(completionTool());
  registry.register(confirmNoChangeTool());
  registry.register(reportBlockedTool());
  registry.register(requestUserInputTool());
  return registry;
}
