import type { FrozenAgentProfile } from "agent-extensions";
import type { RuntimeEnvironment } from "agent-platform";
import type {
  AgentEventPayloadMap,
  ModelExecutionRole,
  ModelGateway,
  RunMode
} from "agent-protocol";
import type { ContentAddressedArtifactStore } from "agent-store";
import { baseContext } from "./runtime-context.js";
import {
  compileHarnessBuild,
  HARNESS_COMPILER_VERSION,
  restoreHarnessBuild,
  type FrozenHarnessBuild
} from "./harness-compiler.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import type { RuntimeOptions, RuntimeSession } from "./types.js";

function runtimeToolCapabilities(options: RuntimeOptions) {
  // Production composition supplies the exact pre-MCP built-in set. Direct
  // embedders that omit it are declaring their injected registry as an
  // external, explicitly configured surface, so those tools remain visible.
  const builtin = new Set(options.builtinToolNames ?? []);
  return options.tools.descriptors().map((tool) => ({
    name: tool.name,
    source: builtin.has(tool.name) ? "builtin" as const : "mcp" as const
  }));
}

export function compileRuntimeHarness(
  options: RuntimeOptions,
  gateway: ModelGateway,
  modelRole: ModelExecutionRole,
  runMode: RunMode,
  profile?: FrozenAgentProfile
): FrozenHarnessBuild {
  const environment = options.runtimeEnvironment;
  return compileHarnessBuild({
    provider: gateway.provider,
    model: gateway.model,
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    modelRole,
    runMode,
    modelCapabilities: gateway.capabilities,
    runtimeCapabilities: {
      tools: runtimeToolCapabilities(options),
      executionMode: environment?.executionMode ?? "sandboxed",
      writeScope: environment?.writeScope ?? "workspace",
      managedEnvironment: options.managedEnvironmentMode === "required",
      network: options.managedNetworkMode ?? "full",
      interactiveApprovals: options.interactiveApprovals === true
    },
    ...(profile ? { resolvedAgentProfile: profile.profile } : {})
  });
}

export async function persistRuntimeHarness(
  session: RuntimeSession,
  putArtifact: (sessionId: string, content: string | Uint8Array) => Promise<string>,
  emit: RuntimeEventEmitter
): Promise<void> {
  const harness = session.durable.frozenHarness;
  if (!harness) {
    throw Object.assign(new Error("A new session is missing its compiled Harness."), {
      code: "compiled_harness_missing"
    });
  }
  const payload = await stageRuntimeHarnessArtifact(
    session.identity.sessionId,
    harness,
    putArtifact
  );
  await emit(session, "harness.compiled", "runtime", payload);
}

export async function stageRuntimeHarnessArtifact(
  sessionId: string,
  harness: FrozenHarnessBuild,
  putArtifact: (sessionId: string, content: string | Uint8Array) => Promise<string>
): Promise<AgentEventPayloadMap["harness.compiled"]> {
  const artifactId = await putArtifact(sessionId, harness.canonicalJson);
  if (artifactId !== harness.digest) {
    throw new Error("Harness artifact store returned a non-content-addressed identifier.");
  }
  return {
    schemaVersion: harness.schemaVersion,
    compilerVersion: harness.compilerVersion,
    digest: harness.digest,
    artifactId,
    policyPackIds: [...harness.policyPackIds],
    initialToolCount: harness.toolPolicy.initialTools.length,
    potentialToolCount: harness.toolPolicy.potentialTools.length
  };
}

function assertHarnessSubject(
  restored: FrozenHarnessBuild,
  current: FrozenHarnessBuild
): void {
  const fields = [
    "provider", "model", "reasoningEffort", "modelRole", "runMode",
    "modelCapabilitiesDigest", "profileId", "profileDigest"
  ] as const;
  const mismatch = fields.find((field) => restored.subject[field] !== current.subject[field]);
  if (mismatch) {
    throw Object.assign(new Error(
      `Frozen Harness subject no longer matches the runtime (${mismatch}).`
    ), { code: "harness_subject_mismatch", field: mismatch });
  }
}

export function installRuntimeHarnessContext(
  session: RuntimeSession,
  environment: RuntimeEnvironment | undefined,
  harness: FrozenHarnessBuild
): void {
  const replacedIds = new Set(["system:behavior", "runtime:environment"]);
  const replacement = baseContext(environment, harness);
  session.interaction.contextItems = [
    ...replacement,
    ...session.interaction.contextItems.filter((item) => !replacedIds.has(item.id))
  ];
  for (const item of replacement) session.interaction.loadedContextIds.add(item.id);
}

/** Restore the exact digest-bound Harness for new-schema sessions. Sessions
 * created before the compiler marker retain their read-only legacy prompt. */
export async function restoreRuntimeHarness(
  session: RuntimeSession,
  artifacts: ContentAddressedArtifactStore,
  options: RuntimeOptions
): Promise<boolean> {
  const reference = session.durable.state.frozenHarness;
  if (!reference) {
    if (session.durable.state.harnessRequired) {
      throw Object.assign(new Error(
        `Session '${session.identity.sessionId}' requires a frozen Harness artifact.`
      ), { code: "compiled_harness_missing" });
    }
    // Pre-compiler sessions may be inspected and migrated, but must not regain
    // mutation authority without a digest-bound build.
    delete session.durable.frozenHarness;
    session.durable.legacyHarnessReadOnly = true;
    session.durable.mode = "analyze";
    session.durable.state = { ...session.durable.state, mode: "analyze" };
    return false;
  }
  let artifact: Buffer;
  try {
    artifact = await artifacts.get(session.identity.sessionId, reference.artifactId);
  } catch (error) {
    throw Object.assign(new Error("Frozen Harness artifact could not be restored.", {
      cause: error
    }), { code: "compiled_harness_unavailable" });
  }
  const restored = restoreHarnessBuild(artifact.toString("utf8"), reference.digest);
  const current = compileRuntimeHarness(
    options,
    session.services.gateway,
    session.services.modelRole,
    session.durable.mode,
    session.services.profile
  );
  assertHarnessSubject(restored, current);
  session.durable.frozenHarness = restored;
  delete session.durable.legacyHarnessReadOnly;
  installRuntimeHarnessContext(session, options.runtimeEnvironment, restored);
  return true;
}

export { HARNESS_COMPILER_VERSION };
