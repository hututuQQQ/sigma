import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE_ASSURANCE,
  DEFAULT_PROFILE_BUDGET,
  type ResolvedAgentProfile
} from "../packages/agent-extensions/src/index.js";
import type {
  ModelCapabilities,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolDefinition,
  ToolReceipt
} from "../packages/agent-protocol/src/index.js";
import {
  ContentAddressedArtifactStore,
  SegmentedJsonlStore
} from "../packages/agent-store/src/index.js";
import {
  compileHarnessBuild,
  restoreHarnessBuild,
  SUPPORTED_HARNESS_COMPILER_VERSIONS
} from "../packages/agent-runtime/src/harness-compiler.js";
import { createRuntime } from "../packages/agent-runtime/src/testing.js";
import { hydrateRuntimeSession } from "../packages/agent-runtime/src/runtime-session-restore.js";
import { restoreRuntimeCustomization } from "../packages/agent-runtime/src/runtime-customization-restore.js";
import {
  compileRuntimeHarness,
  restoreRuntimeHarness
} from "../packages/agent-runtime/src/runtime-harness.js";
import { baseContext } from "../packages/agent-runtime/src/runtime-context.js";
import { modelTools } from "../packages/agent-runtime/src/effect-helpers.js";
import { withReadBatchDescriptor } from "../packages/agent-runtime/src/read-batch-tool.js";
import { beginNextRun } from "../packages/agent-runtime/src/run-transitions.js";
import {
  EffectToolRegistry,
  registerBuiltinTools
} from "../packages/agent-tools/src/index.js";
import { createApprovingReviewer } from "./helpers/approving-reviewer.js";

const capabilities: ModelCapabilities = {
  contextWindowTokens: 200_000,
  maxOutputTokens: 32_000,
  tools: true,
  parallelTools: true,
  reasoning: true,
  structuredOutput: false,
  promptCache: true,
  tokenizer: "exact",
  requiresToolCallReasoningReplay: true
};

class HarnessGateway implements ModelGateway {
  readonly provider = "openai-codex";
  readonly model = "gpt-5.6-sol";
  readonly capabilities = capabilities;
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: Array<Pick<ModelResponse, "message" | "finishReason">>) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("No fake Harness response remains.");
    return {
      ...response,
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        reasoningTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        providerReported: true,
        costMicroUsd: 100,
        latencyMs: 1,
        retryAttempt: 0
      }
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const response = await this.complete(request);
    yield { type: "done", response };
  }

  async countTokens(messages: ModelMessage[], tools: ModelToolDefinition[] = []): Promise<number> {
    return Math.ceil(JSON.stringify({ messages, tools }).length / 4);
  }
}

function standardProfile(): ResolvedAgentProfile {
  return {
    id: "standard",
    roleRoutes: {},
    toolAllow: null,
    toolDeny: [],
    skills: [],
    hooks: [],
    permissionMode: "auto",
    budget: { ...DEFAULT_PROFILE_BUDGET },
    mutationPolicy: {
      requirePlanBeforeMutation: false,
      checkpointBeforeMutation: true,
      reviewMode: "required"
    },
    assurancePolicy: { ...DEFAULT_PROFILE_ASSURANCE },
    allowedChildProfiles: []
  };
}

function compilerInput(model = "gpt-5.6-sol") {
  return {
    provider: "openai-codex",
    model,
    reasoningEffort: "max" as const,
    modelRole: "orchestrator" as const,
    runMode: "change" as const,
    modelCapabilities: capabilities,
    runtimeCapabilities: {
      tools: [
        "read", "list", "grep", "shell", "apply_patch", "write", "edit",
        "request_user_input", "report_blocked"
      ].map((name) => ({ name, source: "builtin" as const })),
      executionMode: "container" as const,
      writeScope: "enclosing-container" as const,
      managedEnvironment: true,
      network: "full" as const,
      interactiveApprovals: false
    },
    resolvedAgentProfile: standardProfile()
  };
}

