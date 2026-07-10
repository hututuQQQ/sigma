import type { JsonValue, ToolDescriptor, ToolReceipt, ToolRequest } from "agent-protocol";
import type { EffectToolRegistry, RegisteredEffectTool } from "./registry.js";

export interface CompletionCriterion {
  criterion: string;
  status: "met";
  evidenceCallIds: string[];
  rationale: string;
}

export interface CompletionProposal {
  summary: string;
  criteria: CompletionCriterion[];
}

function record(value: JsonValue): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function parseCompletionProposal(value: JsonValue): CompletionProposal | null {
  const input = record(value);
  if (!input || typeof input.summary !== "string" || !input.summary.trim() || !Array.isArray(input.criteria) || input.criteria.length === 0) return null;
  const criteria: CompletionCriterion[] = [];
  for (const raw of input.criteria) {
    const item = record(raw);
    if (!item || typeof item.criterion !== "string" || !item.criterion.trim()) return null;
    if (item.status !== "met") return null;
    if (!Array.isArray(item.evidenceCallIds) || item.evidenceCallIds.some((id) => typeof id !== "string")) return null;
    criteria.push({
      criterion: item.criterion,
      status: item.status,
      evidenceCallIds: [...item.evidenceCallIds] as string[],
      rationale: typeof item.rationale === "string" ? item.rationale : ""
    });
  }
  return { summary: input.summary, criteria };
}

export function completionEvidenceError(proposal: CompletionProposal, successfulCallIds: ReadonlySet<string>): string | null {
  for (const criterion of proposal.criteria) {
    if (criterion.status === "met" && criterion.evidenceCallIds.length === 0) {
      return `Criterion '${criterion.criterion}' needs at least one successful tool receipt.`;
    }
    const missing = criterion.evidenceCallIds.filter((id) => !successfulCallIds.has(id));
    if (missing.length > 0) return `Criterion '${criterion.criterion}' cites unknown or failed receipts: ${missing.join(", ")}.`;
  }
  return null;
}

function completionTool(): RegisteredEffectTool {
  const descriptor: ToolDescriptor = {
    name: "complete_task",
    description: "Propose terminal completion with explicit acceptance criteria and successful current-run tool-receipt evidence. Every criterion must be met. Copy exact opaque IDs from the current-run receipt ledger or 'Successful tool receipt ID:' results into evidenceCallIds; never invent labels, indexes, tool names, or older-run IDs. Completion is rejected until this protocol is satisfied.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Concise description of the completed result." },
        criteria: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              criterion: { type: "string", description: "One concrete acceptance criterion." },
              status: { type: "string", enum: ["met"], description: "Terminal completion accepts only criteria proven met by current-run receipts." },
              evidenceCallIds: {
                type: "array",
                description: "Exact opaque IDs copied from successful tool receipt results. Do not use tool names, labels, or numeric indexes.",
                items: { type: "string" }
              },
              rationale: { type: "string", description: "Optional concise explanation; omitted values default to an empty string." }
            },
            required: ["criterion", "status", "evidenceCallIds"],
            additionalProperties: false
          }
        }
      },
      required: ["summary", "criteria"],
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
    async execute(request: ToolRequest): Promise<ToolReceipt> {
      const startedAt = new Date().toISOString();
      const proposal = parseCompletionProposal(request.arguments);
      return {
        callId: request.callId,
        ok: proposal !== null,
        output: proposal ? JSON.stringify(proposal) : "Completion proposal does not match the required schema.",
        observedEffects: proposal ? ["outcome.propose"] : [],
        artifacts: [],
        diagnostics: proposal ? [] : ["invalid_completion_proposal"],
        startedAt,
        completedAt: new Date().toISOString()
      };
    }
  };
}

function requestUserInputTool(): RegisteredEffectTool {
  const descriptor: ToolDescriptor = {
    name: "request_user_input",
    description: "End the active run in a typed waiting state when no actionable task was provided or a specific user decision is required. Ask one concise question; do not call this merely to narrate progress.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The concise question or information needed from the user." }
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
    async execute(request: ToolRequest): Promise<ToolReceipt> {
      const startedAt = new Date().toISOString();
      const input = record(request.arguments);
      const message = typeof input?.message === "string" ? input.message.trim() : "";
      return {
        callId: request.callId,
        ok: message.length > 0,
        output: message ? JSON.stringify({ message }) : "User-input request requires a non-empty message.",
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
  registry.register(completionTool());
  registry.register(requestUserInputTool());
  return registry;
}
