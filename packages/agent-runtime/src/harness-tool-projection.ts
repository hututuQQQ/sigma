import type { JsonValue, ToolDescriptor } from "agent-protocol";
import type { FrozenHarnessBuild } from "./harness-compiler.js";
import type { RuntimeSession } from "./types.js";

export const LOAD_TOOL_BUNDLE_NAME = "load_tool_bundle";

const FLAGSHIP_DESCRIPTIONS: Readonly<Record<string, string>> = {
  read: "Read a UTF-8 workspace file or a bounded line range.",
  read_batch: "Read several independent workspace files in one call.",
  list: "List a workspace directory with bounded metadata.",
  grep: "Search workspace text with a bounded regular expression.",
  shell: "Run a brokered shell command; declare expected workspace changes for mutation.",
  exec: "Run one brokered executable when no verified shell is available.",
  apply_patch: "Atomically apply a unified or Codex patch inside the workspace.",
  request_user_input: "Ask for a concrete user-owned decision and suspend the run.",
  report_blocked: "End only when a real external, permission, safety, or budget blocker remains."
};

function stateActivated(session: RuntimeSession, name: string): boolean {
  const state = session.durable.state;
  if (name === "load_skill") return (session.durable.frozenCustomization?.skills.length ?? 0) > 0;
  if (name === "read_artifact") {
    return state.receipts.some((receipt) =>
      receipt.artifacts.length > 0 || (receipt.artifactRefs?.length ?? 0) > 0);
  }
  if (["process_poll", "process_write", "process_terminate", "process_handoff"]
    .includes(name)) return state.activeProcessIds.length > 0;
  if (["message_agent", "join_agent", "list_agents", "integrate_agent"].includes(name)) {
    return state.childIds.length > 0
      || state.plan.nodes.some((node) => node.owner.kind === "child");
  }
  if (name === "read_plan") return state.plan.nodes.length > 32;
  if (["list_checkpoints", "restore_run_changes", "confirm_run_restored"].includes(name)) {
    return state.checkpointHead !== undefined || session.recovery.openCheckpointRecovery !== undefined;
  }
  return false;
}

function loadedBundleTools(session: RuntimeSession): Set<string> {
  const build = session.durable.frozenHarness;
  if (!build) return new Set();
  const loaded = new Set(session.durable.state.loadedToolBundles ?? []);
  return new Set(build.toolPolicy.bundles
    .filter((bundle) => bundle.initiallyLoaded || loaded.has(bundle.id))
    .flatMap((bundle) => [...bundle.tools]));
}

function bundleLoaded(session: RuntimeSession, bundleId: string): boolean {
  const build = session.durable.frozenHarness;
  if (!build) return false;
  return build.toolPolicy.bundles.some((bundle) =>
    bundle.id === bundleId
    && (bundle.initiallyLoaded
      || (session.durable.state.loadedToolBundles ?? []).includes(bundle.id)));
}

function visibleNames(session: RuntimeSession): Set<string> | undefined {
  const build = session.durable.frozenHarness;
  if (!build) return undefined;
  const names = new Set(build.toolPolicy.initialTools);
  for (const name of loadedBundleTools(session)) names.add(name);
  for (const name of build.toolPolicy.stateActivatedTools) {
    if (stateActivated(session, name)) names.add(name);
  }
  return names;
}

function projectedSchema(
  descriptor: ToolDescriptor,
  allowedParameters: readonly string[] | undefined
): ToolDescriptor["inputSchema"] {
  if (!allowedParameters) return descriptor.inputSchema;
  const properties = descriptor.inputSchema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return descriptor.inputSchema;
  }
  const allowed = new Set(allowedParameters);
  const selected = Object.fromEntries(Object.entries(properties)
    .filter(([name]) => allowed.has(name))) as Record<string, JsonValue>;
  const required = Array.isArray(descriptor.inputSchema.required)
    ? descriptor.inputSchema.required.filter((name): name is string =>
      typeof name === "string" && allowed.has(name))
    : undefined;
  return {
    ...descriptor.inputSchema,
    properties: selected,
    ...(required ? { required } : {})
  };
}