describe("flagship Harness compiler", () => {
  it("ships one policy for every model while retaining model identity in the digest", () => {
    const sol = compileHarnessBuild(compilerInput());
    const another = compileHarnessBuild(compilerInput("another-frontier-model"));
    const lowerReasoning = compileHarnessBuild({
      ...compilerInput("another-frontier-model"),
      reasoningEffort: "low"
    });
    expect(sol.digest).not.toBe(another.digest);
    expect(another.digest).not.toBe(lowerReasoning.digest);
    expect(sol.promptPolicy).toEqual(another.promptPolicy);
    expect(sol.toolPolicy).toEqual(another.toolPolicy);
    expect(sol.contextPolicy).toEqual(another.contextPolicy);
    expect(another.promptPolicy).toEqual(lowerReasoning.promptPolicy);
    expect(another.toolPolicy).toEqual(lowerReasoning.toolPolicy);
    expect(another.contextPolicy).toEqual(lowerReasoning.contextPolicy);
    expect(sol.policyPackIds).toEqual([
      "sigma.safety.v1", "sigma.profile.v1", "sigma.flagship.v1"
    ]);
    expect(sol.assurancePolicy).toMatchObject({
      reviewMode: "required",
      resourcePolicy: { strategistMode: "on_demand" },
      automaticDelegation: false
    });
    expect(sol.toolPolicy.initialTools).toContain("apply_patch");
    expect(sol.toolPolicy.initialTools).not.toContain("write");
    expect(sol.contextPolicy).toMatchObject({
      historyTokenLimit: 70_000,
      rawHistoryBlockTokenLimit: 24_000,
      maximumRawHistoryBlocks: 32,
      historySummaryTokenLimit: 8_000,
      protectedRecentToolResultTokens: 24_000,
      minimumToolResultPruneTokens: 8_000
    });
  });

  it("keeps foreground execution available when the runtime has exec but no shell", () => {
    const base = compilerInput("another-frontier-model");
    const build = compileHarnessBuild({
      ...base,
      runtimeCapabilities: {
        ...base.runtimeCapabilities,
        tools: [
          "read", "list", "grep", "exec", "apply_patch", "request_user_input",
          "report_blocked"
        ].map((name) => ({ name, source: "builtin" as const }))
      }
    });

    expect(build.promptPolicy.variant).toBe("flagship");
    expect(build.toolPolicy.initialTools).toContain("exec");
    expect(build.toolPolicy.initialTools).not.toContain("shell");
  });

  it("rejects evaluator/task fields and restores only the canonical digest-bound build", () => {
    expect(() => compileHarnessBuild({
      ...compilerInput(),
      taskId: "forbidden"
    } as Parameters<typeof compileHarnessBuild>[0])).toThrow(/forbidden fields/u);
    const build = compileHarnessBuild(compilerInput());
    const restored = restoreHarnessBuild(build.canonicalJson, build.digest);
    expect(restored).toEqual(build);
    expect(Object.isFrozen(restored.toolPolicy.bundles)).toBe(true);
    expect(() => restoreHarnessBuild(`${build.canonicalJson} `, build.digest))
      .toThrow(/digest/u);
    expect(SUPPORTED_HARNESS_COMPILER_VERSIONS).toContain(build.compilerVersion);
    const unsupported = JSON.parse(build.canonicalJson) as Record<string, unknown>;
    unsupported.compilerVersion = "999.0.0";
    const unsupportedJson = JSON.stringify(unsupported);
    expect(() => restoreHarnessBuild(
      unsupportedJson,
      createHash("sha256").update(unsupportedJson).digest("hex")
    )).toThrow(/unsupported/u);
  });

  it("recompiles and durably binds the Harness before a terminal session changes mode", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-harness-mode-"));
    const registry = registerBuiltinTools(new EffectToolRegistry());
    const gateway = new HarnessGateway([
      { message: { role: "assistant", content: "Analysis complete." }, finishReason: "stop" },
      { message: { role: "assistant", content: "Change run complete." }, finishReason: "stop" }
    ]);
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtimeOptions = {
      gateway,
      store,
      storeRootDir,
      tools: registry,
      builtinToolNames: registry.descriptors().map((tool) => tool.name),
      reasoningEffort: "max",
      permissionMode: "auto",
      reviewer: createApprovingReviewer()
    } as const;
    const runtime = createRuntime(runtimeOptions);
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({
      type: "submit", sessionId: session.sessionId, text: "Inspect the workspace."
    });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed" });
    expect(gateway.requests[0]!.tools!.map((tool) => tool.name)).not.toContain("apply_patch");

    const appendBatch = store.appendBatch.bind(store);
    let failTransition = true;
    store.appendBatch = async (events, expectedSeq) => {
      if (failTransition && events.some((event) => event.type === "run.started"
        && typeof event.payload === "object" && event.payload !== null
        && "harness" in event.payload)) {
        failTransition = false;
        throw new Error("injected Harness transition persistence failure");
      }
      return await appendBatch(events, expectedSeq);
    };
    await expect(runtime.command({
      type: "submit",
      sessionId: session.sessionId,
      text: "This transition must roll back.",
      mode: "change"
    })).rejects.toThrow(/transition persistence failure/u);
    expect(gateway.requests).toHaveLength(1);

    await runtime.command({
      type: "submit",
      sessionId: session.sessionId,
      text: "Now make an in-scope change if one is needed.",
      mode: "change"
    });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed" });
    expect(gateway.requests[1]!.tools!.map((tool) => tool.name)).toContain("apply_patch");

    const events = [];
    for await (const event of store.events(session.sessionId)) events.push(event);
    const compiled = events.filter((event) => event.type === "harness.compiled");
    expect(compiled).toHaveLength(2);
    const firstDigest = (compiled[0]!.payload as { digest: string }).digest;
    const secondDigest = (compiled[1]!.payload as { digest: string }).digest;
    expect(secondDigest).not.toBe(firstDigest);
    expect(events).toContainEqual(expect.objectContaining({
      type: "run.started",
      payload: expect.objectContaining({
        mode: "change",
        harness: expect.objectContaining({ digest: secondDigest, artifactId: secondDigest })
      })
    }));

    const hydrated = await hydrateRuntimeSession(store, session.sessionId, undefined, { gateway });
    const artifacts = new ContentAddressedArtifactStore(storeRootDir);
    await restoreRuntimeCustomization(hydrated, artifacts, runtimeOptions);
    await expect(restoreRuntimeHarness(hydrated, artifacts, runtimeOptions)).resolves.toBe(true);
    expect(hydrated.durable.frozenHarness).toMatchObject({
      digest: secondDigest,
      subject: { runMode: "change" }
    });
  });

  it("persists one or more bundle activations and expands the next model turn only", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-harness-bundle-"));
    const registry = registerBuiltinTools(new EffectToolRegistry());
    const gateway = new HarnessGateway([
      {
        message: {
          role: "assistant",
          content: "",
          reasoningContent: "The filesystem and process bundles are relevant to the requested action.",
          toolCalls: [{
            id: "load-relevant-bundles",
            name: "load_tool_bundle",
            arguments: { bundleIds: ["filesystem", "process_environment"] }
          }]
        },
        finishReason: "tool_calls"
      },
      { message: { role: "assistant", content: "Bundle loaded." }, finishReason: "stop" }
    ]);
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtimeOptions = {
      gateway,
      store,
      storeRootDir,
      tools: registry,
      builtinToolNames: registry.descriptors().map((tool) => tool.name),
      reasoningEffort: "max",
      permissionMode: "auto",
      reviewer: createApprovingReviewer()
    } as const;
    const runtime = createRuntime(runtimeOptions);
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });
    await runtime.command({
      type: "submit",
      sessionId: session.sessionId,
      text: "Load the filesystem bundle."
    });
    const bundleOutcome = await runtime.waitForOutcome(session.sessionId);
    expect(bundleOutcome).toMatchObject({ kind: "completed" });
    const first = gateway.requests[0]!.tools!.map((tool) => tool.name);
    const second = gateway.requests[1]!.tools!.map((tool) => tool.name);
    expect(first).toContain("load_tool_bundle");
    expect(first).not.toContain("write");
    expect(second).toContain("write");
    expect(gateway.requests[0]!.tools!
      .find((tool) => tool.name === "load_tool_bundle")?.inputSchema)
      .toMatchObject({
        properties: {
          bundleId: expect.any(Object),
          bundleIds: expect.objectContaining({ minItems: 1, uniqueItems: true })
        },
        oneOf: [{ required: ["bundleId"] }, { required: ["bundleIds"] }]
      });
    const baselineTools = modelTools(withReadBatchDescriptor(
      registry.modelDescriptors?.() ?? registry.descriptors()
    ));
    const candidateToolTokens = Math.ceil(JSON.stringify(gateway.requests[0]!.tools).length / 4);
    const baselineToolTokens = Math.ceil(JSON.stringify(baselineTools).length / 4);
    expect(candidateToolTokens).toBeLessThanOrEqual(baselineToolTokens * 0.40);
    const compiled = compileRuntimeHarness(
      runtimeOptions,
      gateway,
      "orchestrator",
      "change"
    );
    const processBundleTools = compiled.toolPolicy.bundles
      .find((bundle) => bundle.id === "process_environment")?.tools ?? [];
    expect(processBundleTools.length).toBeGreaterThan(0);
    const firstShellProperties = gateway.requests[0]!.tools!
      .find((tool) => tool.name === "shell")?.inputSchema.properties ?? {};
    const secondShellProperties = gateway.requests[1]!.tools!
      .find((tool) => tool.name === "shell")?.inputSchema.properties ?? {};
    expect(Object.keys(secondShellProperties).length)
      .toBeGreaterThan(Object.keys(firstShellProperties).length);
    const candidateMandatory = baseContext(undefined, compiled)
      .reduce((total, item) => total + item.tokenCount, candidateToolTokens);
    const baselineMandatory = baseContext()
      .reduce((total, item) => total + item.tokenCount, baselineToolTokens);
    expect(candidateMandatory).toBeLessThanOrEqual(baselineMandatory * 0.60);
    const events = [];
    for await (const event of store.events(session.sessionId)) events.push(event);
    expect(events.some((event) => event.type === "harness.compiled")).toBe(true);
    expect(events.some((event) => event.type === "tool_bundle.loaded"
      && (event.payload as { bundleId?: string }).bundleId === "filesystem")).toBe(true);
    expect(events.some((event) => event.type === "tool_bundle.loaded"
      && (event.payload as { bundleId?: string }).bundleId === "process_environment")).toBe(true);
    const hydrated = await hydrateRuntimeSession(store, session.sessionId, undefined, {
      gateway
    });
    const artifacts = new ContentAddressedArtifactStore(storeRootDir);
    await restoreRuntimeCustomization(hydrated, artifacts, runtimeOptions);
    await expect(restoreRuntimeHarness(hydrated, artifacts, runtimeOptions)).resolves.toBe(true);
    expect(hydrated.durable.frozenHarness?.digest).toBe(
      (events.find((event) => event.type === "harness.compiled")?.payload as { digest?: string }).digest
    );
    expect(hydrated.durable.state.loadedToolBundles).toContain("filesystem");
    expect(hydrated.durable.state.loadedToolBundles).toContain("process_environment");
    const harnessReference = hydrated.durable.state.frozenHarness;
    beginNextRun(hydrated, "change");
    expect(hydrated.durable.state.frozenHarness).toEqual(harnessReference);
    expect(hydrated.durable.state.loadedToolBundles).toContain("filesystem");
    expect(hydrated.durable.state.loadedToolBundles).toContain("process_environment");
    const missing = await hydrateRuntimeSession(store, session.sessionId, undefined, {
      gateway
    });
    await restoreRuntimeCustomization(missing, artifacts, runtimeOptions);
    delete missing.durable.state.frozenHarness;
    await expect(restoreRuntimeHarness(missing, artifacts, runtimeOptions)).rejects.toMatchObject({
      code: "compiled_harness_missing"
    });
    delete missing.durable.state.harnessRequired;
    delete missing.durable.frozenHarness;
    missing.durable.mode = "change";
    missing.durable.state = { ...missing.durable.state, mode: "change" };
    await expect(restoreRuntimeHarness(missing, artifacts, runtimeOptions)).resolves.toBe(false);
    expect(missing.durable.mode).toBe("analyze");
    expect(missing.durable.state.mode).toBe("analyze");
    beginNextRun(missing, "change");
    expect(missing.durable.mode).toBe("analyze");
  });

  it("rejects an unloaded built-in call at the same projection used for admission", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-harness-admission-"));
    const registry = registerBuiltinTools(new EffectToolRegistry());
    const gateway = new HarnessGateway([{
      message: {
        role: "assistant",
        content: "",
        reasoningContent: "Attempt the unavailable writer.",
        toolCalls: [{
          id: "forged-write",
          name: "write",
          arguments: { path: "forged.txt", content: "forged" }
        }]
      },
      finishReason: "tool_calls"
    }, {
      message: { role: "assistant", content: "The unavailable call was rejected." },
      finishReason: "stop"
    }]);
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway,
      store,
      storeRootDir,
      tools: registry,
      builtinToolNames: registry.descriptors().map((tool) => tool.name),
      reasoningEffort: "max",
      permissionMode: "auto",
      reviewer: createApprovingReviewer()
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "change" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Test admission." });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed" });
    const events = [];
    for await (const event of store.events(session.sessionId)) events.push(event);
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.failed",
      payload: expect.objectContaining({
        callId: "forged-write",
        diagnostics: expect.arrayContaining(["model_tool_policy_violation"])
      })
    }));
    await expect(import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(workspace, "forged.txt"), "utf8")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects shell parameters that were projected out of the offered schema", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-harness-schema-admission-"));
    const registry = registerBuiltinTools(new EffectToolRegistry());
    const gateway = new HarnessGateway([{
      message: {
        role: "assistant",
        content: "",
        reasoningContent: "Attempt a parameter that is available only after loading process controls.",
        toolCalls: [{
          id: "forged-shell-parameter",
          name: "shell",
          arguments: { command: "exit 0", network: "full" }
        }]
      },
      finishReason: "tool_calls"
    }, {
      message: { role: "assistant", content: "The hidden parameter was rejected." },
      finishReason: "stop"
    }]);
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway,
      store,
      storeRootDir,
      tools: registry,
      builtinToolNames: registry.descriptors().map((tool) => tool.name),
      reasoningEffort: "max",
      permissionMode: "auto",
      reviewer: createApprovingReviewer()
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Test schema admission." });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed" });
    const events = [];
    for await (const event of store.events(session.sessionId)) events.push(event);
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.failed",
      payload: expect.objectContaining({
        callId: "forged-shell-parameter",
        diagnostics: expect.arrayContaining(["model_tool_policy_violation"])
      })
    }));
    expect(events.some((event) => event.type === "tool.started"
      && (event.payload as { callId?: string }).callId === "forged-shell-parameter")).toBe(false);
  });

  it("keeps full successful output durable while the model sees at most 8 KiB", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-harness-output-"));
    const registry = registerBuiltinTools(new EffectToolRegistry());
    const builtinToolNames = registry.descriptors().map((tool) => tool.name);
    const largeOutput = `${"head".repeat(3_000)}${"tail".repeat(3_000)}`;
    registry.register({
      descriptor: {
        name: "large_output",
        description: "Return a large generic diagnostic payload for projection testing.",
        inputSchema: { type: "object", additionalProperties: false },
        possibleEffects: ["filesystem.read"],
        maximumEffects: ["filesystem.read"],
        availableModes: ["analyze", "change"],
        executionMode: "parallel",
        resourceKeys: [],
        approval: "auto",
        idempotent: true,
        timeoutMs: 1_000
      },
      async execute(request): Promise<ToolReceipt> {
        const now = new Date().toISOString();
        return {
          callId: request.callId,
          ok: true,
          output: largeOutput,
          outcome: { status: "succeeded", output: largeOutput, diagnosticCodes: [] },
          observedEffects: ["filesystem.read"],
          actualEffects: ["filesystem.read"],
          artifacts: [],
          diagnostics: [],
          evidence: [],
          startedAt: now,
          completedAt: now
        };
      }
    });
    const gateway = new HarnessGateway([
      {
        message: {
          role: "assistant",
          content: "",
          reasoningContent: "The diagnostic output is required for the inspection.",
          toolCalls: [{ id: "large", name: "large_output", arguments: {} }]
        },
        finishReason: "tool_calls"
      },
      { message: { role: "assistant", content: "Observed." }, finishReason: "stop" }
    ]);
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway,
      store,
      storeRootDir,
      tools: registry,
      builtinToolNames,
      reasoningEffort: "max",
      permissionMode: "auto",
      reviewer: createApprovingReviewer()
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Inspect output." });
    const outputOutcome = await runtime.waitForOutcome(session.sessionId);
    expect(outputOutcome).toMatchObject({ kind: "completed" });
    const projected = gateway.requests[1]!.messages.find((message) => message.role === "tool")!;
    expect(Buffer.byteLength(projected.content, "utf8")).toBeLessThanOrEqual(8 * 1_024);
    expect(projected.content).toContain("model receipt projection omitted");
    let durable: Record<string, unknown> | undefined;
    for await (const event of store.events(session.sessionId)) {
      if (event.type === "tool.completed"
        && (event.payload as { callId?: string }).callId === "large") {
        durable = event.payload as Record<string, unknown>;
      }
    }
    expect(durable?.output).toBe(largeOutput);
    expect(Buffer.byteLength(String(durable?.modelOutput), "utf8")).toBeLessThanOrEqual(8 * 1_024);
    expect(durable?.artifactRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ sizeBytes: Buffer.byteLength(largeOutput, "utf8") })
    ]));
  });

  it("keeps full failed output durable while the model sees at most 12 KiB", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-harness-failed-output-"));
    const registry = registerBuiltinTools(new EffectToolRegistry());
    const builtinToolNames = registry.descriptors().map((tool) => tool.name);
    const largeOutput = `${"failure-head".repeat(1_500)}${"failure-tail".repeat(1_500)}`;
    registry.register({
      descriptor: {
        name: "large_failure",
        description: "Return a large failed diagnostic payload for projection testing.",
        inputSchema: { type: "object", additionalProperties: false },
        possibleEffects: ["filesystem.read"],
        maximumEffects: ["filesystem.read"],
        availableModes: ["analyze", "change"],
        executionMode: "parallel",
        resourceKeys: [],
        approval: "auto",
        idempotent: true,
        timeoutMs: 1_000
      },
      async execute(request): Promise<ToolReceipt> {
        const now = new Date().toISOString();
        return {
          callId: request.callId,
          ok: false,
          output: largeOutput,
          outcome: { status: "failed", output: largeOutput, diagnosticCodes: ["generic_failure"] },
          observedEffects: ["filesystem.read"],
          actualEffects: ["filesystem.read"],
          artifacts: [],
          diagnostics: ["generic_failure"],
          evidence: [],
          startedAt: now,
          completedAt: now
        };
      }
    });
    const gateway = new HarnessGateway([{
      message: {
        role: "assistant",
        content: "",
        reasoningContent: "Collect the diagnostic failure.",
        toolCalls: [{ id: "large-failure", name: "large_failure", arguments: {} }]
      },
      finishReason: "tool_calls"
    }, {
      message: { role: "assistant", content: "Observed the failure." },
      finishReason: "stop"
    }]);
    const storeRootDir = path.join(workspace, ".agent");
    const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
    const runtime = createRuntime({
      gateway,
      store,
      storeRootDir,
      tools: registry,
      builtinToolNames,
      reasoningEffort: "max",
      permissionMode: "auto",
      reviewer: createApprovingReviewer()
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Inspect failure output." });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed" });
    const projected = gateway.requests[1]!.messages.find((message) => message.role === "tool")!;
    expect(Buffer.byteLength(projected.content, "utf8")).toBeLessThanOrEqual(12 * 1_024);
    expect(projected.content).toContain("receipt output omitted");
    let durable: Record<string, unknown> | undefined;
    for await (const event of store.events(session.sessionId)) {
      if (event.type === "tool.failed"
        && (event.payload as { callId?: string }).callId === "large-failure") {
        durable = event.payload as Record<string, unknown>;
      }
    }
    expect(durable?.output).toBe(largeOutput);
    expect(durable?.modelOutput).toBeUndefined();
    expect(durable?.artifactRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ sizeBytes: Buffer.byteLength(largeOutput, "utf8") })
    ]));
  });
});
