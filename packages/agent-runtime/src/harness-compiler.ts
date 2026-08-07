import { createHash } from "node:crypto";
import type { ResolvedAgentProfile } from "agent-extensions";
import type {
  ModelCapabilities,
  ModelExecutionRole,
  ModelToolDefinition,
  RunMode
} from "agent-protocol";
import type { RuntimeEnvironment } from "agent-platform";
import { baseContext } from "./runtime-context.js";

export const HARNESS_BUILD_SCHEMA_VERSION = 1 as const;
export const HARNESS_COMPILER_VERSION = "identity-1.0.0";

export type HarnessReasoningEffort =
  | "provider_default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface HarnessRuntimeCapabilities {
  /** Exact initial model-visible tool definitions in runtime order. */
  tools: readonly ModelToolDefinition[];
  executionMode: "sandboxed" | "container";
  writeScope: "workspace" | "enclosing-container";
  managedEnvironment: boolean;
  network: "none" | "loopback" | "full";
  interactiveApprovals: boolean;
  /** Exact broker-derived environment used to construct runtime:environment. */
  environment: Readonly<RuntimeEnvironment>;
}

export interface HarnessCompilerInput {
  provider: string;
  model: string;
  reasoningEffort: HarnessReasoningEffort;
  modelRole: ModelExecutionRole;
  runMode: RunMode;
  modelCapabilities: Readonly<ModelCapabilities>;
  runtimeCapabilities: Readonly<HarnessRuntimeCapabilities>;
  resolvedAgentProfile: Readonly<ResolvedAgentProfile>;
}

export interface FrozenHarnessBuild {
  schemaVersion: typeof HARNESS_BUILD_SCHEMA_VERSION;
  compilerVersion: typeof HARNESS_COMPILER_VERSION;
  policyPackIds: readonly ["sigma.runtime-default.identity.v1"];
  activation: "inspection_only";
  modifiesRuntime: false;
  subject: Readonly<{
    provider: string;
    model: string;
    reasoningEffort: HarnessReasoningEffort;
    modelRole: ModelExecutionRole;
    runMode: RunMode;
    modelCapabilitiesDigest: string;
    profileId: string;
    profileDigest: string;
  }>;
  promptPolicy: Readonly<{
    mode: "runtime_default";
    modifiesPrompt: false;
    systemBehaviorDigest: string;
    runtimeEnvironmentDigest: string;
  }>;
  toolPolicy: Readonly<{
    mode: "runtime_default";
    modifiesToolSurface: false;
    initialTools: readonly string[];
    initialToolDefinitionsDigest: string;
  }>;
  contextPolicy: Readonly<{
    mode: "runtime_default";
    modifiesContext: false;
  }>;
  observationPolicy: Readonly<{
    mode: "runtime_default";
    modifiesObservations: false;
  }>;
  runtimeCapabilities: Readonly<Omit<HarnessRuntimeCapabilities, "tools">>;
  policyDigest: string;
  canonicalJson: string;
  digest: string;
}

const INPUT_KEYS = [
  "provider",
  "model",
  "reasoningEffort",
  "modelRole",
  "runMode",
  "modelCapabilities",
  "runtimeCapabilities",
  "resolvedAgentProfile"
] as const;

const RUNTIME_CAPABILITY_KEYS = [
  "tools",
  "executionMode",
  "writeScope",
  "managedEnvironment",
  "network",
  "interactiveApprovals",
  "environment"
] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonValue(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Harness identity contains a non-JSON value.");
  return JSON.parse(encoded) as unknown;
}

export function canonicalHarnessJson(value: unknown): string {
  const normalized = jsonValue(value);
  const encode = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${encode(record[key])}`).join(",")}}`;
    }
    return JSON.stringify(item);
  };
  return encode(normalized);
}

function exactKeys(
  value: object,
  keys: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} has an invalid field set (expected ${expected.join(", ")}).`
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return Object.freeze(value);
}

function promptContextDigests(environment: RuntimeEnvironment): {
  systemBehaviorDigest: string;
  runtimeEnvironmentDigest: string;
} {
  const context = baseContext(environment);
  const behavior = context.find((item) => item.id === "system:behavior")?.content;
  const runtimeEnvironment = context.find((item) => item.id === "runtime:environment")?.content;
  if (!behavior || !runtimeEnvironment) {
    throw new Error("Sigma runtime prompt context is unavailable.");
  }
  return {
    systemBehaviorDigest: sha256(behavior),
    runtimeEnvironmentDigest: sha256(runtimeEnvironment)
  };
}

/**
 * Compile a reproducible identity for the unmodified main Harness.
 *
 * This build is deliberately inspection-only: `run` does not consume it and
 * no policy in this artifact may change prompts, tools, context, observations,
 * admission, or retries. All undeclared data is excluded by the exact input
 * boundary above.
 */
export function compileHarnessBuild(input: HarnessCompilerInput): FrozenHarnessBuild {
  exactKeys(input, INPUT_KEYS, "Harness compiler input");
  exactKeys(
    input.runtimeCapabilities,
    RUNTIME_CAPABILITY_KEYS,
    "Harness compiler runtime capabilities"
  );
  const modelCapabilitiesDigest = sha256(canonicalHarnessJson(input.modelCapabilities));
  const profileDigest = sha256(canonicalHarnessJson(input.resolvedAgentProfile));
  const initialToolDefinitionsDigest = sha256(
    canonicalHarnessJson(input.runtimeCapabilities.tools)
  );
  const policyPackIds = ["sigma.runtime-default.identity.v1"] as const;
  const promptPolicy = {
    mode: "runtime_default" as const,
    modifiesPrompt: false as const,
    ...promptContextDigests(input.runtimeCapabilities.environment)
  };
  const policyDigest = sha256(canonicalHarnessJson({
    schemaVersion: HARNESS_BUILD_SCHEMA_VERSION,
    compilerVersion: HARNESS_COMPILER_VERSION as typeof HARNESS_COMPILER_VERSION,
    policyPackIds,
    activation: "inspection_only",
    modifiesRuntime: false,
    promptPolicy,
    toolMode: "runtime_default",
    contextMode: "runtime_default",
    observationMode: "runtime_default"
  }));
  const { tools: _tools, ...runtimeCapabilities } = input.runtimeCapabilities;
  const stored = {
    schemaVersion: HARNESS_BUILD_SCHEMA_VERSION,
    compilerVersion: HARNESS_COMPILER_VERSION as typeof HARNESS_COMPILER_VERSION,
    policyPackIds,
    activation: "inspection_only" as const,
    modifiesRuntime: false as const,
    subject: {
      provider: input.provider,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      modelRole: input.modelRole,
      runMode: input.runMode,
      modelCapabilitiesDigest,
      profileId: input.resolvedAgentProfile.id,
      profileDigest
    },
    promptPolicy,
    toolPolicy: {
      mode: "runtime_default" as const,
      modifiesToolSurface: false as const,
      initialTools: input.runtimeCapabilities.tools.map((tool) => tool.name),
      initialToolDefinitionsDigest
    },
    contextPolicy: {
      mode: "runtime_default" as const,
      modifiesContext: false as const
    },
    observationPolicy: {
      mode: "runtime_default" as const,
      modifiesObservations: false as const
    },
    runtimeCapabilities,
    policyDigest
  };
  const canonicalJson = canonicalHarnessJson(stored);
  return deepFreeze({ ...stored, canonicalJson, digest: sha256(canonicalJson) });
}