function conciseDescription(descriptor: ToolDescriptor): string {
  const known = FLAGSHIP_DESCRIPTIONS[descriptor.name];
  if (known) return known;
  const firstLine = descriptor.description.split(/\r?\n/u)[0]?.trim() ?? descriptor.description;
  const firstSentence = firstLine.match(/^.*?[.!?](?:\s|$)/u)?.[0]?.trim();
  const value = firstSentence || firstLine;
  return value.length <= 240 ? value : `${value.slice(0, 239)}...`;
}

function loadToolBundleDescriptorForBuild(
  build: FrozenHarnessBuild | undefined
): ToolDescriptor | undefined {
  if (!build || !build.toolPolicy.initialTools.includes(LOAD_TOOL_BUNDLE_NAME)) return undefined;
  const bundleIds = build.toolPolicy.bundles.map((bundle) => bundle.id);
  if (bundleIds.length === 0) return undefined;
  return {
    name: LOAD_TOOL_BUNDLE_NAME,
    description: "Persistently expose one or more relevant tool bundles for this session; combine currently needed bundles in one call and call alone.",
    inputSchema: {
      type: "object",
      properties: {
        bundleId: { type: "string", enum: bundleIds },
        bundleIds: {
          type: "array",
          items: { type: "string", enum: bundleIds },
          minItems: 1,
          maxItems: bundleIds.length,
          uniqueItems: true
        }
      },
      oneOf: [
        { required: ["bundleId"] },
        { required: ["bundleIds"] }
      ],
      additionalProperties: false
    },
    possibleEffects: ["runtime.control"],
    maximumEffects: ["runtime.control"],
    availableModes: ["analyze", "change"],
    executionMode: "exclusive",
    resourceKeys: ["runtime:harness"],
    approval: "auto",
    idempotent: true,
    timeoutMs: 5_000
  };
}

export function loadToolBundleDescriptor(session: RuntimeSession): ToolDescriptor | undefined {
  return loadToolBundleDescriptorForBuild(session.durable.frozenHarness);
}

function projectedPresentation(
  build: FrozenHarnessBuild,
  descriptor: ToolDescriptor,
  expandedShell: boolean
): ToolDescriptor {
  return {
    ...descriptor,
    description: build.toolPolicy.compactDescriptions
      ? conciseDescription(descriptor) : descriptor.description,
    inputSchema: projectedSchema(descriptor,
      descriptor.name === "shell" && expandedShell
        ? undefined
        : build.toolPolicy.parameterProjection[descriptor.name])
  };
}

/** Pure projection of the first-turn tool surface. Used by inspection and
 * token measurement without creating a session or persisting runtime state. */
export function projectInitialHarnessToolDescriptors(
  build: FrozenHarnessBuild,
  descriptors: readonly ToolDescriptor[]
): ToolDescriptor[] {
  const visible = new Set(build.toolPolicy.initialTools);
  const loader = loadToolBundleDescriptorForBuild(build);
  return [...descriptors, ...(loader ? [loader] : [])]
    .filter((descriptor) => visible.has(descriptor.name))
    .map((descriptor) => projectedPresentation(build, descriptor, false));
}

/** Apply the exact frozen tool policy. The caller still intersects this with
 * live runtime, mode, profile, and state gates, so a restored build cannot
 * manufacture authority or call a tool that was never offered. */
export function projectHarnessToolDescriptors(
  session: RuntimeSession,
  descriptors: readonly ToolDescriptor[]
): ToolDescriptor[] {
  const build = session.durable.frozenHarness;
  if (!build) return [...descriptors];
  const visible = visibleNames(session)!;
  const loader = loadToolBundleDescriptor(session);
  const candidates = loader ? [...descriptors, loader] : [...descriptors];
  return candidates
    .filter((descriptor) => visible.has(descriptor.name))
    .map((descriptor) => projectedPresentation(
      build,
      descriptor,
      bundleLoaded(session, "process_environment")
    ));
}
