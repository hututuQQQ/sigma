import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionBroker, ExecutionRequest, ExecutionResult } from "../packages/agent-execution/src/index.js";
import {
  defaultHookRoots,
  discoverHooks,
  freezeSessionCustomization,
  freezeWorkspaceHookTrust,
  restoreSessionCustomization,
  workspaceCustomizationManifest,
  type HookDefinition,
  type HookRunnerPort
} from "../packages/agent-extensions/src/index.js";
import type { AgentEventEnvelope } from "../packages/agent-protocol/src/index.js";
import {
  BrokerCommandHookRunner,
  createRuntime,
  frozenHookExecutionRoot,
  FrozenWorkspaceHookMaterializer,
  persistFrozenWorkspaceHookAssets,
  RuntimeHookCoordinator
} from "../packages/agent-runtime/src/testing.js";
import { ContentAddressedArtifactStore, SegmentedJsonlStore, sessionDirectory } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";
import { fakeFinalTurn, fakeToolCall, fakeToolTurn, SmokeFakeGateway } from "../scripts/smoke-fake-model.mjs";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

function executionResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    state: "exited",
    exitCode: 0,
    signal: null,
    durationMs: 2,
    timedOut: false,
    idleTimedOut: false,
    cancelled: false,
    stdout: '{"decision":"allow"}',
    stderr: "",
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
    outputTruncated: false,
    ...overrides
  };
}

function fakeBroker(result: ExecutionResult, requests: ExecutionRequest[]): ExecutionBroker {
  return {
    lostProcessHandles: [],
    connect: async () => { throw new Error("unused"); },
    doctor: async () => { throw new Error("unused"); },
    execute: async (request) => { requests.push(request); return result; },
    spawn: async () => { throw new Error("unused"); },
    poll: async () => { throw new Error("unused"); },
    write: async () => { throw new Error("unused"); },
    terminate: async () => { throw new Error("unused"); },
    close: async () => undefined
  };
}

