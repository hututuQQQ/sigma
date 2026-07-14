import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  JsonValue,
  ModelGateway,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ToolCallPlan,
  ToolDescriptor,
  ToolExecutionContext,
  ToolPreparationContext,
  ToolReceipt,
  ToolRequest
} from "../packages/agent-protocol/src/index.js";
import { createRuntime } from "../packages/agent-runtime/src/testing.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import {
  EffectToolRegistry,
  prepareToolCallPlan
} from "../packages/agent-tools/src/registry.js";
import { registerBuiltinTools } from "../packages/agent-tools/src/index.js";
import { executionArgs } from "../packages/agent-tools/src/execution-tool-values.js";
import { createApprovingReviewer } from "./helpers/approving-reviewer.js";

const readOnlyPlan: ToolCallPlan = {
  exactEffects: ["filesystem.read"],
  readPaths: [],
  writePaths: [],
  network: "none",
  processMode: "none",
  checkpointScope: [],
  idempotence: "read_only"
};

function descriptor(prepare = vi.fn(() => readOnlyPlan)): ToolDescriptor {
  return {
    name: "object_tool",
    description: "Accept one structured object.",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      additionalProperties: false
    },
    possibleEffects: ["filesystem.read"],
    executionMode: "parallel",
    resourceKeys: [],
    approval: "auto",
    idempotent: true,
    timeoutMs: 1_000,
    prepare
  };
}

const preparationContext: ToolPreparationContext = {
  sessionId: "arguments-session",
  runId: "arguments-run",
  workspacePath: process.cwd(),
  runMode: "analyze"
};

const executionContext: ToolExecutionContext = {
  ...preparationContext,
  signal: new AbortController().signal,
  heartbeat() {},
  async progress() {},
  async createArtifact() { return "artifact"; }
};

function successfulReceipt(request: ToolRequest): ToolReceipt {
  const now = new Date().toISOString();
  return {
    callId: request.callId,
    ok: true,
    output: "ok",
    observedEffects: ["filesystem.read"],
    artifacts: [],
    diagnostics: [],
    startedAt: now,
    completedAt: now
  };
}

function response(toolCall: NonNullable<ModelResponse["message"]["toolCalls"]>[number]): ModelResponse {
  return {
    message: { role: "assistant", content: "", toolCalls: [toolCall] },
    finishReason: "tool_calls",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      providerReported: true,
      costMicroUsd: 0,
      latencyMs: 1,
      retryAttempt: 0
    }
  };
}

class ArgumentContractGateway implements ModelGateway {
  readonly provider = "fixture";
  readonly model = "argument-contract";
  readonly capabilities = {
    contextWindowTokens: 32_000,
    maxOutputTokens: 4_096,
    tools: true,
    parallelTools: true,
    reasoning: false,
    structuredOutput: false,
    promptCache: false,
    tokenizer: "approximate" as const
  };
  readonly requests: ModelRequest[] = [];
  private readonly responses = [
    response({
      id: "encoded-read",
      name: "read",
      arguments: JSON.stringify({ path: "input.txt" })
    }),
    response({ id: "direct-read", name: "read", arguments: { path: "input.txt" } }),
    response({
      id: "finish-contract-check",
      name: "request_user_input",
      arguments: { message: "Argument contract checked." }
    })
  ];

  async complete(): Promise<ModelResponse> {
    throw new Error("Argument contract gateway is streaming-only.");
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const next = this.responses.shift();
    if (!next) throw new Error("Argument contract gateway exhausted its responses.");
    yield { type: "done", response: next };
  }

  async countTokens(): Promise<number> { return 1; }
}

describe("tool argument container contract", () => {
  it.each([
    ["a JSON-encoded object string", JSON.stringify({ value: "nested" })],
    ["an array", ["value"]],
    ["null", null]
  ] satisfies Array<[string, JsonValue]>)(
    "rejects %s before descriptor preparation",
    async (_label, argumentsValue) => {
      const prepare = vi.fn(() => readOnlyPlan);
      const tool = descriptor(prepare);

      await expect(prepareToolCallPlan(tool, argumentsValue, preparationContext)).rejects.toMatchObject({
        code: "tool_arguments_invalid"
      });
      await expect(prepareToolCallPlan(tool, argumentsValue, preparationContext)).rejects.toThrow(
        "must be passed directly as a JSON object"
      );
      expect(prepare).not.toHaveBeenCalled();
    }
  );

  it("enforces the same contract for direct registry execution", async () => {
    const execute = vi.fn(async (request: ToolRequest) => successfulReceipt(request));
    const registry = new EffectToolRegistry();
    registry.register({ descriptor: descriptor(), execute });

    await expect(registry.execute({
      callId: "encoded-call",
      name: "object_tool",
      arguments: JSON.stringify({ value: "nested" })
    }, executionContext)).rejects.toMatchObject({ code: "tool_arguments_invalid" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not reinterpret execution arguments as nested JSON", () => {
    const encoded = JSON.stringify({ executable: "node", args: [] });
    expect(() => executionArgs(encoded)).toThrow("do not pass a JSON-encoded string");
    try {
      executionArgs(encoded);
      throw new Error("Expected executionArgs to reject encoded input.");
    } catch (error) {
      expect(error).toMatchObject({ code: "tool_arguments_invalid" });
    }
  });

  it("preserves valid object arguments unchanged", async () => {
    const input = { value: "direct" } satisfies Record<string, JsonValue>;
    expect(executionArgs(input)).toBe(input);
    await expect(prepareToolCallPlan(descriptor(), input, preparationContext)).resolves.toEqual(readOnlyPlan);
  });

  it("persists the stable diagnostic and permits a later valid call", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-tool-arguments-"));
    await writeFile(path.join(workspace, "input.txt"), "value\n", "utf8");
    const gateway = new ArgumentContractGateway();
    const store = new SegmentedJsonlStore({ rootDir: path.join(workspace, ".agent") });
    const runtime = createRuntime({
      gateway,
      store,
      storeRootDir: path.join(workspace, ".agent"),
      tools: registerBuiltinTools(new EffectToolRegistry()),
      reviewer: createApprovingReviewer(),
      permissionMode: "auto",
      runDeadlineMs: 30_000
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({
      type: "submit",
      sessionId: session.sessionId,
      text: "Exercise the generic tool argument contract."
    });
    await expect(runtime.waitForOutcome(session.sessionId)).resolves.toMatchObject({ kind: "needs_input" });

    const events = [];
    for await (const event of runtime.sessionEvents(session.sessionId)) events.push(event);
    expect(events.find((event) => event.type === "tool.failed"
      && (event.payload as { callId?: string }).callId === "encoded-read")?.payload).toMatchObject({
      outcome: { diagnosticCodes: ["tool_arguments_invalid"] },
      diagnostics: ["tool_arguments_invalid"],
      output: expect.stringContaining("do not pass a JSON-encoded string")
    });
    expect(events.find((event) => event.type === "tool.completed"
      && (event.payload as { callId?: string }).callId === "direct-read")?.payload).toMatchObject({ ok: true });
    expect(gateway.requests).toHaveLength(3);
  });
});
