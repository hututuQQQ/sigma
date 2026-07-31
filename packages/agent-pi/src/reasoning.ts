import {
  clampThinkingLevel,
  type Api,
  type Context,
  type Model,
  type ThinkingLevel
} from "@earendil-works/pi-ai";
import {
  adjustMaxTokensForThinking,
  clampMaxTokensToContext
} from "@earendil-works/pi-ai/api/simple-options";
import type { PiReasoningEffort } from "./models.js";

const MISTRAL_REASONING_EFFORT_MODELS = new Set([
  "mistral-small-2603",
  "mistral-small-latest",
  "mistral-medium-3.5"
]);

function budgetLevel(
  level: ThinkingLevel
): Exclude<ThinkingLevel, "xhigh" | "max"> {
  return level === "xhigh" || level === "max" ? "high" : level;
}

function anthropicEffort(model: Model<Api>, level: ThinkingLevel): string {
  const mapped = model.thinkingLevelMap?.[level];
  if (typeof mapped === "string") return mapped;
  if (level === "minimal" || level === "low") return "low";
  if (level === "medium") return "medium";
  return "high";
}

function anthropicReasoningOptions(
  model: Model<Api>,
  level: ThinkingLevel,
  context: Context,
  requestedMaxTokens: number | undefined
): Readonly<Record<string, unknown>> {
  if (
    model.compat
    && "forceAdaptiveThinking" in model.compat
    && model.compat.forceAdaptiveThinking === true
  ) {
    return {
      thinkingEnabled: true,
      effort: anthropicEffort(model, level)
    };
  }
  const baseMaxTokens = clampMaxTokensToContext(
    model,
    context,
    requestedMaxTokens ?? model.maxTokens
  );
  const adjusted = adjustMaxTokensForThinking(baseMaxTokens, model.maxTokens, level);
  const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);
  return {
    maxTokens,
    thinkingEnabled: true,
    thinkingBudgetTokens: Math.min(
      adjusted.thinkingBudget,
      Math.max(0, maxTokens - 1_024)
    )
  };
}

function bedrockModelMatchCandidates(model: Model<Api>): readonly string[] {
  return [model.id, model.name].flatMap((value) => {
    const lower = value.toLowerCase();
    return [lower, lower.replace(/[\s_.:]+/gu, "-")];
  });
}

function isAnthropicBedrockModel(model: Model<Api>): boolean {
  const id = model.id.toLowerCase();
  const name = model.name.toLowerCase();
  return id.includes("anthropic.claude")
    || id.includes("anthropic/claude")
    || name.includes("anthropic.claude")
    || name.includes("anthropic/claude")
    || name.includes("claude");
}

function supportsBedrockAdaptiveThinking(model: Model<Api>): boolean {
  return bedrockModelMatchCandidates(model).some((candidate) =>
    [
      "opus-4-6",
      "opus-4-7",
      "opus-4-8",
      "opus-5",
      "sonnet-4-6",
      "sonnet-5",
      "fable-5"
    ].some((marker) => candidate.includes(marker)));
}

function bedrockReasoningOptions(
  model: Model<Api>,
  level: ThinkingLevel,
  context: Context,
  requestedMaxTokens: number | undefined
): Readonly<Record<string, unknown>> {
  if (!isAnthropicBedrockModel(model) || supportsBedrockAdaptiveThinking(model)) {
    return { reasoning: level };
  }
  const baseMaxTokens = clampMaxTokensToContext(
    model,
    context,
    requestedMaxTokens ?? model.maxTokens
  );
  const adjusted = adjustMaxTokensForThinking(baseMaxTokens, model.maxTokens, level);
  const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);
  const normalizedLevel = budgetLevel(level);
  return {
    maxTokens,
    reasoning: level,
    thinkingBudgets: {
      [normalizedLevel]: Math.min(
        adjusted.thinkingBudget,
        Math.max(0, maxTokens - 1_024)
      )
    }
  };
}

function isGemini3Pro(model: Model<Api>): boolean {
  return /gemini-3(?:\.\d+)?-pro/u.test(model.id.toLowerCase());
}

