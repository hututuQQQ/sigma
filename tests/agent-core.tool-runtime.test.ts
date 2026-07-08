import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolCall } from "../packages/agent-ai/src/index.js";
import {
  createToolRegistryFromTools,
  ToolRuntime,
  type AgentEvent,
  type RegisteredTool,
  type ToolExecutionContext
} from "../packages/agent-core/src/index.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function call(id: string, name: string): ToolCall {
  return { id, type: "function", function: { name, arguments: {} } };
}

async function context(maxToolOutputChars = 1000): Promise<ToolExecutionContext> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sigma-runtime-"));
  return {
    workspacePath: dir,
    permissionMode: "ask",
    commandTimeoutSec: 2,
    maxToolOutputChars,
    runId: "runtime-test",
    runState: { todos: [], nextTodoId: 1, changedFiles: new Set<string>() },
    alwaysAllowTools: new Set<string>()
  };
}

function tool(name: string, options: { delayMs?: number; readOnly?: boolean; output?: string }): RegisteredTool {
  return {
    definition: {
      type: "function",
      function: {
        name,
        description: "runtime test tool",
        parameters: { type: "object", additionalProperties: false }
      }
    },
    risk: options.readOnly ? "read" : "write",
    runtime: {
      readOnly: options.readOnly,
      supportsParallel: options.readOnly
    },
    execute: async () => {
      if (options.delayMs) await sleep(options.delayMs);
      return { ok: true, content: options.output ?? name };
    }
  };
}

describe("ToolRuntime", () => {
  it("runs consecutive parallel-safe tools together and serial tools as barriers", async () => {
    const ctx = await context();
    const registry = createToolRegistryFromTools([
      tool("read_a", { delayMs: 80, readOnly: true }),
      tool("read_b", { delayMs: 80, readOnly: true }),
      tool("write_a", { delayMs: 40, readOnly: false }),
      tool("read_c", { delayMs: 20, readOnly: true })
    ]);
    const runtime = new ToolRuntime(registry, ctx);
    const events: AgentEvent["type"][] = [];
    const startedAt = Date.now();
    const results = await runtime.executeBatch(
      [call("1", "read_a"), call("2", "read_b"), call("3", "write_a"), call("4", "read_c")],
      {
        emit: async (type) => {
          events.push(type);
        },
        execute: async (toolCall) => ({ result: await registry.execute(toolCall, ctx), value: {} })
      }
    );
    const durationMs = Date.now() - startedAt;
    expect(results.map((result) => result.result.content)).toEqual(["read_a", "read_b", "write_a", "read_c"]);
    expect(durationMs).toBeLessThan(260);
    expect(runtime.summary()).toMatchObject({ queued: 4, started: 4, completed: 4, parallel_batches: 2, serial_batches: 1 });
    expect(events).toContain("tool_queued");
    expect(events).toContain("tool_progress");
  });

  it("stores oversized tool output as an artifact and returns a bounded response", async () => {
    const ctx = await context(40);
    const registry = createToolRegistryFromTools([
      tool("big_read", { readOnly: true, output: "x".repeat(200) })
    ]);
    const runtime = new ToolRuntime(registry, ctx);
    const [result] = await runtime.executeBatch([call("big-1", "big_read")], {
      emit: async () => {},
      execute: async (toolCall) => ({ result: await registry.execute(toolCall, ctx), value: {} })
    });
    const artifact = result.result.metadata?.toolArtifact as { path?: string } | undefined;
    expect(result.result.content).toContain("Full output saved");
    expect(artifact?.path).toMatch(/\.agent\/artifacts\/runtime-test\/big_read-/);
    await expect(readFile(path.join(ctx.workspacePath, artifact?.path ?? ""), "utf8")).resolves.toBe("x".repeat(200));
  });

  it("honors the default parallel tool limit for read-only batches", async () => {
    const ctx = await context();
    const tools = Array.from({ length: 6 }, (_, index): RegisteredTool => ({
      definition: {
        type: "function",
        function: {
          name: `read_${index}`,
          description: "runtime test tool",
          parameters: { type: "object", additionalProperties: false }
        }
      },
      risk: "read",
      runtime: { readOnly: true, supportsParallel: true },
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(40);
        active -= 1;
        return { ok: true, content: `read_${index}` };
      }
    }));
    let active = 0;
    let maxActive = 0;
    const registry = createToolRegistryFromTools(tools);
    const runtime = new ToolRuntime(registry, ctx);

    await runtime.executeBatch(tools.map((registered, index) => call(String(index), registered.definition.function.name)), {
      emit: async () => {},
      execute: async (toolCall) => ({ result: await registry.execute(toolCall, ctx), value: {} })
    });

    expect(maxActive).toBeLessThanOrEqual(4);
    expect(runtime.summary()).toMatchObject({ parallel_batches: 2, completed: 6 });
  });

  it("uses structured cancellation metadata instead of matching output text", async () => {
    const ctx = await context();
    const registry = createToolRegistryFromTools([
      {
        definition: {
          type: "function",
          function: {
            name: "text_abort",
            description: "returns abort-looking text",
            parameters: { type: "object", additionalProperties: false }
          }
        },
        risk: "read",
        runtime: { readOnly: true, supportsParallel: true },
        execute: async () => ({ ok: false, content: "operation aborted by upstream" })
      },
      {
        definition: {
          type: "function",
          function: {
            name: "structured_abort",
            description: "returns cancellation metadata",
            parameters: { type: "object", additionalProperties: false }
          }
        },
        risk: "read",
        runtime: { readOnly: true, supportsParallel: true },
        execute: async () => ({ ok: false, content: "stopped", metadata: { cancelled: true, cancelReason: "test_cancelled" } })
      }
    ]);
    const runtime = new ToolRuntime(registry, ctx);
    const aborted: AgentEvent[] = [];

    await runtime.executeBatch([call("text", "text_abort"), call("structured", "structured_abort")], {
      emit: async (type, metadata, parentId) => {
        const event = {
          id: `${type}-${aborted.length}`,
          timestamp: new Date().toISOString(),
          type,
          runId: "runtime-test",
          metadata,
          parentId
        } as AgentEvent;
        if (type === "tool_aborted") aborted.push(event);
        return event;
      },
      execute: async (toolCall) => ({ result: await registry.execute(toolCall, ctx), value: {} })
    });

    expect(aborted).toHaveLength(1);
    expect(aborted[0].metadata).toMatchObject({ toolCallId: "structured", reason: "test_cancelled" });
  });

  it("can write large-output artifacts outside the workspace", async () => {
    const ctx = await context(40);
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-runtime-artifacts-"));
    ctx.toolArtifactRootDir = artifactRoot;
    const registry = createToolRegistryFromTools([
      tool("big_external", { readOnly: true, output: "z".repeat(200) })
    ]);
    const runtime = new ToolRuntime(registry, ctx);
    const [result] = await runtime.executeBatch([call("external-1", "big_external")], {
      emit: async () => {},
      execute: async (toolCall) => ({ result: await registry.execute(toolCall, ctx), value: {} })
    });
    const artifact = result.result.metadata?.toolArtifact as { path?: string } | undefined;

    expect(artifact?.path).toContain(artifactRoot.split(path.sep).join("/"));
    expect(artifact?.path).not.toContain(".agent/artifacts");
    await expect(readFile(artifact?.path ?? "", "utf8")).resolves.toBe("z".repeat(200));
  });
});
