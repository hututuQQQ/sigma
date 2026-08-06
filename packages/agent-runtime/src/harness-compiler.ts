import { createHash } from "node:crypto";
import {
  DEFAULT_PROFILE_ASSURANCE,
  type ProfileAssurancePolicy,
  type ResolvedAgentProfile
} from "agent-extensions";
import {
  HARNESS_BUILD_SCHEMA_VERSION,
  HARNESS_COMPILER_VERSION,
  SUPPORTED_HARNESS_COMPILER_VERSIONS,
  type FrozenHarnessBuild,
  type HarnessAssurancePolicy,
  type HarnessCompilerInput,
  type HarnessConstraintSource,
  type HarnessToolBundleId,
  type HarnessToolPolicy
} from "./harness-compiler-contract.js";

export * from "./harness-compiler-contract.js";

type StoredHarnessBuild = Omit<FrozenHarnessBuild, "canonicalJson" | "digest">;

type HarnessArtifactRestorer = (value: Readonly<StoredHarnessBuild>) => StoredHarnessBuild;

function restoreSchemaOne(value: Readonly<StoredHarnessBuild>): StoredHarnessBuild {
  return structuredClone(value);
}

const HARNESS_ARTIFACT_RESTORERS: Readonly<Record<string, HarnessArtifactRestorer>> =
  Object.freeze(Object.fromEntries(
    SUPPORTED_HARNESS_COMPILER_VERSIONS.map((version) => [version, restoreSchemaOne])
  ));

const BUNDLES: Readonly<Record<HarnessToolBundleId, readonly string[]>> = {
  filesystem: [
    "write", "edit", "write_chunk", "delete_file", "git_status", "git_diff",
    "repository_stats"
  ],
  planning: ["read_plan", "update_plan", "read_budget"],
  code_intelligence: ["lsp"],
  web_media: ["web_run", "inspect_document", "inspect_image"],
  process_environment: [
    "shell", "exec", "validate", "process_spawn", "process_poll", "process_write",
    "process_terminate", "process_handoff", "environment_prepare"
  ],
  delegation: [
    "spawn_agent", "message_agent", "join_agent", "list_agents", "integrate_agent"
  ],
  assurance_recovery: [
    "request_review", "request_strategy", "read_workspace_frontier", "read_artifact",
    "list_checkpoints", "restore_run_changes", "confirm_run_restored", "git_transaction"
  ]
};

const CORE_TOOLS = [
  "read", "read_batch", "list", "grep", "shell", "apply_patch",
  "load_tool_bundle", "request_user_input", "report_blocked"
] as const;

const STATE_ACTIVATED_TOOLS = [
  "load_skill", "read_artifact", "process_poll", "process_write", "process_terminate",
  "process_handoff", "message_agent", "join_agent", "list_agents", "integrate_agent",
  "read_plan", "list_checkpoints", "restore_run_changes", "confirm_run_restored",
] as const;

const WRITE_TOOLS = new Set([
  "write", "edit", "write_chunk", "delete_file", "apply_patch", "restore_run_changes",
  "git_transaction", "integrate_agent"
]);

const KNOWN_BUILTIN_TOOLS = new Set<string>([
  ...CORE_TOOLS,
  ...STATE_ACTIVATED_TOOLS,
  ...Object.values(BUNDLES).flat()
]);

export function isKnownHarnessBuiltinTool(name: string): boolean {
  return KNOWN_BUILTIN_TOOLS.has(name);
}

const FLAGSHIP_SHELL_PARAMETERS = [
  "command", "cwd", "env", "timeoutMs", "validation", "expectedChanges",
  "background", "yieldMs"
] as const;

const FLAGSHIP_BEHAVIOR = `You are Sigma Code. Complete the user's request autonomously until it is genuinely handled or a real safety, permission, budget, cancellation, or external constraint blocks progress.

Follow system, developer, user, and applicable project instructions. Inspect relevant state before acting; preserve unrelated work and existing behavior. In analyze mode do not mutate. In change mode make only in-scope changes. Treat tool results as observations, batch independent reads when useful, and adapt from failures without repeating settled side effects.

Keep the user oriented during long work with brief, meaningful updates. Ask for input only when a concrete user-owned decision is necessary. Respect every approval, sandbox, path, checkpoint, transaction, process, and resource boundary. Never claim a change or validation without durable evidence. Before finishing, run the relevant tests or checks and report anything not run or still failing. Stop naturally when complete; use report_blocked only for a real blocker.`;

