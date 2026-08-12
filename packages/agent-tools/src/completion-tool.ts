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

export interface UserInputQuestionRequest {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

export interface UserInputRequest {
  message: string;
  questions: UserInputQuestionRequest[];
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

function nonempty(value: JsonValue | undefined): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function parseUserInputQuestion(
  value: JsonValue,
  index: number
): UserInputQuestionRequest | null {
  const input = record(value);
  if (!input || Object.keys(input).some((key) =>
    !["id", "header", "question", "options", "multiSelect"].includes(key))) return null;
  const question = nonempty(input.question);
  if (!question) return null;
  const id = nonempty(input.id) ?? `question_${index + 1}`;
  const header = nonempty(input.header) ?? "Question";
  if (header.length > 12 || id.length > 128) return null;
  if (input.multiSelect !== undefined && typeof input.multiSelect !== "boolean") return null;
  if (input.options !== undefined && !Array.isArray(input.options)) return null;
  const options = (input.options ?? []).map((value) => {
    const option = record(value);
    if (!option || Object.keys(option).some((key) => !["label", "description"].includes(key))) {
      return null;
    }
    const label = nonempty(option.label);
    const description = nonempty(option.description);
    return label && description ? { label, description } : null;
  });
  if (options.some((option) => option === null) || options.length > 3) return null;
  return {
    id,
    header,
    question,
    options: options as Array<{ label: string; description: string }>,
    multiSelect: input.multiSelect === true
  };
}

export function parseUserInputRequest(value: JsonValue): UserInputRequest | null {
  const input = record(value);
  if (!input || Object.keys(input).some((key) => key !== "message" && key !== "questions")) {
    return null;
  }
  if (input.message !== undefined && typeof input.message !== "string") return null;
  if (input.questions !== undefined && !Array.isArray(input.questions)) return null;
  const parsedQuestions = (input.questions ?? []).map(parseUserInputQuestion);
  if (
    parsedQuestions.some((question) => question === null)
    || parsedQuestions.length > 3
  ) return null;
  const questions = parsedQuestions as UserInputQuestionRequest[];
  const message = nonempty(input.message) ?? questions[0]?.question;
  return message ? { message, questions } : null;
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
  const ok = value !== null;
  const output = value ? JSON.stringify(value) : "Blocked report does not match the required schema.";
  const effects: ToolReceipt["observedEffects"] = value ? ["outcome.report_blocked"] : [];
  const diagnostics = value ? [] : ["invalid_blocked_report"];
  return {
    callId: request.callId,
    ok,
    output,
    outcome: { status: ok ? "succeeded" : "failed", output, diagnosticCodes: diagnostics },
    observedEffects: effects,
    actualEffects: effects,
    artifacts: [],
    diagnostics,
    evidence: [],
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
    modelPresentation: { exposure: "direct" },
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
        message: {
          type: "string",
          description: "A concise fallback question for clients without structured input UI."
        },
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          description: "One to three structured questions, following the Codex request_user_input shape.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable answer key." },
              header: { type: "string", maxLength: 12, description: "Short UI label." },
              question: { type: "string", description: "The question shown to the user." },
              options: {
                type: "array",
                maxItems: 3,
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    description: { type: "string" }
                  },
                  required: ["label", "description"],
                  additionalProperties: false
                }
              },
              multiSelect: { type: "boolean" }
            },
            required: ["id", "header", "question", "options"],
            additionalProperties: false
          }
        }
      },
      anyOf: [{ required: ["message"] }, { required: ["questions"] }],
      additionalProperties: false
    },
    modelPresentation: { exposure: "direct" },
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
      const input = parseUserInputRequest(request.arguments);
      const ok = input !== null;
      const output = input
        ? JSON.stringify(input)
        : "User-input request requires a non-empty message or one to three valid questions.";
      const effects: ToolReceipt["observedEffects"] = input ? ["outcome.request_input"] : [];
      const diagnostics = input ? [] : ["invalid_user_input_request"];
      return {
        callId: request.callId,
        ok,
        output,
        outcome: { status: ok ? "succeeded" : "failed", output, diagnosticCodes: diagnostics },
        observedEffects: effects,
        actualEffects: effects,
        artifacts: [],
        diagnostics,
        evidence: [],
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
