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
    expect(durationMs).toBeLessThan(180);
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
});
