import {
  evidenceSupportsClaim,
  type EvidenceClaim,
  type EvidenceKind,
  type EvidenceRecord,
  type EvidenceRef,
  type JsonValue,
  type ToolDescriptor,
  type ToolReceipt,
  type ToolRequest
} from "agent-protocol";
import type { EffectToolRegistry, RegisteredEffectTool } from "./registry.js";

export interface CompletionCriterion {
  criterion: string;
  status: "met";
  /** Normalized convenience value, present only when every evidence reference
   * makes the same claim. On input this field is also the legacy default for
   * references that omit claim. */
  claim?: EvidenceClaim;
  evidence: Array<EvidenceRef & { claim: EvidenceClaim }>;
  rationale: string;
}

export interface CompletionProposal {
  summary: string;
  criteria: CompletionCriterion[];
}

export type TerminalProtocolAction = "complete" | "request_input";

/**
 * Classify a descriptor only when its sole possible and maximum effect is one
 * terminal protocol capability. A descriptor that combines terminal and
 * non-terminal behavior is not safe to project into a restricted turn.
 */
export function terminalProtocolAction(
  descriptor: Pick<ToolDescriptor, "possibleEffects" | "maximumEffects">
): TerminalProtocolAction | null {
  const possible = descriptor.possibleEffects;
  const maximum = descriptor.maximumEffects ?? possible;
  if (possible.length !== 1 || maximum.length !== 1 || possible[0] !== maximum[0]) return null;
  if (possible[0] === "outcome.propose") return "complete";
  return possible[0] === "outcome.request_input" ? "request_input" : null;
}

function record(value: JsonValue): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  "workspace_delta", "command", "validation", "diagnostic", "review", "checkpoint", "child_outcome", "user_waiver"
];
const EVIDENCE_CLAIMS: readonly EvidenceClaim[] = [
  "acceptance_met", "validation_executed", "validation_passed"
];

function evidenceClaim(value: JsonValue | undefined): EvidenceClaim | null {
  return typeof value === "string" && EVIDENCE_CLAIMS.includes(value as EvidenceClaim)
    ? value as EvidenceClaim : null;
}

function evidenceReferences(
  value: JsonValue | undefined,
  defaultClaim: EvidenceClaim
): Array<EvidenceRef & { claim: EvidenceClaim }> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const references: Array<EvidenceRef & { claim: EvidenceClaim }> = [];
  for (const raw of value) {
    const item = record(raw);
    if (!item || typeof item.evidenceId !== "string" || !item.evidenceId.trim()
      || typeof item.kind !== "string" || !EVIDENCE_KINDS.includes(item.kind as EvidenceKind)) return null;
    const referenceClaim = item.claim === undefined ? defaultClaim : evidenceClaim(item.claim);
    if (!referenceClaim) return null;
    references.push({
      evidenceId: item.evidenceId,
      kind: item.kind as EvidenceKind,
      claim: referenceClaim
    });
  }
  return references;
}

function completionCriterion(value: JsonValue): CompletionCriterion | null {
  const item = record(value);
  if (!item || typeof item.criterion !== "string" || !item.criterion.trim()) return null;
  if (item.status !== "met") return null;
  const inputClaim = item.claim === undefined ? undefined : evidenceClaim(item.claim);
  if (item.claim !== undefined && !inputClaim) return null;
  const evidence = evidenceReferences(item.evidence, inputClaim ?? "acceptance_met");
  if (!evidence) return null;
  const referenceClaims = [...new Set(evidence.map((reference) => reference.claim))];
  const normalizedClaim = referenceClaims.length === 1 ? referenceClaims[0] : undefined;
  return {
    criterion: item.criterion,
    status: item.status,
    ...(normalizedClaim ? { claim: normalizedClaim } : {}),
    evidence,
    rationale: typeof item.rationale === "string" ? item.rationale : ""
  };
}

export function parseCompletionProposal(value: JsonValue): CompletionProposal | null {
  const input = record(value);
  if (!input || typeof input.summary !== "string" || !input.summary.trim() || !Array.isArray(input.criteria) || input.criteria.length === 0) return null;
  const criteria = input.criteria.map(completionCriterion);
  return criteria.some((criterion) => criterion === null)
    ? null : { summary: input.summary, criteria: criteria as CompletionCriterion[] };
}

export function completionEvidenceError(
  proposal: CompletionProposal,
  availableEvidence: ReadonlyMap<string, EvidenceKind | EvidenceRecord>
): string | null {
  for (const criterion of proposal.criteria) {
    const invalid = criterion.evidence.filter((reference) => {
      const available = availableEvidence.get(reference.evidenceId);
      if (typeof available === "string") {
        return available !== reference.kind || reference.claim !== "acceptance_met";
      }
      return !available || available.kind !== reference.kind
        || !evidenceSupportsClaim(available, reference.claim);
    });
    if (invalid.length > 0) {
      return `Criterion '${criterion.criterion}' cites unavailable or mismatched durable evidence: ${invalid
        .map((item) => `${item.evidenceId}:${item.kind}:${item.claim}`).join(", ")}. `
        + "Copy each evidenceId, kind, and claim from that record's allowedClaims; different references in one criterion may use different claims.";
    }
  }
  return null;
}

function completionTool(): RegisteredEffectTool {
  const descriptor: ToolDescriptor = {
    name: "complete_task",
    description: "Propose terminal completion with explicit acceptance criteria and typed durable evidence from the current run. Every evidence reference makes its own typed claim, so one criterion may cite workspace acceptance and validation outcome evidence with different claims. Copy exact evidenceId, kind, and allowed claim values from the current-run durable evidence ledger; never invent or reuse older-run evidence. acceptance_met is the backward-compatible default for an omitted reference claim, validation_executed may cite an exited failed validation only to report that it ran, and validation_passed requires passed validation evidence. Never ask the user to waive or accept failed validation; report it honestly here. The assistant text accompanying this call becomes the user-visible handoff, so state the outcome, artifact path, exact run/use command when applicable, validation performed, and any remaining limitation instead of narrating internal protocol.",
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
              claim: {
                type: "string",
                enum: [...EVIDENCE_CLAIMS],
                description: "Legacy default for evidence references that omit claim. It does not constrain references with explicit claims."
              },
              evidence: {
                type: "array",
                minItems: 1,
                description: "Typed durable evidence references copied from the current-run evidence ledger.",
                items: {
                  type: "object",
                  properties: {
                    evidenceId: { type: "string" },
                    kind: { type: "string", enum: [...EVIDENCE_KINDS] },
                    claim: {
                      type: "string",
                      enum: [...EVIDENCE_CLAIMS],
                      description: "Typed assertion made by this reference. Use independent claims for acceptance/workspace evidence and validation evidence in the same criterion."
                    }
                  },
                  required: ["evidenceId", "kind"],
                  additionalProperties: false
                }
              },
              rationale: { type: "string", description: "Optional concise explanation; omitted values default to an empty string." }
            },
            required: ["criterion", "status", "evidence"],
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
    description: "End the active run in a typed waiting state when no actionable task was provided or a specific user decision backed by a real follow-up operation is required. Ask one concise question; do not call this merely to narrate progress. Validation has no user-waiver operation: report an exited failed validation with complete_task and validation_executed instead of asking the user to accept it.",
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
