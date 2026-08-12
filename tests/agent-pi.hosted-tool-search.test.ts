import type { ModelToolDefinition } from "agent-protocol";
import { describe, expect, it } from "vitest";
import {
  hostedToolSearchPayload,
  hostedToolSearchPolicy
} from "../packages/agent-pi/src/hosted-tool-search.js";

function functionTool(name: string, description = `Use ${name} for its general runtime capability.`): Record<string, unknown> {
  return {
    type: "function",
    name,
    description,
    strict: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path." },
        query: { type: "string", description: "Capability-specific query." }
      },
      required: ["query"],
      additionalProperties: false
    }
  };
}

function definition(
  name: string,
  exposure: "direct" | "deferred",
  namespace = "optional_runtime"
): ModelToolDefinition {
  return {
    name,
    description: `Use ${name} for its general runtime capability.`,
    inputSchema: { type: "object" },
    presentation: {
      exposure,
      namespace: {
        name: namespace,
        description: `Discover ${namespace.replaceAll("_", " ")} capabilities.`
      }
    }
  };
}

describe("provider-hosted namespace tool search", () => {
  it("keeps the stable core direct, defers the long tail, and restores only deferred replay namespaces", () => {
    const directNames = ["core_a", "core_b", "core_c", "core_d", "core_e", "core_f"];
    const deferredNames = Array.from({ length: 18 }, (_, index) => `extension_${index}`);
    const names = [...directNames, ...deferredNames];
    const custom = { type: "custom", name: "grammar_passthrough", format: { type: "text" } };
    const originalFunctions = names.map(functionTool);
    const payload = {
      tool_choice: "auto",
      input: [
        { type: "function_call", call_id: "call_core", name: "core_a", arguments: "{}" },
        { type: "function_call", call_id: "call_extension", name: "extension_17", arguments: "{}" }
      ],
      tools: [...originalFunctions, custom]
    };
    const definitions = [
      ...directNames.map((name) => definition(name, "direct", "stable_core")),
      ...deferredNames.map((name, index) => definition(
        name,
        "deferred",
        index < 10 ? "external_catalog" : "specialized_runtime"
      ))
    ];

    const result = hostedToolSearchPayload(payload, true, definitions) as Record<string, unknown>;
    const tools = result.tools as Array<Record<string, unknown>>;
    const direct = tools.filter((tool) => tool.type === "function");
    const namespaces = tools.filter((tool) => tool.type === "namespace");
    const deferred = namespaces.flatMap((namespace) =>
      namespace.tools as Array<Record<string, unknown>>);

    expect(tools.at(-1)).toEqual({ type: "tool_search" });
    expect(tools).toContainEqual(custom);
    expect(direct).toEqual(originalFunctions.slice(0, directNames.length));
    expect(direct.every((tool) => tool.defer_loading === undefined)).toBe(true);
    expect(namespaces.every((namespace) =>
      (namespace.tools as unknown[]).length <= hostedToolSearchPolicy.maximumFunctionsPerNamespace
    )).toBe(true);
    expect(deferred.map((tool) => tool.name).sort()).toEqual([...deferredNames].sort());
    expect(deferred.every((tool) => tool.defer_loading === true)).toBe(true);
    expect(result.input).toEqual([
      expect.not.objectContaining({ namespace: expect.anything() }),
      expect.objectContaining({
        type: "function_call",
        name: "extension_17",
        namespace: "specialized_runtime"
      })
    ]);

    const modelVisibleTools = tools.map((tool) => tool.type === "namespace"
      ? { type: tool.type, name: tool.name, description: tool.description }
      : tool);
    expect(JSON.stringify(modelVisibleTools).length / JSON.stringify(payload.tools).length)
      .toBeLessThanOrEqual(hostedToolSearchPolicy.maximumInitialVisibleRatio);
  });

  it("uses metadata rather than function-name tables and chunks oversized namespaces", () => {
    const names = Array.from({ length: 23 }, (_, index) => `arbitrary_${index}`);
    const definitions = names.map((name) => definition(name, "deferred", "domain_tools"));
    const result = hostedToolSearchPayload({
      tool_choice: "auto",
      input: [{
        type: "function_call",
        call_id: "call_optional",
        name: names.at(-1),
        arguments: "{}"
      }],
      tools: names.map(functionTool)
    }, true, definitions) as Record<string, unknown>;
    const namespaces = (result.tools as Array<Record<string, unknown>>)
      .filter((tool) => tool.type === "namespace");
    const loadedNames = namespaces.flatMap((namespace) =>
      (namespace.tools as Array<Record<string, unknown>>).map((tool) => tool.name));

    expect(namespaces.map((namespace) => namespace.name)).toEqual([
      "domain_tools_1",
      "domain_tools_2",
      "domain_tools_3"
    ]);
    expect(loadedNames.sort()).toEqual([...names].sort());
    expect(new Set(loadedNames).size).toBe(names.length);
    const replayNamespace = namespaces.find((namespace) =>
      (namespace.tools as Array<Record<string, unknown>>)
        .some((tool) => tool.name === names.at(-1)))?.name;
    expect(result.input).toEqual([expect.objectContaining({
      namespace: replayNamespace
    })]);
  });

  it("is inactive for disabled, text-only, small, already-native, and low-savings requests", () => {
    const small = {
      tool_choice: "auto",
      input: [],
      tools: Array.from(
        { length: hostedToolSearchPolicy.minimumDeferredFunctions - 1 },
        (_, index) => functionTool(`small_${index}`)
      )
    };
    expect(hostedToolSearchPayload(small, false)).toBe(small);
    expect(hostedToolSearchPayload(small, true)).toBe(small);

    const unannotated = {
      ...small,
      tools: [...small.tools, functionTool("unannotated_threshold")]
    };
    expect(hostedToolSearchPayload(unannotated, true)).toBe(unannotated);

    const textOnly = {
      ...small,
      tool_choice: "none",
      tools: [...small.tools, functionTool("threshold")]
    };
    expect(hostedToolSearchPayload(textOnly, true)).toBe(textOnly);

    const native = {
      tool_choice: "auto",
      input: [],
      tools: [{ type: "namespace", name: "existing", description: "Existing", tools: [] }]
    };
    expect(hostedToolSearchPayload(native, true)).toBe(native);

    const deferredNames = Array.from(
      { length: hostedToolSearchPolicy.minimumDeferredFunctions },
      (_, index) => `tiny_${index}`
    );
    const dominantDirect = "x".repeat(20_000);
    const lowSavings = {
      tool_choice: "auto",
      input: [],
      tools: [functionTool("dominant_core", dominantDirect), ...deferredNames.map(functionTool)]
    };
    const definitions = [
      definition("dominant_core", "direct", "stable_core"),
      ...deferredNames.map((name) => definition(name, "deferred"))
    ];
    expect(hostedToolSearchPayload(lowSavings, true, definitions)).toBe(lowSavings);
  });
});
