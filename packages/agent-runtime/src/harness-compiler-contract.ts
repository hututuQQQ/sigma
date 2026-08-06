import type {
  ProfileAssurancePolicy,
  ResolvedAgentProfile
} from "agent-extensions";
import type {
  ModelCapabilities,
  ModelExecutionRole,
  RunMode
} from "agent-protocol";

export const HARNESS_BUILD_SCHEMA_VERSION = 1 as const;
export const HARNESS_COMPILER_VERSION = "1.0.0";
/**
 * Compiler artifacts are session ABI, not ephemeral cache entries. Keep every
 * version listed here until its schema restorer is deliberately retired by a
 * migration. A compiler bump must add a restorer instead of silently making
 * existing sessions unresumable.
 */
export const SUPPORTED_HARNESS_COMPILER_VERSIONS = ["1.0.0"] as const;

export type HarnessReasoningEffort =
  | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type HarnessToolBundleId =
  | "filesystem"
  | "planning"
  | "code_intelligence"
  | "web_media"
  | "process_environment"
  | "delegation"
  | "assurance_recovery";

export interface HarnessRuntimeToolCapability {
  name: string;
  source: "builtin" | "mcp";
}

export interface HarnessRuntimeCapabilities {
  tools: readonly HarnessRuntimeToolCapability[];
  executionMode: "sandboxed" | "container";
  writeScope: "workspace" | "enclosing-container";
  managedEnvironment: boolean;
  network: "none" | "loopback" | "full";
  interactiveApprovals: boolean;
}

export interface HarnessCompilerInput {
  provider: string;
  model: string;
  reasoningEffort?: HarnessReasoningEffort;
  modelRole: ModelExecutionRole;
  runMode: RunMode;
  modelCapabilities: Readonly<ModelCapabilities>;
  runtimeCapabilities: Readonly<HarnessRuntimeCapabilities>;
  resolvedAgentProfile?: Readonly<ResolvedAgentProfile>;
}

export interface HarnessConstraintSource {
  source: "runtime" | "profile" | "flagship_policy" | "default";
  id: string;
  constraints: readonly string[];
}

export interface HarnessPromptPolicy {
  variant: "flagship";
  behaviorContract: string;
  targetTokens: number;
}

export interface HarnessToolBundle {
  id: HarnessToolBundleId;
  tools: readonly string[];
  initiallyLoaded: boolean;
}

export interface HarnessToolPolicy {
  initialTools: readonly string[];
  potentialTools: readonly string[];
  stateActivatedTools: readonly string[];
  mcpTools: readonly string[];
  bundles: readonly HarnessToolBundle[];
  compactDescriptions: boolean;
  parameterProjection: Readonly<Record<string, readonly string[]>>;
}

export interface HarnessContextPolicy {
  historyTokenLimit: number;
  rawHistoryBlockTokenLimit: number;
  maximumRawHistoryBlocks: number;
  historySummaryTokenLimit: number;
  protectedRecentToolResultTokens: number;
  minimumToolResultPruneTokens: number;
  preserveProviderReasoningState: true;
}

export interface HarnessObservationPolicy {
  successfulToolOutputBytes: number;
  failedToolOutputBytes: number;
  projection: "head_tail";
  preserveDurableReceipts: true;
}

export interface HarnessTokenInspection {
  tokenizer: ModelCapabilities["tokenizer"];
  countMethod: "gateway.countTokens";
  mandatoryPromptTokens: number;
  initialToolSchemaTokens: number;
  combinedTokens: number;
  mandatoryPromptBytes: number;
  initialToolSchemaBytes: number;
}

export interface HarnessAssurancePolicy {
  reviewMode: "off" | "advisory" | "required";
  resourcePolicy: Readonly<ProfileAssurancePolicy>;
  automaticDelegation: false;
}

export interface FrozenHarnessBuild {
  schemaVersion: typeof HARNESS_BUILD_SCHEMA_VERSION;
  compilerVersion: string;
  policyPackIds: readonly string[];
  subject: Readonly<{
    provider: string;
    model: string;
    reasoningEffort: HarnessReasoningEffort | "provider_default";
    modelRole: ModelExecutionRole;
    runMode: RunMode;
    modelCapabilitiesDigest: string;
    profileId: string | null;
    profileDigest: string | null;
  }>;
  promptPolicy: Readonly<HarnessPromptPolicy>;
  toolPolicy: Readonly<HarnessToolPolicy>;
  contextPolicy: Readonly<HarnessContextPolicy>;
  observationPolicy: Readonly<HarnessObservationPolicy>;
  assurancePolicy: Readonly<HarnessAssurancePolicy>;
  constraintSources: readonly HarnessConstraintSource[];
  canonicalJson: string;
  digest: string;
}
