import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResponse } from "../packages/agent-ai/src/index.js";
import {
  createDefaultToolRegistry,
  createToolRegistryFromTools,
  executeReadTool,
  executeWriteTool,
  mergeToolRegistries,
  runAgent,
  type PermissionDecider,
  type RegisteredTool,
  type ToolExecutionContext
} from "../packages/agent-core/src/index.js";

class FakeModel implements ModelClient {
  readonly provider = "deepseek" as const;
  readonly model = "fake-registry-model";
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const response = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;
    return response;
  }
}

async function workspace(): Promise<{ dir: string; context: ToolExecutionContext }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sigma-registry-"));
  return {
    dir,
    context: {
      workspacePath: dir,
      permissionMode: "ask",
      commandTimeoutSec: 2,
      maxToolOutputChars: 1000,
      runState: { todos: [], nextTodoId: 1, changedFiles: new Set<string>() },
      alwaysAllowTools: new Set<string>()
    }
  };
}

function customTool(name = "ping"): RegisteredTool {
  return {
    definition: {
      type: "function",
      function: {
        name,
        description: "test tool",
        parameters: { type: "object", additionalProperties: false }
      }
    },
    execute: async () => ({ ok: true, content: "pong" })
  };
}

describe("tool registry and permissions", () => {
  it("default registry exposes the core tools and new workspace tools", () => {
    const names = createDefaultToolRegistry().definitions.map((definition) => definition.function.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "bash",
        "read",
        "write",
        "edit",
        "list",
        "glob",
        "grep",
        "git_status",
        "git_diff",
        "apply_patch",
        "todo"
      ])
    );
  });

  it("uses an injected registry", async () => {
    const { dir } = await workspace();
    const model = new FakeModel([
      {
        message: {
          role: "assistant",
          toolCalls: [{ id: "call-1", type: "function", function: { name: "ping", arguments: {} } }]
        }
      },
      { message: { role: "assistant", content: "done" } }
    ]);

    const result = await runAgent({
      instruction: "call ping",
      workspacePath: dir,
      modelClient: model,
      permissionMode: "ask",
      toolRegistry: createToolRegistryFromTools([customTool()])
    });

    expect(result.status).toBe("completed");
    expect(result.toolCalls).toBe(1);
    expect(model.requests[0].tools?.map((tool) => tool.function.name)).toEqual(["ping"]);
  });

  it("uses an injected async registry factory", async () => {
    const { dir } = await workspace();
    const model = new FakeModel([{ message: { role: "assistant", content: "done" } }]);

    await runAgent({
      instruction: "finish",
      workspacePath: dir,
      modelClient: model,
      toolRegistryFactory: async () => createToolRegistryFromTools([customTool("factory_tool")])
    });

    expect(model.requests[0].tools?.map((tool) => tool.function.name)).toEqual(["factory_tool"]);
  });

  it("filters allowed and disabled tools before model calls", async () => {
    const { dir } = await workspace();
    const model = new FakeModel([{ message: { role: "assistant", content: "done" } }]);

    await runAgent({
      instruction: "finish",
      workspacePath: dir,
      modelClient: model,
      allowedTools: ["read", "write"],
      disabledTools: ["write"]
    });

    expect(model.requests[0].tools?.map((tool) => tool.function.name)).toEqual(["read"]);
  });

  it("hides tools denied by permission rules before model calls", async () => {
    const { dir } = await workspace();
    const model = new FakeModel([{ message: { role: "assistant", content: "done" } }]);

    await runAgent({
      instruction: "finish",
      workspacePath: dir,
      modelClient: model,
      permissionRules: [{ action: "deny", tool: "bash" }]
    });

    expect(model.requests[0].tools?.map((tool) => tool.function.name)).not.toContain("bash");
  });

  it("rejects duplicate tool names", () => {
    expect(() => createToolRegistryFromTools([customTool("dup"), customTool("dup")])).toThrow("Duplicate tool name");
    expect(() =>
      mergeToolRegistries([createToolRegistryFromTools([customTool("dup")]), createToolRegistryFromTools([customTool("dup")])])
    ).toThrow("Duplicate tool name");
  });

  it("denies writes in ask mode without a decider", async () => {
    const { context } = await workspace();
    const result = await executeWriteTool({ path: "note.txt", content: "nope" }, context);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Permission denied");
  });

  it("allows read-only tools in ask mode without a decider", async () => {
    const { dir, context } = await workspace();
    await writeFile(path.join(dir, "note.txt"), "hello", "utf8");
    const result = await executeReadTool({ path: "note.txt" }, context);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("hello");
  });

  it("uses mock permission decider allow, deny, and always_allow decisions", async () => {
    const { dir, context } = await workspace();
    const decisions: Array<"allow" | "deny" | "always_allow"> = ["allow", "deny", "always_allow"];
    let calls = 0;
    const decider: PermissionDecider = {
      decide: async () => {
        const decision = decisions[Math.min(calls, decisions.length - 1)];
        calls += 1;
        return decision;
      }
    };
    context.permissionDecider = decider;

    await expect(executeWriteTool({ path: "a.txt", content: "a" }, context)).resolves.toMatchObject({ ok: true });
    await expect(readFile(path.join(dir, "a.txt"), "utf8")).resolves.toBe("a");
    await expect(executeWriteTool({ path: "b.txt", content: "b" }, context)).resolves.toMatchObject({ ok: false });
    await expect(executeWriteTool({ path: "c.txt", content: "c" }, context)).resolves.toMatchObject({ ok: true });
    await expect(executeWriteTool({ path: "d.txt", content: "d" }, context)).resolves.toMatchObject({ ok: true });
    expect(calls).toBe(3);
  });

  it("allows writes in yolo mode without prompting", async () => {
    const { dir, context } = await workspace();
    context.permissionMode = "yolo";
    const result = await executeWriteTool({ path: "note.txt", content: "yes" }, context);
    expect(result.ok).toBe(true);
    await expect(readFile(path.join(dir, "note.txt"), "utf8")).resolves.toBe("yes");
  });
});