function canonicalize(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, visit(child)]));
  };
  return JSON.stringify(visit(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactInputKeys(input: HarnessCompilerInput): void {
  const allowed = new Set([
    "provider", "model", "reasoningEffort", "modelRole", "runMode",
    "modelCapabilities", "runtimeCapabilities", "resolvedAgentProfile"
  ]);
  const unexpected = Object.keys(input).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Harness compiler input contains forbidden fields: ${unexpected.join(", ")}.`);
  }
}

function profileAllows(name: string, profile: Readonly<ResolvedAgentProfile> | undefined): boolean {
  if (!profile) return true;
  if (profile.toolDeny.includes(name)) return false;
  return profile.toolAllow === null || profile.toolAllow.includes(name);
}

function availableTools(input: HarnessCompilerInput): {
  names: Set<string>;
  mcp: string[];
} {
  const runtimeNames = new Set(input.runtimeCapabilities.tools.map((tool) => tool.name));
  const names = new Set([...runtimeNames, "read_batch", "load_tool_bundle"]
    .filter((name) => profileAllows(name, input.resolvedAgentProfile))
    .filter((name) => input.runMode === "change" || !WRITE_TOOLS.has(name)));
  const mcp = input.runtimeCapabilities.tools
    .filter((tool) => tool.source === "mcp" && names.has(tool.name))
    .map((tool) => tool.name)
    .sort();
  return { names, mcp };
}

function compiledToolPolicy(input: HarnessCompilerInput): HarnessToolPolicy {
  const available = availableTools(input);
  const bundles = (Object.keys(BUNDLES) as HarnessToolBundleId[]).map((id) => ({
    id,
    tools: BUNDLES[id].filter((name) => available.names.has(name)).sort(),
    initiallyLoaded: false
  })).filter((bundle) => bundle.tools.length > 0);
  const bundleTools = new Set(bundles.flatMap((bundle) => [...bundle.tools]));
  const foregroundExecutionTool = available.names.has("shell")
    ? "shell"
    : available.names.has("exec") ? "exec" : undefined;
  const initial = new Set([
    ...CORE_TOOLS.filter((name) => available.names.has(name)),
    ...(foregroundExecutionTool ? [foregroundExecutionTool] : []),
    ...bundles.filter((bundle) => bundle.initiallyLoaded).flatMap((bundle) => [...bundle.tools]),
    ...available.mcp
  ]);
  const stateActivatedTools = STATE_ACTIVATED_TOOLS
    .filter((name) => available.names.has(name)).sort();
  const stateActivated = new Set<string>(stateActivatedTools);
  const potentialTools = [...available.names]
    .filter((name) => initial.has(name) || bundleTools.has(name)
      || stateActivated.has(name) || available.mcp.includes(name))
    .sort();
  return {
    initialTools: [...initial].sort(),
    potentialTools,
    stateActivatedTools,
    mcpTools: available.mcp,
    bundles,
    compactDescriptions: true,
    parameterProjection: available.names.has("shell")
      ? { shell: [...FLAGSHIP_SHELL_PARAMETERS] }
      : {}
  };
}

function profileAssurance(input: HarnessCompilerInput): HarnessAssurancePolicy {
  const profile = input.resolvedAgentProfile;
  const original = profile?.assurancePolicy ?? DEFAULT_PROFILE_ASSURANCE;
  const resourcePolicy: ProfileAssurancePolicy = {
    ...original,
    strategistMode: original.strategistMode === "adaptive"
      ? "on_demand"
      : original.strategistMode
  };
  return {
    reviewMode: profile?.mutationPolicy.reviewMode ?? "advisory",
    resourcePolicy,
    automaticDelegation: false
  };
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function materialize(stored: StoredHarnessBuild): FrozenHarnessBuild {
  const canonicalJson = canonicalize(stored);
  return deepFreeze({
    ...structuredClone(stored),
    canonicalJson,
    digest: sha256(canonicalJson)
  }) as FrozenHarnessBuild;
}

function compilerSubject(
  input: HarnessCompilerInput,
  profile: Readonly<ResolvedAgentProfile> | undefined
): FrozenHarnessBuild["subject"] {
  return {
    provider: input.provider,
    model: input.model,
    reasoningEffort: input.reasoningEffort ?? "provider_default",
    modelRole: input.modelRole,
    runMode: input.runMode,
    modelCapabilitiesDigest: sha256(canonicalize(input.modelCapabilities)),
    profileId: profile?.id ?? null,
    profileDigest: profile ? sha256(canonicalize(profile)) : null
  };
}

function compilerConstraintSources(
  input: HarnessCompilerInput,
  profile: Readonly<ResolvedAgentProfile> | undefined
): HarnessConstraintSource[] {
  return [
    {
      source: "runtime", id: "runtime-capabilities",
      constraints: [
        `execution=${input.runtimeCapabilities.executionMode}`,
        `write_scope=${input.runtimeCapabilities.writeScope}`,
        `network=${input.runtimeCapabilities.network}`,
        `tools=${input.runtimeCapabilities.tools.length}`
      ]
    },
    {
      source: "profile", id: profile?.id ?? "implicit-default",
      constraints: [
        `permission=${profile?.permissionMode ?? "runtime"}`,
        `review=${profile?.mutationPolicy.reviewMode ?? "advisory"}`,
        `tool_allow=${profile?.toolAllow === null || !profile ? "all" : profile.toolAllow.length}`,
        `tool_deny=${profile?.toolDeny.length ?? 0}`
      ]
    },
    {
      source: "flagship_policy", id: "sigma.flagship.v1",
      constraints: ["lean_prompt", "core_tools_initial", "on_demand_strategy", "compact_observations"]
    },
    {
      source: "default", id: "sigma.safety.v1",
      constraints: ["durable_receipts", "provider_reasoning_preserved"]
    }
  ];
}

export function compileHarnessBuild(input: HarnessCompilerInput): FrozenHarnessBuild {
  exactInputKeys(input);
  const profile = input.resolvedAgentProfile;
  const historyTokenLimit = Math.min(
    160_000,
    Math.max(32_000, Math.floor(input.modelCapabilities.contextWindowTokens * 0.35))
  );
  const stored: StoredHarnessBuild = {
    schemaVersion: HARNESS_BUILD_SCHEMA_VERSION,
    compilerVersion: HARNESS_COMPILER_VERSION,
    policyPackIds: [
      "sigma.safety.v1", "sigma.profile.v1", "sigma.flagship.v1"
    ],
    subject: compilerSubject(input, profile),
    promptPolicy: {
      variant: "flagship",
      behaviorContract: FLAGSHIP_BEHAVIOR,
      targetTokens: 450
    },
    toolPolicy: compiledToolPolicy(input),
    contextPolicy: {
      historyTokenLimit,
      rawHistoryBlockTokenLimit: 24_000,
      maximumRawHistoryBlocks: 32,
      historySummaryTokenLimit: 8_000,
      protectedRecentToolResultTokens: 24_000,
      minimumToolResultPruneTokens: 8_000,
      preserveProviderReasoningState: true
    },
    observationPolicy: {
      successfulToolOutputBytes: 8 * 1_024,
      failedToolOutputBytes: 12 * 1_024,
      projection: "head_tail",
      preserveDurableReceipts: true
    },
    assurancePolicy: profileAssurance(input),
    constraintSources: compilerConstraintSources(input, profile)
  };
  return materialize(stored);
}

export function restoreHarnessBuild(
  canonicalJson: string,
  expectedDigest: string
): FrozenHarnessBuild {
  if (!/^[a-f0-9]{64}$/u.test(expectedDigest) || sha256(canonicalJson) !== expectedDigest) {
    throw Object.assign(new Error("Frozen Harness artifact digest does not match its event."), {
      code: "harness_artifact_digest_mismatch"
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalJson);
  } catch (error) {
    throw new Error("Frozen Harness artifact is not valid JSON.", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Frozen Harness artifact has an invalid schema.");
  }
  const stored = parsed as StoredHarnessBuild;
  const restorer = typeof stored.compilerVersion === "string"
    ? HARNESS_ARTIFACT_RESTORERS[stored.compilerVersion]
    : undefined;
  if (stored.schemaVersion !== HARNESS_BUILD_SCHEMA_VERSION
    || !restorer
    || canonicalize(stored) !== canonicalJson) {
    throw Object.assign(new Error("Frozen Harness artifact is unsupported or non-canonical."), {
      code: "unsupported_harness_schema"
    });
  }
  return materialize(restorer(stored));
}
