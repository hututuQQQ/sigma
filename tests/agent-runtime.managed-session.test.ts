import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  ModelCapabilities,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolDefinition
} from "../packages/agent-protocol/src/index.js";
import type { ManagedSessionBindingV1 } from "../packages/agent-execution/src/index.js";
import { runtimeEnvironment, type ProcessExecutionPort } from "../packages/agent-platform/src/index.js";
import { createRuntime } from "../packages/agent-runtime/src/testing.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";

class BindingAwareGateway implements ModelGateway {
  readonly provider = "test";
  readonly model = "binding-aware";
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 16_000,
    maxOutputTokens: 2_000,
    tools: true,
    parallelTools: false,
    reasoning: false,
    structuredOutput: false,
    promptCache: false,
    tokenizer: "approximate"
  };

  constructor(private readonly isBound: () => boolean) {}

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    expect(this.isBound()).toBe(true);
    return {
      message: { role: "assistant", content: "Managed session is ready." },
      finishReason: "stop"
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const response = await this.complete(request);
    yield { type: "content", delta: response.message.content! };
    yield { type: "done", response };
  }

  async countTokens(messages: ModelMessage[], tools: ModelToolDefinition[] = []): Promise<number> {
    return JSON.stringify({ messages, tools }).length / 4;
  }
}

describe("runtime managed session lifecycle", () => {
  it("binds before the first model turn and releases scratch with the session", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-managed-runtime-"));
    const storeRootDir = path.join(workspace, ".agent");
    let bound = false;
    const bindManagedSession = vi.fn(async (request): Promise<ManagedSessionBindingV1> => {
      bound = true;
      return {
        ...request,
        bindingId: "binding-1",
        lifetime: "runtime_session",
        targetId: "target-1",
        targetStartedAt: "2026-07-22T00:00:00Z",
        targetAttestationDigest: `sha256:${"a".repeat(64)}`,
        protectedPathsDigest: `sha256:${"b".repeat(64)}`,
        runtimeClosure: {
          protocolVersion: 1,
          digest: `sha256:${"c".repeat(64)}`,
          complete: true,
          platform: process.platform,
          architecture: process.arch,
          executableSearchPathsDigest: `sha256:${"d".repeat(64)}`,
          runtimeCommandsDigest: `sha256:${"e".repeat(64)}`,
          targetAttestationDigest: `sha256:${"a".repeat(64)}`
        },
        scratchLease: {
          protocolVersion: 1,
          sessionId: request.sessionId,
          leaseId: "scratch-1",
          lifetime: "runtime_session",
          isolation: "private",
          persistentAcrossCalls: true,
          home: path.join(workspace, "scratch", "home"),
          temp: path.join(workspace, "scratch", "tmp")
        }
      };
    });
    const releaseScratchLease = vi.fn(async () => undefined);
    const execution: ProcessExecutionPort = {
      execute: async () => { throw new Error("No process should run in this test."); },
      bindManagedSession,
      releaseScratchLease
    };
    const runtime = createRuntime({
      gateway: new BindingAwareGateway(() => bound),
      store: new SegmentedJsonlStore({ rootDir: storeRootDir }),
      storeRootDir,
      tools: registerBuiltinTools(new EffectToolRegistry()),
      permissionMode: "auto",
      managedEnvironmentMode: "required",
      managedNetworkMode: "full",
      runtimeEnvironment: { ...runtimeEnvironment(), executionMode: "container" },
      execution,
      runDeadlineMs: 60_000
    });

    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    expect(bindManagedSession).toHaveBeenCalledTimes(1);
    await runtime.command({ type: "submit", sessionId: session.sessionId, text: "Report readiness." });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "completed" });
    await runtime.releaseSession(session.sessionId);
    expect(releaseScratchLease).toHaveBeenCalledWith(session.sessionId, { timeoutMs: 5_000 });
  });
});
