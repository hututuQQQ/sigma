import {
  getSupportedThinkingLevels,
  type Api,
  type AuthType,
  type Model,
  type Provider
} from "@earendil-works/pi-ai";
import type { ModelCapabilities } from "agent-protocol";
import { hasKnownPricing } from "./model-pricing.js";

export type PiBillingMode = "metered" | "subscription" | "unpriced";
export const PI_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
] as const;
export type PiReasoningEffort = (typeof PI_REASONING_EFFORTS)[number];
export const DEFAULT_PI_REASONING_EFFORT: PiReasoningEffort = "medium";

export interface PiAuthMethodDescriptor {
  id: string;
  label: string;
  kind: AuthType;
  billingMode: PiBillingMode;
}

export interface PiProviderDescriptor {
  id: string;
  name: string;
  dynamic: boolean;
  authMethods: readonly PiAuthMethodDescriptor[];
}

export interface PiModelDescriptor {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  api: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  reasoning: boolean;
  imageInput: boolean;
  capabilities: ModelCapabilities;
  billingModes: readonly PiBillingMode[];
  pricing?: import("./model-pricing.js").PiModelPricing;
  recommended: boolean;
  supportedReasoningEfforts: readonly PiReasoningEffort[];
  defaultReasoningEffort?: PiReasoningEffort;
}

const subscriptionAuth = new Set<string>([
  "openai-codex/oauth",
  "anthropic/oauth",
  "github-copilot/api_key",
  "github-copilot/oauth",
  "kimi-coding/api_key",
  "kimi-coding/oauth",
  "xai/oauth",
  "qwen-token-plan/api_key",
  "qwen-token-plan-cn/api_key",
  "xiaomi-token-plan-ams/api_key",
  "xiaomi-token-plan-cn/api_key",
  "xiaomi-token-plan-sgp/api_key",
  "zai/api_key",
  "zai-coding-cn/api_key"
]);

export function supportedReasoningEfforts(model: Model<Api>): readonly PiReasoningEffort[] {
  if (!model.reasoning) return [];
  const supportedLevels = new Set(getSupportedThinkingLevels(model));
  const candidates = PI_REASONING_EFFORTS.flatMap((effort) => {
    const level = effort === "none" ? "off" : effort;
    if (!supportedLevels.has(level)) return [];
    const mapped = model.thinkingLevelMap?.[level];
    return [{ effort, effective: typeof mapped === "string" ? mapped.toLowerCase() : level }];
  });
  const effectiveLevels = new Map<string, PiReasoningEffort[]>();
  for (const candidate of candidates) {
    const efforts = effectiveLevels.get(candidate.effective) ?? [];
    efforts.push(candidate.effort);
    effectiveLevels.set(candidate.effective, efforts);
  }
  const supported = new Set<PiReasoningEffort>();
  for (const [effective, efforts] of effectiveLevels) {
    supported.add(efforts.find((effort) => effort === effective) ?? efforts[0]!);
  }
  const result = PI_REASONING_EFFORTS.filter((effort) => supported.has(effort));
  return result.length > 1 ? result : [];
}

export function piBillingMode(
  providerId: string,
  authType: AuthType,
  model?: Model<Api>
): PiBillingMode {
  if (subscriptionAuth.has(`${providerId}/${authType}`)) return "subscription";
  if (providerId === "radius") return "unpriced";
  return model && hasKnownPricing(model) ? "metered" : "unpriced";
}

export function providerAuthMethods(provider: Provider): PiAuthMethodDescriptor[] {
  const providerModels = provider.getModels();
  const mode = (authType: AuthType): PiBillingMode => {
    if (subscriptionAuth.has(`${provider.id}/${authType}`)) return "subscription";
    if (provider.id === "radius") return "unpriced";
    return providerModels.length > 0 && providerModels.every(hasKnownPricing)
      ? "metered"
      : "unpriced";
  };
  const result: PiAuthMethodDescriptor[] = [];
  if (provider.auth.apiKey?.login) {
    result.push({
      id: "api-key",
      label: provider.auth.apiKey.name,
      kind: "api_key",
      billingMode: mode("api_key")
    });
  }
  if (provider.auth.oauth) {
    if (provider.id === "openai-codex") {
      result.push(
        { id: "browser", label: "Login with ChatGPT", kind: "oauth", billingMode: "subscription" },
        { id: "device-code", label: "Use device code", kind: "oauth", billingMode: "subscription" }
      );
    } else {
      result.push({
        id: "oauth",
        label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
        kind: "oauth",
        billingMode: mode("oauth")
      });
    }
  }
  return result;
}