function isGemini3Flash(model: Model<Api>): boolean {
  const id = model.id.toLowerCase();
  return /gemini-3(?:\.\d+)?-flash/u.test(id)
    || id === "gemini-flash-latest"
    || id === "gemini-flash-lite-latest";
}

function isGemma4(model: Model<Api>): boolean {
  return /gemma-?4/u.test(model.id.toLowerCase());
}

function googleThinkingLevel(model: Model<Api>, level: ThinkingLevel): string {
  const normalized = budgetLevel(level);
  if (isGemini3Pro(model)) {
    return normalized === "minimal" || normalized === "low" ? "LOW" : "HIGH";
  }
  if (isGemma4(model)) {
    return normalized === "minimal" || normalized === "low" ? "MINIMAL" : "HIGH";
  }
  return normalized.toUpperCase();
}

function googleThinkingBudget(model: Model<Api>, level: ThinkingLevel): number {
  const normalized = budgetLevel(level);
  if (model.id.includes("2.5-pro")) {
    return {
      minimal: 128,
      low: 2_048,
      medium: 8_192,
      high: 32_768
    }[normalized];
  }
  if (model.id.includes("2.5-flash-lite")) {
    return {
      minimal: 512,
      low: 2_048,
      medium: 8_192,
      high: 24_576
    }[normalized];
  }
  if (model.id.includes("2.5-flash")) {
    return {
      minimal: 128,
      low: 2_048,
      medium: 8_192,
      high: 24_576
    }[normalized];
  }
  return -1;
}

function googleReasoningOptions(
  model: Model<Api>,
  level: ThinkingLevel
): Readonly<Record<string, unknown>> {
  const usesThinkingLevel = isGemini3Pro(model)
    || isGemini3Flash(model)
    || (model.api === "google-generative-ai" && isGemma4(model));
  return usesThinkingLevel
    ? {
        thinking: {
          enabled: true,
          level: googleThinkingLevel(model, level)
        }
      }
    : {
        thinking: {
          enabled: true,
          budgetTokens: googleThinkingBudget(model, level)
        }
      };
}

function disabledReasoningOptions(model: Model<Api>): Readonly<Record<string, unknown>> {
  switch (model.api) {
    case "openai-codex-responses":
      return { reasoningEffort: "none" };
    case "anthropic-messages":
      return { thinkingEnabled: false };
    case "google-generative-ai":
    case "google-vertex":
      return { thinking: { enabled: false } };
    default:
      return {};
  }
}

function enabledReasoningOptions(
  model: Model<Api>,
  level: ThinkingLevel,
  context: Context,
  requestedMaxTokens: number | undefined
): Readonly<Record<string, unknown>> {
  switch (model.api) {
    case "openai-completions":
    case "openai-responses":
    case "openai-codex-responses":
    case "azure-openai-responses":
      return { reasoningEffort: level };
    case "anthropic-messages":
      return anthropicReasoningOptions(model, level, context, requestedMaxTokens);
    case "google-generative-ai":
    case "google-vertex":
      return googleReasoningOptions(model, level);
    case "bedrock-converse-stream":
      return bedrockReasoningOptions(model, level, context, requestedMaxTokens);
    case "pi-messages":
      return { reasoning: level };
    case "mistral-conversations":
      return MISTRAL_REASONING_EFFORT_MODELS.has(model.id)
        ? { reasoningEffort: model.thinkingLevelMap?.[level] ?? "high" }
        : { promptMode: "reasoning" };
    default:
      return { reasoning: level };
  }
}

/**
 * Translate Sigma's provider-neutral effort into the direct Pi API options.
 * The gateway intentionally keeps using `Models.stream` so provider-specific
 * tool choice, payload hooks, and transport settings remain intact.
 */
export function piReasoningStreamOptions(
  model: Model<Api>,
  effort: PiReasoningEffort | undefined,
  context: Context,
  requestedMaxTokens?: number
): Readonly<Record<string, unknown>> {
  if (!effort || !model.reasoning) return {};
  const requestedLevel = effort === "none" ? "off" : effort;
  const level = clampThinkingLevel(model, requestedLevel);
  return level === "off"
    ? disabledReasoningOptions(model)
    : enabledReasoningOptions(model, level, context, requestedMaxTokens);
}
