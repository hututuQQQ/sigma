import type { JsonValue, ToolDescriptor, ToolReceipt, ToolRequest } from "agent-protocol";
import type { EffectToolRegistry, RegisteredEffectTool } from "./registry.js";

export interface CompletionCriterion {
  criterion: string;
  status: "met" | "not_applicable";
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
    if (item.status !== "met" && item.status !== "not_applicable") return null;
    if (!Array.isArray(item.evidenceCallIds) || item.evidenceCallIds.some((id) => typeof id !== "string")) return null;
    if (typeof item.rationale !== "string") return null;
    criteria.push({
      criterion: item.criterion,
      status: item.status,
      evidenceCallIds: [...item.evidenceCallIds] as string[],
      rationale: item.rationale
    });
  }
  return { summary: input.summary, criteria };
}

export function completionEvidenceError(proposal: CompletionProposal, successfulCallIds: ReadonlySet<string>): string | null {
  for (const criterion of proposal.criteria) {
    if (criterion.status === "met" && criterion.evidenceCallIds.length === 0) {
      return `Criterion '${criterion.criterion}' needs at least one successful tool receipt.`;
    }
    if (criterion.status === "not_applicable" && !criterion.rationale.trim()) {
      return `Criterion '${criterion.criterion}' needs a rationale when marked not_applicable.`;
    }
    const missing = criterion.evidenceCallIds.filter((id) => !successfulCallIds.has(id));
    if (missing.length > 0) return `Criterion '${criterion.criterion}' cites unknown or failed receipts: ${missing.join(", ")}.`;
  }
  return null;
}

function completionTool(): RegisteredEffectTool {
  const descriptor: ToolDescriptor = {
    name: "complete_task",
    description: "Propose terminal completion with explicit acceptance criteria and successful tool-receipt evidence. Completion is rejected until this protocol is satisfied.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        criteria: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              criterion: { type: "string" },
              status: { type: "string", enum: ["met", "not_applicable"] },
              evidenceCallIds: { type: "array", items: { type: "string" } },
              rationale: { type: "string" }
            },
            required: ["criterion", "status", "evidenceCallIds", "rationale"],
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

export function registerCompletionTool(registry: EffectToolRegistry): EffectToolRegistry {
  registry.register(completionTool());
  return registry;
}