function containedForTest(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

const commandHook: HookDefinition = {
  id: "policy",
  event: "pre_model",
  kind: "command",
  command: "policy-check",
  args: ["--json"],
  required: true,
  timeoutMs: 1_000
};

describe("broker command hook runner", () => {
  it("uses a required read-only, no-network, secret-free broker request", async () => {
    const requests: ExecutionRequest[] = [];
    const workspace = path.resolve("fixture-workspace");
    const runner = new BrokerCommandHookRunner(
      fakeBroker(executionResult(), requests), workspace, undefined, { SIGMA_API_KEY: "known-secret" }
    );
    await expect(runner.run({
      hook: commandHook,
      event: "pre_model",
      input: { turnId: 1, apiKey: "known-secret", note: "value known-secret" },
      policy: { readOnly: true, network: "none", secrets: "stripped", maxOutputBytes: 4_096 }
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      output: { decision: "allow" }
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      command: {
        executable: "policy-check",
        args: ["--json"],
        cwd: workspace
      },
      policy: {
        sandbox: "required",
        network: "none",
        readRoots: [workspace],
        writeRoots: []
      },
      maxOutputBytes: 4_096
    });
    expect(requests[0]?.command.environment).toBeUndefined();
    expect(requests[0]?.command.stdin).toBe(
      '{"event":"pre_model","input":{"turnId":1,"apiKey":"[REDACTED]","note":"value [REDACTED:SIGMA_API_KEY]"}}\n'
    );
  });

  it("fails closed on non-zero exit, truncation, invalid JSON, and missing profile runners", async () => {
    const request = {
      hook: commandHook,
      event: "pre_model" as const,
      input: {},
      policy: { readOnly: true as const, network: "none" as const, secrets: "stripped" as const, maxOutputBytes: 128 }
    };
    const truncated = new BrokerCommandHookRunner(fakeBroker(executionResult({ outputTruncated: true }), []), process.cwd());
    await expect(truncated.run(request, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: "Hook output was truncated." });
    const nonzero = new BrokerCommandHookRunner(fakeBroker(executionResult({ exitCode: 2, stderr: "policy failed" }), []), process.cwd());
    await expect(nonzero.run(request, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: "Hook command failed: policy failed" });
    const invalid = new BrokerCommandHookRunner(fakeBroker(executionResult({ stdout: "not-json" }), []), process.cwd());
    await expect(invalid.run(request, new AbortController().signal)).resolves.toMatchObject({ ok: false });
    await expect(invalid.run({
      ...request,
      hook: { ...commandHook, kind: "agent_profile", profileId: "audit", prompt: "review" }
    }, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("No read-only agent-profile") });
  });

  it("grants read-only sandbox access to explicitly configured absolute home hook assets", async () => {
    const homeHooks = await mkdtemp(path.join(os.tmpdir(), "sigma-home-hook-runner-"));
    try {
      const script = path.join(homeHooks, "policy.mjs");
      await writeFile(script, "process.stdout.write('{}');\n", "utf8");
      const requests: ExecutionRequest[] = [];
      const runner = new BrokerCommandHookRunner(fakeBroker(executionResult(), requests), process.cwd());
      await runner.run({
        hook: { ...commandHook, command: process.execPath, args: [script] },
        event: "pre_model",
        input: {},
        policy: { readOnly: true, network: "none", secrets: "stripped", maxOutputBytes: 4_096 }
      }, new AbortController().signal);
      expect(requests[0]?.policy.readRoots).toEqual(expect.arrayContaining([
        path.resolve(process.cwd()),
        path.dirname(path.resolve(process.execPath)),
        homeHooks
      ]));
      expect(requests[0]?.policy.writeRoots).toEqual([]);
      expect(requests[0]?.policy.network).toBe("none");
    } finally {
      await rm(homeHooks, { recursive: true, force: true });
    }
  });

  it("allows only the configured frozen hook root as an out-of-workspace cwd", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-frozen-hook-runner-"));
    try {
      const workspace = path.join(root, "workspace");
      const frozenRoot = path.join(root, "hook-executions");
      const invocationRoot = path.join(frozenRoot, "a".repeat(64), "invoke-ABC123");
      const cwd = path.join(invocationRoot, "scripts");
      await mkdir(workspace);
      await mkdir(cwd, { recursive: true });
      const script = path.join(cwd, "policy.mjs");
      await writeFile(script, "process.stdout.write('{}');\n");
      const requests: ExecutionRequest[] = [];
      const runner = new BrokerCommandHookRunner(
        fakeBroker(executionResult(), requests), workspace, undefined, {}, undefined, frozenRoot
      );
      await expect(runner.run({
        hook: { ...commandHook, command: process.execPath, args: [script], cwd },
        event: "pre_model",
        input: {},
        policy: { readOnly: true, network: "none", secrets: "stripped", maxOutputBytes: 4_096 }
      }, new AbortController().signal)).resolves.toMatchObject({ ok: true });
      expect(requests[0]).toMatchObject({
        command: { cwd },
        policy: {
          network: "none",
          writeRoots: [],
          protectedPaths: expect.arrayContaining([invocationRoot]),
          readRoots: expect.arrayContaining([workspace, cwd, invocationRoot])
        }
      });
      for (const protectedPath of requests[0]!.policy.protectedPaths) {
        expect(requests[0]!.policy.readRoots.some((readRoot) => containedForTest(readRoot, protectedPath))).toBe(true);
      }
      await expect(runner.run({
        hook: { ...commandHook, cwd: path.join(root, "untrusted") },
        event: "pre_model",
        input: {},
        policy: { readOnly: true, network: "none", secrets: "stripped", maxOutputBytes: 4_096 }
      }, new AbortController().signal)).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("escapes the workspace")
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runtime hook coordinator", () => {
  it("executes resume-frozen workspace assets when the live source is replaced after verification", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-frozen-hook-race-"));
    const workspace = path.join(root, "workspace");
    const state = path.join(root, "state");
    const hookRoot = defaultHookRoots(path.join(root, "home"), workspace)[1]!;
    const liveDependency = path.join(workspace, "scripts", "lib", "decision.mjs");
    try {
      await mkdir(path.join(workspace, "scripts", "lib"), { recursive: true });
      await mkdir(path.join(workspace, "policy"), { recursive: true });
      await mkdir(hookRoot.directory, { recursive: true });
      await writeFile(path.join(workspace, "scripts", "main.mjs"),
        'import { decision } from "./lib/decision.mjs"; export default decision;\n');
      await writeFile(liveDependency, 'export const decision = "ORIGINAL";\n', { mode: 0o744 });
      if (process.platform !== "win32") await chmod(liveDependency, 0o744);
      await writeFile(path.join(workspace, "policy", "data.json"), '{"source":"FROZEN"}\n');
      await writeFile(path.join(workspace, "ordinary-input.txt"), "workspace input\n");
      await writeFile(path.join(hookRoot.directory, "policy.toml"), `
id = "policy"
event = "pre_model"
kind = "command"
command = "node"
args = ["scripts/main.mjs", "policy/data.json"]
trust_paths = ["scripts", "policy/data.json"]
required = true
timeout_ms = 5000
`);
      const [discovered] = await discoverHooks([hookRoot]);
      const customization = await freezeSessionCustomization({
        hooks: [discovered!.definition],
        hookArtifacts: [{
          definition: discovered!.definition,
          source: "workspace",
          digest: discovered!.digest,
          trust: freezeWorkspaceHookTrust(workspaceCustomizationManifest(workspace))
        }]
      });
      const artifacts = new ContentAddressedArtifactStore(state);
      const sessionId = "resume-frozen-hook";
      await persistFrozenWorkspaceHookAssets(
        workspace, sessionId, customization,
        async (id, content) => await artifacts.put(id, content)
      );
      const customizationId = await artifacts.put(sessionId, customization.canonicalJson);
      const resumed = restoreSessionCustomization(
        (await artifacts.get(sessionId, customizationId)).toString("utf8"), customization.digest
      );
      const materializer = new FrozenWorkspaceHookMaterializer(state, artifacts);
      const session = runtimeSessionFixture({
        sessionId,
        runId: "run",
        workspacePath: workspace,
        durable: { frozenCustomization: resumed }
      });
      let executions = 0;
      const runner: HookRunnerPort = {
        run: async (request) => {
          executions += 1;
          // Deterministically opens the old TOCTOU window after live trust verification.
          await writeFile(liveDependency, 'export const decision = "MALICIOUS";\n');
          expect(request.hook.kind).toBe("command");
          if (request.hook.kind !== "command") throw new Error("expected command hook");
          const frozenEntry = request.hook.args[0]!;
          expect(frozenEntry.startsWith(workspace)).toBe(false);
          expect(request.hook.cwd).toBe(workspace);
          expect((await readFile(path.join(request.hook.cwd!, "ordinary-input.txt"), "utf8"))).toBe("workspace input\n");
          const imported = await import(`${pathToFileURL(frozenEntry).href}?race=${randomUUID()}`) as { default: string };
          expect(imported.default).toBe("ORIGINAL");
          expect(JSON.parse(await readFile(request.hook.args[1]!, "utf8")))
            .toEqual({ source: "FROZEN" });
          const frozenMode = (await stat(path.join(path.dirname(frozenEntry), "lib", "decision.mjs"))).mode & 0o777;
          const trustedMode = resumed.hooks[0]!.trust!.files.find((file) =>
            file.relativePath === "scripts/lib/decision.mjs")!.mode;
          if (process.platform !== "win32") expect(frozenMode).toBe(trustedMode);
          return { ok: true, output: { decision: "allow" }, durationMs: 1 };
        }
      };
      const coordinator = new RuntimeHookCoordinator({
        definitions: [],
        runner,
        materializeWorkspaceHook: async (current, hook) =>
          await materializer.materialize(current.identity.workspacePath, current.identity.sessionId, hook),
        emit: async (current) => {
          current.durable.seq += 1;
          return { seq: current.durable.seq } as AgentEventEnvelope;
        }
      });
      await expect(coordinator.dispatch(session, "pre_model", {}, new AbortController().signal))
        .resolves.toMatchObject({ allowed: true });
      expect(executions).toBe(1);
      await expect(coordinator.dispatch(session, "pre_model", {}, new AbortController().signal))
        .rejects.toMatchObject({ outcome: expect.objectContaining({ status: "failed" }) });
      expect(executions).toBe(1);
      await writeFile(liveDependency, 'export const decision = "ORIGINAL";\n', { mode: 0o744 });
      if (process.platform !== "win32") await chmod(liveDependency, 0o744);
      await rm(liveDependency);
      await expect(coordinator.dispatch(session, "pre_model", {}, new AbortController().signal))
        .rejects.toMatchObject({ outcome: expect.objectContaining({ status: "failed" }) });
      expect(executions).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a durable frozen hook CAS object is corrupt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-frozen-hook-cas-"));
    const workspace = path.join(root, "workspace");
    const state = path.join(root, "state");
    const hookRoot = defaultHookRoots(path.join(root, "home"), workspace)[1]!;
    try {
      await mkdir(path.join(workspace, "scripts"), { recursive: true });
      await mkdir(hookRoot.directory, { recursive: true });
      await writeFile(path.join(workspace, "scripts", "policy.mjs"), "export default 'trusted';\n");
      await writeFile(path.join(hookRoot.directory, "policy.toml"), `
id = "policy"
event = "pre_model"
kind = "command"
command = "node"
args = ["scripts/policy.mjs"]
trust_paths = ["scripts/policy.mjs"]
required = true
`);
      const [discovered] = await discoverHooks([hookRoot]);
      const frozen = await freezeSessionCustomization({
        hooks: [discovered!.definition],
        hookArtifacts: [{
          definition: discovered!.definition,
          source: "workspace",
          digest: discovered!.digest,
          trust: freezeWorkspaceHookTrust(workspaceCustomizationManifest(workspace))
        }]
      });
      const artifacts = new ContentAddressedArtifactStore(state);
      const sessionId = "corrupt-frozen-hook";
      await persistFrozenWorkspaceHookAssets(workspace, sessionId, frozen,
        async (id, content) => await artifacts.put(id, content));
      const asset = frozen.hooks[0]!.trust!.files.find((file) => file.relativePath === "scripts/policy.mjs")!;
      await writeFile(path.join(sessionDirectory(state, sessionId), "artifacts", asset.digest), "corrupt");
      const materializer = new FrozenWorkspaceHookMaterializer(state, artifacts);
      await expect(materializer.materialize(workspace, sessionId, frozen.hooks[0]!))
        .rejects.toThrow("Artifact CAS object");
      const executionRoot = frozenHookExecutionRoot(state);
      await rm(executionRoot, { recursive: true, force: true });
      await writeFile(executionRoot, "precreated collision");
      await expect(materializer.materialize(workspace, sessionId, frozen.hooks[0]!)).rejects.toThrow();
      if (process.platform !== "win32") {
        await rm(executionRoot, { force: true });
        const outside = path.join(root, "outside");
        await mkdir(outside);
        await symlink(outside, executionRoot, "dir");
        await expect(materializer.materialize(workspace, sessionId, frozen.hooks[0]!))
          .rejects.toThrow("not a protected directory");
        await rm(executionRoot, { force: true });
        await mkdir(executionRoot, { mode: 0o777 });
        await chmod(executionRoot, 0o777);
        await expect(materializer.materialize(workspace, sessionId, frozen.hooks[0]!))
          .rejects.toThrow("grants access outside");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists lifecycle events and durable provenance for pre-model context", async () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    const session = runtimeSessionFixture({ workspacePath: process.cwd() });
    const runner: HookRunnerPort = {
      run: vi.fn(async () => ({
        ok: true,
        output: { decision: "allow", context: ["policy supplied context"] },
        durationMs: 3
      }))
    };
    const coordinator = new RuntimeHookCoordinator({
      definitions: [commandHook],
      runner,
      emit: async (current, type, _authority, payload) => {
        events.push({ type, payload });
        current.durable.seq += 1;
        return { seq: current.durable.seq } as AgentEventEnvelope;
      }
    });
    const dispatch = await coordinator.dispatch(session, "pre_model", { turnId: 1 }, new AbortController().signal);
    expect(events.map((event) => event.type)).toEqual(["hook.started", "hook.completed", "diagnostic"]);
    expect(dispatch.contextItems).toEqual([expect.objectContaining({
      content: "policy supplied context",
      provenance: "hook:policy:pre_model"
    })]);
    expect(session.interaction.contextItems).toEqual([]);
    expect(events[2]?.payload).toMatchObject({ kind: "hook_context_added", items: dispatch.contextItems });
  });

  it("persists failed gates and rejects recursive events", async () => {
    const eventTypes: string[] = [];
    const session = runtimeSessionFixture({ sessionId: "session-recursive" });
    const coordinatorRef: { current?: RuntimeHookCoordinator } = {};
    const runner: HookRunnerPort = {
      run: async () => {
        await coordinatorRef.current!.dispatch(session, "pre_model", {}, new AbortController().signal);
        return { ok: true, output: { decision: "allow" }, durationMs: 1 };
      }
    };
    const coordinator = new RuntimeHookCoordinator({
      definitions: [commandHook],
      runner,
      emit: async (current, type) => {
        eventTypes.push(type);
        current.durable.seq += 1;
        return { seq: current.durable.seq } as AgentEventEnvelope;
      }
    });
    coordinatorRef.current = coordinator;
    await expect(coordinator.dispatch(session, "pre_model", {}, new AbortController().signal)).rejects.toMatchObject({
      code: "hook_gate_denied",
      outcome: expect.objectContaining({ status: "failed", reason: expect.stringContaining("Recursive hook event") })
    });
    expect(eventTypes).toEqual(["hook.started", "hook.failed"]);
  });

  it("connects every lifecycle hook and injects pre-model context into the active turn", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-hooks-runtime-"));
    try {
      await writeFile(path.join(workspace, "input.txt"), "hello\n");
      const gateway = new SmokeFakeGateway([
        fakeToolTurn([fakeToolCall("probe-one", "evidence_probe", {})]),
        fakeFinalTurn("done")
      ]);
      const eventsSeen: string[] = [];
      const definitions = ([
        "session_start", "run_start", "pre_model", "post_model", "pre_tool",
        "post_tool", "plan_changed", "pre_complete", "run_end"
      ] as const).map((event) => ({
        ...commandHook,
        id: `hook-${event.replaceAll("_", "-")}`,
        event
      }));
      const runner: HookRunnerPort = {
        run: async (request) => {
          eventsSeen.push(request.event);
          return {
            ok: true,
            output: request.event.startsWith("pre_")
              ? { decision: "allow", ...(request.event === "pre_model" ? { context: ["durable policy context"] } : {}) }
              : {},
            durationMs: 1
          };
        }
      };
      const storeRootDir = path.join(workspace, ".runtime-store");
      const tools = registerBuiltinTools(new EffectToolRegistry());
      tools.register({
        descriptor: {
          name: "evidence_probe",
          description: "Produce generic read-only evidence.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          possibleEffects: ["filesystem.read"],
          executionMode: "parallel",
          resourceKeys: ["workspace:read"],
          approval: "auto",
          idempotent: true,
          timeoutMs: 1_000
        },
        execute: async (request, context) => ({
          callId: request.callId,
          ok: true,
          output: "probe passed",
          observedEffects: ["filesystem.read"],
          artifacts: [],
          diagnostics: [],
          evidence: [{
            evidenceId: randomUUID(),
            sessionId: context.sessionId,
            runId: context.runId,
            kind: "diagnostic",
            status: "passed",
            createdAt: new Date().toISOString(),
            producer: { authority: "tool", id: request.callId },
            summary: "Generic evidence probe passed.",
            data: { source: "evidence_probe", diagnostic: { passed: true } }
          }],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        })
      });
      const runtime = createRuntime({
        gateway,
        store: new SegmentedJsonlStore({ rootDir: storeRootDir }),
        storeRootDir,
        tools,
        permissionMode: "auto",
        hooks: definitions,
        hookRunner: runner,
        runDeadlineMs: 60_000
      });
      const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze", title: "inspect" });
      await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Inspect input.txt", mode: "analyze" });
      const outcome = await runtime.waitForOutcome(session.sessionId);
      expect(outcome).toMatchObject({ kind: "completed" });
      expect(new Set(eventsSeen)).toEqual(new Set([
        "session_start", "run_start", "pre_model", "post_model", "pre_tool",
        "post_tool", "plan_changed", "pre_complete", "run_end"
      ]));
      expect(gateway.requests[0]?.messages.some((message: { content: string }) =>
        message.content.includes("durable policy context"))).toBe(true);
      const durableTypes: string[] = [];
      for await (const event of runtime.sessionEvents(session.sessionId)) durableTypes.push(event.type);
      expect(durableTypes).toContain("hook.started");
      expect(durableTypes).toContain("hook.completed");
      expect(durableTypes).not.toContain("hook.failed");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
