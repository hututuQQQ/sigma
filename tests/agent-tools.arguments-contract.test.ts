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

function recursivelyValidatedDescriptor(prepare = vi.fn(() => readOnlyPlan)): ToolDescriptor {
  return {
    ...descriptor(prepare),
    name: "recursive_object_tool",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", pattern: "^[a-z]+$", minLength: 2, maxLength: 4 },
        mode: { type: "string", enum: ["safe", "fast"] },
        count: { type: "integer", minimum: 1, maximum: 3 },
        choice: {
          anyOf: [
            { type: "string", enum: ["auto"] },
            { type: "number", minimum: 10 }
          ]
        },
        tags: {
          type: "array", items: { type: "string" }, minItems: 1, maxItems: 2,
          uniqueItems: true
        },
        metadata: { type: "object", additionalProperties: { type: "string" } },
        nested: {
          type: "object",
          properties: { enabled: { type: "boolean" } },
          required: ["enabled"],
          additionalProperties: false
        }
      },
      required: ["name", "mode", "count", "choice", "tags", "metadata", "nested"],
      additionalProperties: false
    }
  };
}

function schemaDescriptor(
  inputSchema: ToolDescriptor["inputSchema"],
  prepare = vi.fn(() => readOnlyPlan)
): ToolDescriptor {
  return {
    ...descriptor(prepare),
    name: "schema_tool",
    inputSchema
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
    await expect(registry.execute({
      callId: "invalid-object-call",
      name: "object_tool",
      arguments: { unexpected: true }
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

  it("recursively enforces the descriptor schema before preparation", async () => {
    const valid = {
      name: "code",
      mode: "safe",
      count: 2,
      choice: "auto",
      tags: ["one", "two"],
      metadata: { owner: "runtime" },
      nested: { enabled: true }
    } satisfies Record<string, JsonValue>;
    await expect(prepareToolCallPlan(
      recursivelyValidatedDescriptor(), valid, preparationContext
    )).resolves.toEqual(readOnlyPlan);

    const invalid: Array<[string, Record<string, JsonValue>]> = [
      ["required", { ...valid, nested: {} }],
      ["additionalProperties", { ...valid, unexpected: true }],
      ["boolean type", { ...valid, nested: { enabled: "true" } }],
      ["integer type", { ...valid, count: 1.5 }],
      ["minimum", { ...valid, count: 0 }],
      ["maximum", { ...valid, count: 4 }],
      ["pattern", { ...valid, name: "A1" }],
      ["enum", { ...valid, mode: "unknown" }],
      ["anyOf", { ...valid, choice: 5 }],
      ["items", { ...valid, tags: ["one", 2] }],
      ["minItems", { ...valid, tags: [] }],
      ["maxItems", { ...valid, tags: ["one", "two", "three"] }],
      ["uniqueItems", { ...valid, tags: ["one", "one"] }],
      ["additionalProperties schema", { ...valid, metadata: { owner: 1 } }]
    ];
    for (const [label, argumentsValue] of invalid) {
      const prepare = vi.fn(() => readOnlyPlan);
      await expect(prepareToolCallPlan(
        recursivelyValidatedDescriptor(prepare), argumentsValue, preparationContext
      ), label).rejects.toMatchObject({ code: "tool_arguments_invalid" });
      expect(prepare, label).not.toHaveBeenCalled();
    }
  });

  it("supports 2020-12 applicators, const, local refs, and a schema without root type", async () => {
    const inputSchema = {
      $defs: {
        mode: { oneOf: [{ const: "safe" }, { const: "fast" }] },
        payload: {
          allOf: [
            {
              type: "object",
              properties: { kind: { const: "job" } },
              required: ["kind"]
            },
            {
              type: "object",
              properties: {
                mode: { $ref: "#/$defs/mode" },
                count: { type: ["integer", "null"] },
                rank: {
                  oneOf: [
                    { type: "integer", minimum: 0 },
                    { type: "number", maximum: 10 }
                  ]
                }
              },
              required: ["mode", "count", "rank"]
            },
            {
              type: "object",
              properties: { kind: {}, mode: {}, count: {}, rank: {} },
              additionalProperties: false
            }
          ]
        }
      },
      properties: { payload: { $ref: "#/$defs/payload" } },
      required: ["payload"],
      additionalProperties: false
    } satisfies ToolDescriptor["inputSchema"];
    const valid = { payload: { kind: "job", mode: "safe", count: null, rank: 11 } };
    await expect(prepareToolCallPlan(
      schemaDescriptor(inputSchema), valid, preparationContext
    )).resolves.toEqual(readOnlyPlan);

    const invalid: Array<[string, Record<string, JsonValue>]> = [
      ["root required", {}],
      ["const", { payload: { ...valid.payload, kind: "other" } }],
      ["local ref oneOf", { payload: { ...valid.payload, mode: "unknown" } }],
      ["type array", { payload: { ...valid.payload, count: "1" } }],
      ["exclusive oneOf", { payload: { ...valid.payload, rank: 5 } }],
      ["allOf", { payload: { kind: "job", mode: "safe", count: null } }],
      ["nested additionalProperties", { payload: { ...valid.payload, extra: true } }]
    ];
    for (const [label, value] of invalid) {
      const prepare = vi.fn(() => readOnlyPlan);
      await expect(prepareToolCallPlan(
        schemaDescriptor(inputSchema, prepare), value, preparationContext
      ), label).rejects.toMatchObject({ code: "tool_arguments_invalid" });
      expect(prepare, label).not.toHaveBeenCalled();
    }
  });

  it("validates a root type array while independently requiring object arguments", async () => {
    const tool = schemaDescriptor({
      type: ["object", "null"],
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false
    });
    await expect(prepareToolCallPlan(
      tool, { name: "valid" }, preparationContext
    )).resolves.toEqual(readOnlyPlan);
    await expect(prepareToolCallPlan(
      tool, {}, preparationContext
    )).rejects.toMatchObject({ code: "tool_arguments_invalid" });
    await expect(prepareToolCallPlan(
      tool, null, preparationContext
    )).rejects.toMatchObject({ code: "tool_arguments_invalid" });
  });

  it("keeps empty schemas compatible with arbitrary object arguments", async () => {
    const tool = schemaDescriptor({});
    const input = { nested: { value: true }, list: [1, 2, 3] };
    await expect(prepareToolCallPlan(tool, input, preparationContext)).resolves.toEqual(readOnlyPlan);
    await expect(prepareToolCallPlan(
      tool, [1, 2, 3], preparationContext
    )).rejects.toMatchObject({ code: "tool_arguments_invalid" });
  });

  it("does not coerce, apply defaults, or remove properties", async () => {
    const tool = schemaDescriptor({
      type: "object",
      properties: {
        count: { type: "integer" },
        mode: { type: "string", default: "safe" }
      },
      required: ["count"],
      additionalProperties: false
    });
    const invalid = { count: "1", extra: true };
    await expect(prepareToolCallPlan(
      tool, invalid, preparationContext
    )).rejects.toMatchObject({ code: "tool_arguments_invalid" });
    expect(invalid).toEqual({ count: "1", extra: true });

    const withoutDefault = { count: 1 };
    await expect(prepareToolCallPlan(
      tool, withoutDefault, preparationContext
    )).resolves.toEqual(readOnlyPlan);
    expect(withoutDefault).toEqual({ count: 1 });
  });

  it("compiles schemas at registration and fails closed on unsafe definitions", () => {
    const invalidSchemas: Array<[string, ToolDescriptor["inputSchema"]]> = [
      ["remote ref", { properties: { value: { $ref: "https://example.invalid/schema" } } }],
      ["unresolved local ref", { properties: { value: { $ref: "#/$defs/missing" } } }],
      ["invalid schema", { type: "not-a-json-schema-type" }],
      ["unknown assertion", { type: "object", unknownAssertion: true }],
      ["asynchronous schema", { $async: true, type: "object" }]
    ];
    for (const [label, inputSchema] of invalidSchemas) {
      const registry = new EffectToolRegistry();
      try {
        registry.register({
          descriptor: schemaDescriptor(inputSchema),
          execute: async (request) => successfulReceipt(request)
        });
        throw new Error(`Expected ${label} schema registration to fail.`);
      } catch (error) {
        expect(error, label).toMatchObject({ code: "tool_schema_invalid" });
        expect(error, label).not.toMatchObject({ code: "tool_arguments_invalid" });
      }
      expect(registry.descriptors(), label).toEqual([]);
    }
  });

  it("accepts standard annotation keywords without interpreting annotation data as schemas", () => {
    const registry = new EffectToolRegistry();
    registry.register({
      descriptor: schemaDescriptor({
        type: "object",
        title: "Annotated input",
        description: "Annotations do not constrain the instance.",
        default: {},
        examples: [{ $ref: "https://example.invalid/this-is-instance-data" }],
        readOnly: true,
        writeOnly: false,
        deprecated: false
      }),
      execute: async (request) => successfulReceipt(request)
    });
    expect(registry.descriptors()).toHaveLength(1);
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
      runDeadlineMs: 60_000
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
