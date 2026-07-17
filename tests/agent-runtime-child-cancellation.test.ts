import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ModelCapabilities,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolDefinition,
  ToolReceipt,
  ToolRequest
} from "../packages/agent-protocol/src/index.js";
import { createChildAgentFactory, createRuntime } from "../packages/agent-runtime/src/testing.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { AgentSupervisor, WorkspaceIsolationManager } from "../packages/agent-supervisor/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";
import { createHostExecutionBroker } from "./helpers/host-execution-broker.js";
import { createApprovingReviewer } from "./helpers/approving-reviewer.js";
import { typedCompletion } from "./helpers/typed-evidence.js";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function toolTurn(id: string, name: string, argumentsValue: object): ModelResponse {
  return {
    message: { role: "assistant", content: "", toolCalls: [{ id, name, arguments: argumentsValue }] },
    finishReason: "tool_calls"
  };
}

function completion(): (request: ModelRequest) => ModelResponse {
  return (request) => typedCompletion(request, {
    id: "complete-second",
    summary: "Second writer completed after the cancelled writer settled.",
    criterion: "The second writer ran safely."
  });
}

type ScriptedResponse = ModelResponse | ((request: ModelRequest) => ModelResponse);

class ChildGateway implements ModelGateway {
  readonly provider = "test";
  readonly model = "child-cancellation";
  readonly capabilities: ModelCapabilities = {
    contextWindowTokens: 16_000,
    maxOutputTokens: 2_000,
    tools: true,
    parallelTools: true,
    reasoning: false,
    structuredOutput: false,
    promptCache: false,
    tokenizer: "approximate"
  };

  constructor(private readonly responses: ScriptedResponse[]) {}

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("The test consumes streaming responses.");
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const scripted = this.responses.shift();
    if (!scripted) throw new Error("No child response remains.");
    yield { type: "done", response: typeof scripted === "function" ? scripted(request) : scripted };
  }

  async countTokens(messages: ModelMessage[], tools: ModelToolDefinition[] = []): Promise<number> {
    return JSON.stringify({ messages, tools }).length / 4;
  }
}

function receipt(request: ToolRequest, output: string): ToolReceipt {
  const now = new Date().toISOString();
  return {
    callId: request.callId,
    ok: true,
    output,
    observedEffects: [],
    artifacts: [],
    diagnostics: [],
    startedAt: now,
    completedAt: now
  };
}

async function within<T>(promise: Promise<T>, timeoutMs = 3_000): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error("Timed out waiting for child state.")), timeoutMs))
  ]);
}

describe("child cancellation cleanup ordering", () => {
  it("holds an exclusive writer lease until an abort-ignoring tool actually settles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-child-cleanup-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const storeRootDir = path.join(workspace, ".agent");
    const slowStarted = deferred<void>();
    const slowRelease = deferred<ToolReceipt>();
    const execution = createHostExecutionBroker();
    const tools = registerBuiltinTools(new EffectToolRegistry(), { broker: execution });
    tools.register({
      descriptor: {
        name: "slow_writer",
        description: "A deliberately non-cooperative writer used to verify cancellation cleanup.",
        inputSchema: { type: "object" },
        possibleEffects: ["filesystem.write"],
        executionMode: "exclusive",
        resourceKeys: ["workspace"],
        writePathArguments: ["path"],
        approval: "auto",
        idempotent: false,
        timeoutMs: 10_000
      },
      async execute(request) {
        slowStarted.resolve();
        return await slowRelease.promise.then((value) => ({ ...value, callId: request.callId }));
      }
    });
    tools.register({
      descriptor: {
        name: "quick_observation",
        description: "Records that the second writer obtained the workspace.",
        inputSchema: { type: "object" },
        possibleEffects: ["filesystem.read"],
        executionMode: "parallel",
        resourceKeys: ["workspace"],
        approval: "auto",
        idempotent: true,
        timeoutMs: 2_000
      },
      async execute(request) { return receipt(request, "second writer observed workspace"); }
    });
    const runtime = createRuntime({
      gateway: new ChildGateway([
        toolTurn("slow-call", "slow_writer", { path: "first.txt" }),
        toolTurn("quick-call", "quick_observation", {}),
        completion()
      ]),
      store: new SegmentedJsonlStore({ rootDir: storeRootDir }),
      storeRootDir,
      tools,
      reviewer: createApprovingReviewer(),
      execution,
      permissionMode: "auto",
      runDeadlineMs: 60_000
    });
    const firstParent = await runtime.createSession({ workspacePath: workspace, mode: "change" });
    const secondParent = await runtime.createSession({ workspacePath: workspace, mode: "change" });
    const runChild = createChildAgentFactory(() => runtime);
    const started: string[] = [];
    const supervisor = new AgentSupervisor(async (context) => {
      started.push(context.childId);
      return await runChild(context);
    }, 2, new WorkspaceIsolationManager(path.join(root, "isolation"), { execution }));
    const first = supervisor.spawn({
      parentId: firstParent.sessionId,
      instruction: "run the slow writer",
      workspacePath: workspace,
      intent: "write",
      writeScope: ["first.txt"],
      metadata: { mode: "change" }
    });
    await within(slowStarted.promise);
    const second = supervisor.spawn({
      parentId: secondParent.sessionId,
      instruction: "observe the workspace",
      workspacePath: workspace,
      intent: "write",
      writeScope: ["second.txt"],
      metadata: { mode: "change" }
    });

    let parentCancellationSettled = false;
    const parentCancellation = supervisor.cancelParent(firstParent.sessionId, "cancel the first writer").then(() => {
      parentCancellationSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(started).toEqual([first.id]);
    expect(parentCancellationSettled).toBe(false);

    slowRelease.resolve(receipt({ callId: "ignored", name: "slow_writer", arguments: {} }, "settled after abort"));
    await within(parentCancellation);
    await expect(within(supervisor.join(first.id))).resolves.toMatchObject({ status: "cancelled" });
    await expect(within(supervisor.join(second.id))).resolves.toMatchObject({
      status: "completed",
      result: { outcome: { kind: "completed" } }
    });
    expect(started).toEqual([first.id, second.id]);
    await execution.close();
  });
});
