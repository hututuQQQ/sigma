import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CheckpointManager } from "../packages/agent-checkpoint/src/index.js";
import type {
  AgentEventEnvelope,
  ModelCapabilities,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolDefinition
} from "../packages/agent-protocol/src/index.js";
import { createRuntime } from "../packages/agent-runtime/src/testing.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry, registerBuiltinTools } from "../packages/agent-tools/src/index.js";

class ScriptedGateway implements ModelGateway {
  readonly provider = "test";
  readonly model = "live-checkpoint-failure";
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
  calls = 0;

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("The test consumes streaming responses.");
  }

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    const response = this.responses.shift();
    if (!response) throw new Error("No scripted response remains.");
    yield { type: "done", response };
  }

  async countTokens(messages: ModelMessage[], tools: ModelToolDefinition[] = []): Promise<number> {
    return JSON.stringify({ messages, tools }).length / 4;
  }
}

function toolTurn(toolCalls: NonNullable<ModelResponse["message"]["toolCalls"]>): ModelResponse {
  return { message: { role: "assistant", content: "", toolCalls }, finishReason: "tool_calls" };
}

async function events(store: SegmentedJsonlStore, sessionId: string): Promise<AgentEventEnvelope[]> {
  const result: AgentEventEnvelope[] = [];
  for await (const event of store.events(sessionId)) result.push(event);
  return result;
}

async function fixture(writeBeforeFailure: boolean): Promise<{
  workspace: string;
  store: SegmentedJsonlStore;
  manager: CheckpointManager;
  gateway: ScriptedGateway;
  runtime: ReturnType<typeof createRuntime>;
}> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-live-checkpoint-failure-"));
  await writeFile(path.join(workspace, "target.txt"), "before", "utf8");
  const storeRootDir = path.join(workspace, ".agent");
  const store = new SegmentedJsonlStore({ rootDir: storeRootDir });
  const gateway = new ScriptedGateway([
    toolTurn([
      { id: "failing-mutation", name: "failing_mutation", arguments: { path: "target.txt" } },
      {
        id: "same-turn-completion",
        name: "complete_task",
        arguments: {
          summary: "must not complete over an open checkpoint",
          criteria: [{
            criterion: "The mutation completed safely.",
            status: "met",
            evidence: [{ evidenceId: "invented", kind: "diagnostic" }]
          }]
        }
      }
    ]),
    toolTurn([{
      id: "clean-failure-observed",
      name: "request_user_input",
      arguments: { message: "The clean failure was recorded." }
    }])
  ]);
  const tools = registerBuiltinTools(new EffectToolRegistry());
  tools.register({
    descriptor: {
      name: "failing_mutation",
      description: "Fails after optionally changing its declared path.",
      inputSchema: { type: "object" },
      possibleEffects: ["filesystem.write"],
      executionMode: "exclusive",
      resourceKeys: ["workspace"],
      writePathArguments: ["path"],
      approval: "auto",
      idempotent: false,
      timeoutMs: 2_000
    },
    async execute() {
      if (writeBeforeFailure) await writeFile(path.join(workspace, "target.txt"), "partial", "utf8");
      throw Object.assign(new Error("injected mutation failure"), { code: "injected_mutation_failure" });
    }
  });
  return {
    workspace,
    store,
    manager: new CheckpointManager({ rootDir: storeRootDir }),
    gateway,
    runtime: createRuntime({
      gateway,
      store,
      storeRootDir,
      tools,
      permissionMode: "auto",
      runDeadlineMs: 10_000
    })
  };
}

describe("live mutation checkpoint failure recovery", () => {
  it("suspends immediately when a failed mutation leaves a workspace delta", async () => {
    const target = await fixture(true);
    const session = await target.runtime.createSession({ workspacePath: target.workspace, mode: "change" });
    await target.runtime.command({ type: "submit", sessionId: session.sessionId, text: "exercise a partial mutation" });

    await expect(target.runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({
      kind: "needs_input",
      requestId: expect.stringMatching(/^checkpoint:/u)
    });
    expect(target.gateway.calls).toBe(1);
    await expect(readFile(path.join(target.workspace, "target.txt"), "utf8")).resolves.toBe("partial");
    expect((await target.manager.list(session.sessionId)).at(-1)).toMatchObject({ status: "open" });
    const stored = await events(target.store, session.sessionId);
    expect(stored.some((event) => event.type === "tool.requested"
      && (event.payload as { callId?: string }).callId === "same-turn-completion")).toBe(false);
    expect(stored).toContainEqual(expect.objectContaining({
      type: "run.suspended",
      payload: expect.objectContaining({ requestId: expect.stringMatching(/^checkpoint:/u) })
    }));
  });

  it("seals a zero-delta checkpoint and continues after the failed tool receipt", async () => {
    const target = await fixture(false);
    const session = await target.runtime.createSession({ workspacePath: target.workspace, mode: "change" });
    await target.runtime.command({ type: "submit", sessionId: session.sessionId, text: "exercise a clean mutation failure" });

    await expect(target.runtime.waitForOutcome(session.sessionId)).resolves.toEqual({
      kind: "needs_input",
      requestId: "clean-failure-observed",
      message: "The clean failure was recorded."
    });
    expect(target.gateway.calls).toBe(2);
    await expect(readFile(path.join(target.workspace, "target.txt"), "utf8")).resolves.toBe("before");
    expect((await target.manager.list(session.sessionId)).at(-1)).toMatchObject({ status: "sealed" });
    const stored = await events(target.store, session.sessionId);
    expect(stored.some((event) => event.type === "checkpoint.sealed")).toBe(true);
    expect(stored.some((event) => event.type === "run.suspended"
      && String((event.payload as { requestId?: string }).requestId).startsWith("checkpoint:"))).toBe(false);
  });
});
