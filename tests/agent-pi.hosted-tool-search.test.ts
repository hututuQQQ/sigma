import { describe, expect, it } from "vitest";
import {
  hostedToolSearchPayload,
  hostedToolSearchPolicy
} from "../packages/agent-pi/src/hosted-tool-search.js";

function functionTool(name: string): Record<string, unknown> {
  return {
    type: "function",
    name,
    description: `Use ${name} for its general runtime capability.`,
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

function transformed(payload: Record<string, unknown>): Record<string, unknown> {
  return hostedToolSearchPayload(payload, true) as Record<string, unknown>;
}

describe("provider-hosted namespace tool search", () => {
  it("groups a large function surface, defers every function, and restores replay namespaces", () => {
    const names = [
      "read", "list", "grep", "batch_read", "repository_inspect", "repository_stats",
      "lsp", "inspect_document", "inspect_image",
      "write", "edit", "write_chunk", "delete_file", "apply_patch",
      "shell", "exec", "validate", "process_spawn", "process_poll", "process_write",
      "process_terminate", "process_handoff", "environment_prepare",
      "git_status", "git_diff", "git_transaction",
      "update_plan", "read_plan", "read_budget", "read_workspace_frontier",
      "read_artifact", "load_skill", "list_checkpoints",
      "restore_run_changes", "confirm_run_restored",
      "spawn_agent", "message_agent", "join_agent", "list_agents", "integrate_agent",
      "request_review", "request_user_input", "report_blocked", "web_run"
    ];
    const custom = { type: "custom", name: "grammar_passthrough", format: { type: "text" } };
    const payload = {
      model: "gpt-5.6-sol",
      tool_choice: "auto",
      input: [{
        type: "function_call",
        call_id: "call_patch",
        name: "apply_patch",
        arguments: "{}"
      }],
      tools: [...names.map(functionTool), custom]
    };

    const result = transformed(payload);
    const tools = result.tools as Array<Record<string, unknown>>;
    const namespaces = tools.filter((tool) => tool.type === "namespace");
    const deferred = namespaces.flatMap((namespace) =>
      namespace.tools as Array<Record<string, unknown>>);

    expect(tools.at(-1)).toEqual({ type: "tool_search" });
    expect(tools).toContainEqual(custom);
    expect(tools.some((tool) => tool.type === "function")).toBe(false);
    expect(namespaces.every((namespace) =>
      (namespace.tools as unknown[]).length <= hostedToolSearchPolicy.maximumFunctionsPerNamespace
    )).toBe(true);
    expect(deferred.map((tool) => tool.name).sort()).toEqual([...names].sort());
    expect(deferred.every((tool) => tool.defer_loading === true)).toBe(true);
    expect(result.input).toEqual([expect.objectContaining({
      type: "function_call",
      name: "apply_patch",
      namespace: "workspace_write"
    })]);

    const modelVisibleTools = tools.map((tool) => tool.type === "namespace"
      ? { type: tool.type, name: tool.name, description: tool.description }
      : tool);
    expect(JSON.stringify(modelVisibleTools).length / JSON.stringify(payload.tools).length)
      .toBeLessThan(0.2);
  });

  it("chunks an oversized fallback namespace without losing or duplicating functions", () => {
    const names = Array.from({ length: 23 }, (_, index) => `optional_capability_${index}`);
    const result = transformed({
      tool_choice: "auto",
      input: [{
        type: "function_call",
        call_id: "call_optional",
        name: names.at(-1),
        arguments: "{}"
      }],
      tools: names.map(functionTool)
    });
    const namespaces = (result.tools as Array<Record<string, unknown>>)
      .filter((tool) => tool.type === "namespace");
    const loadedNames = namespaces.flatMap((namespace) =>
      (namespace.tools as Array<Record<string, unknown>>).map((tool) => tool.name));

    expect(namespaces.map((namespace) => namespace.name)).toEqual([
      "additional_capabilities_1",
      "additional_capabilities_2",
      "additional_capabilities_3"
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

  it("is inactive for disabled, text-only, small, and already-native requests", () => {
    const small = {
      tool_choice: "auto",
      input: [],
      tools: Array.from(
        { length: hostedToolSearchPolicy.minimumFunctions - 1 },
        (_, index) => functionTool(`small_${index}`)
      )
    };
    expect(hostedToolSearchPayload(small, false)).toBe(small);
    expect(hostedToolSearchPayload(small, true)).toBe(small);

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
  });
});
