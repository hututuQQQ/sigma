import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  executeBashTool,
  executeEditTool,
  executeReadTool,
  finalizeManagedServices,
  executeServiceTool,
  executeMemoryTool,
  executeWriteTool,
  type ToolExecutionContext
} from "../packages/agent-core/src/index.js";

async function workspace(): Promise<{ dir: string; context: ToolExecutionContext }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-core-"));
  return {
    dir,
    context: {
      workspacePath: dir,
      permissionMode: "yolo",
      commandTimeoutSec: 2,
      maxToolOutputChars: 200,
      runState: { todos: [], nextTodoId: 1, changedFiles: new Set<string>() },
      alwaysAllowTools: new Set<string>()
    }
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("missing port"));
      });
    });
  });
}

async function waitForFileContaining(filePath: string, needle: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  while (Date.now() <= deadline) {
    try {
      lastText = await readFile(filePath, "utf8");
      if (lastText.includes(needle)) return;
    } catch {
      // The service may not have opened the log yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(lastText).toContain(needle);
}

async function memoryFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(dir, ".agent", "memory"), { recursive: true });
    return entries.map((entry) => String(entry)).sort((a, b) => a.localeCompare(b, "en"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

describe("agent-core tools", () => {
  it("runs bash successfully", async () => {
    const { context } = await workspace();
    const result = await executeBashTool({ command: "printf hello" }, context);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("hello");
    expect(result.metadata?.exitCode).toBe(0);
  });

  it("captures bash non-zero exits", async () => {
    const { context } = await workspace();
    const result = await executeBashTool({ command: "echo nope >&2; exit 7" }, context);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("nope");
    expect(result.metadata?.exitCode).toBe(7);
  });

  it("returns a failed bash result on timeout", async () => {
    const { context } = await workspace();
    const result = await executeBashTool({ command: "sleep 2; echo late", timeoutSec: 0.1 }, context);
    expect(result.ok).toBe(false);
    expect(result.metadata?.timedOut).toBe(true);
  });

  it("guides dev servers to the service tool instead of blocking bash", async () => {
    const { context } = await workspace();
    const result = await executeBashTool({ command: "npm run dev -- --host 127.0.0.1" }, context);

    expect(result.ok).toBe(false);
    expect(result.content).toContain("service.start");
    expect(result.metadata?.blockedReason).toBe("long_running_service_command");
  });

  it("returns after shell exit even when a background child keeps stdout open", async () => {
    const { context } = await workspace();
    const startedAt = Date.now();
    const result = await executeBashTool({ command: "sleep 5 & printf done", timeoutSec: 2 }, context);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("done");
    expect(result.metadata?.settledOn).toMatch(/close|exit-drain/);
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it("returns complete large bash output for runtime budgeting", async () => {
    const { context } = await workspace();
    context.maxToolOutputChars = 80;
    const result = await executeBashTool({ command: "printf 'abcdef%.0s' {1..80}" }, context);
    expect(result.metadata?.truncated).toBe(false);
    expect(result.content).toContain("abcdef".repeat(80));
  });

  it("reads a relative file", async () => {
    const { dir, context } = await workspace();
    await writeFile(path.join(dir, "note.txt"), "hello world", "utf8");
    const result = await executeReadTool({ path: "note.txt" }, context);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("hello world");
  });

  it("rejects reads outside the workspace", async () => {
    const { dir, context } = await workspace();
    const outside = path.resolve(dir, "..", "outside.txt");
    const result = await executeReadTool({ path: outside }, context);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("outside the workspace");
  });

  it("writes a file", async () => {
    const { dir, context } = await workspace();
    const result = await executeWriteTool({ path: "nested/hello.txt", content: "hello", createDirs: true }, context);
    expect(result.ok).toBe(true);
    await expect(readFile(path.join(dir, "nested", "hello.txt"), "utf8")).resolves.toBe("hello");
  });

  it("writes, searches, and reads local memories", async () => {
    const { context } = await workspace();
    const saved = await executeMemoryTool({
      action: "write",
      kind: "feedback",
      title: "Prefer focused validation",
      content: "When tests are expensive, run the narrowest changed-file validation first.",
      tags: ["validation"]
    }, context);
    expect(saved.ok).toBe(true);
    expect(saved.modelMetadata?.kind).toBe("feedback");

    const search = await executeMemoryTool({ action: "search", query: "focused validation", limit: 3 }, context);
    expect(search.ok).toBe(true);
    expect(search.modelContent).toContain("Prefer focused validation");

    const read = await executeMemoryTool({ action: "read", id: String(saved.modelMetadata?.id) }, context);
    expect(read.ok).toBe(true);
    expect(read.modelContent).toContain("narrowest changed-file validation");
  });

  it("filters local memories by scope", async () => {
    const { context } = await workspace();
    await executeMemoryTool({
      action: "write",
      kind: "agent",
      title: "Agent-only note",
      content: "Only agent scoped searches should find this."
    }, context);
    await executeMemoryTool({
      action: "write",
      kind: "project",
      title: "Project note",
      content: "Project scoped searches should find this."
    }, context);

    const projectSearch = await executeMemoryTool({
      action: "search",
      query: "scoped searches",
      scopes: ["project"]
    }, context);
    const agentSearch = await executeMemoryTool({
      action: "search",
      query: "agent scoped",
      scopes: ["agent"]
    }, context);

    expect(projectSearch.modelContent).toContain("Project note");
    expect(projectSearch.modelContent).not.toContain("Agent-only note");
    expect(agentSearch.modelContent).toContain("Agent-only note");
  });

  it("denies memory writes in ask mode without a decider and does not persist files", async () => {
    const { dir, context } = await workspace();
    context.permissionMode = "ask";

    const denied = await executeMemoryTool({
      action: "write",
      kind: "project",
      title: "Denied durable memory",
      content: "This content must not be persisted."
    }, context);

    expect(denied.ok).toBe(false);
    expect(denied.modelContent).toContain("Permission denied");
    expect(denied.modelMetadata).toMatchObject({ denied: true, risk: "write" });
    await expect(memoryFiles(dir)).resolves.toEqual([]);
  });

  it("allows memory writes when an ask-mode decider approves", async () => {
    const { context } = await workspace();
    context.permissionMode = "ask";
    const requests: unknown[] = [];
    context.permissionDecider = {
      decide: async (request) => {
        requests.push(request);
        return "allow";
      }
    };

    const saved = await executeMemoryTool({
      action: "write",
      kind: "reference",
      title: "Approved memory",
      content: "Approved memory content.",
      tags: ["approval"]
    }, context);

    expect(saved.ok).toBe(true);
    expect(saved.modelMetadata?.kind).toBe("reference");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      toolName: "memory",
      risk: "write",
      reason: "Write durable memory reference/Approved memory",
      resources: [{ kind: "memory", mode: "write" }]
    });
  });

  it("keeps memory list, search, and read available as read-only actions in ask mode", async () => {
    const { context } = await workspace();
    const saved = await executeMemoryTool({
      action: "write",
      kind: "feedback",
      title: "Readable memory",
      content: "Read-only memory actions should not ask for write approval."
    }, context);
    expect(saved.ok).toBe(true);
    context.permissionMode = "ask";

    await expect(executeMemoryTool({ action: "list" }, context)).resolves.toMatchObject({ ok: true });
    await expect(executeMemoryTool({ action: "search", query: "read-only memory" }, context)).resolves.toMatchObject({ ok: true });
    await expect(executeMemoryTool({ action: "read", id: String(saved.modelMetadata?.id) }, context)).resolves.toMatchObject({ ok: true });
  });

  it("edits exact replacements", async () => {
    const { dir, context } = await workspace();
    await writeFile(path.join(dir, "edit.txt"), "one two one", "utf8");
    const result = await executeEditTool(
      { path: "edit.txt", oldString: "one", newString: "three", expectedReplacements: 2 },
      context
    );
    expect(result.ok).toBe(true);
    await expect(readFile(path.join(dir, "edit.txt"), "utf8")).resolves.toBe("three two three");
  });

  it("rejects edit expectedReplacements mismatches", async () => {
    const { dir, context } = await workspace();
    await writeFile(path.join(dir, "edit.txt"), "one two one", "utf8");
    const result = await executeEditTool(
      { path: "edit.txt", oldString: "one", newString: "three", expectedReplacements: 1 },
      context
    );
    expect(result.ok).toBe(false);
    await expect(readFile(path.join(dir, "edit.txt"), "utf8")).resolves.toBe("one two one");
  });

  it("starts, inspects logs, and stops a service", async () => {
    const { dir, context } = await workspace();
    process.env.AGENT_SERVICE_REGISTRY = path.join(dir, "services.json");
    process.env.AGENT_SERVICE_LOG_DIR = path.join(dir, "logs");
    const port = await freePort();

    const start = await executeServiceTool(
      {
        action: "start",
        name: "web",
        command: `node -e "console.log('ready'); require('http').createServer((req,res)=>res.end('ok')).listen(${port}, '127.0.0.1')"`,
        port,
        readinessTimeoutSec: 5
      },
      context
    );
    expect(start.ok).toBe(true);
    expect(start.content).toContain(`url=http://127.0.0.1:${port}`);
    expect(start.metadata?.url).toBe(`http://127.0.0.1:${port}`);

    const status = await executeServiceTool({ action: "status", name: "web" }, context);
    expect(status.ok).toBe(true);
    expect(status.content).toContain('"alive": true');

    const logs = await executeServiceTool({ action: "logs", name: "web" }, context);
    expect(logs.ok).toBe(true);
    expect(logs.content).toContain("ready");

    const stop = await executeServiceTool({ action: "stop", name: "web" }, context);
    expect(stop.ok).toBe(true);
  });

  it("preserves keepAliveAfterRun services during managed service finalization", async () => {
    const { dir, context } = await workspace();
    process.env.AGENT_SERVICE_REGISTRY = path.join(dir, "services.json");
    process.env.AGENT_SERVICE_LOG_DIR = path.join(dir, "logs");
    const defaultPort = await freePort();
    const explicitStopPort = await freePort();

    await expect(
      executeServiceTool(
        { action: "start", name: "temp", command: "node -e \"setInterval(()=>{}, 1000)\"" },
        context
      )
    ).resolves.toMatchObject({ ok: true });
    await expect(
      executeServiceTool(
        { action: "start", name: "kept", command: "node -e \"setInterval(()=>{}, 1000)\"", keepAliveAfterRun: true },
        context
      )
    ).resolves.toMatchObject({ ok: true });
    await expect(
      executeServiceTool(
        {
          action: "start",
          name: "port-default",
          command: `node -e "require('http').createServer((req,res)=>res.end('ok')).listen(${defaultPort}, '127.0.0.1')"`,
          port: defaultPort,
          readinessTimeoutSec: 5
        },
        context
      )
    ).resolves.toMatchObject({ ok: true });
    await expect(
      executeServiceTool(
        {
          action: "start",
          name: "readiness-default",
          command: "node -e \"setInterval(()=>{}, 1000)\"",
          readinessCommand: "node -e \"process.exit(0)\""
        },
        context
      )
    ).resolves.toMatchObject({ ok: true });
    await expect(
      executeServiceTool(
        {
          action: "start",
          name: "explicit-stop",
          command: `node -e "require('http').createServer((req,res)=>res.end('ok')).listen(${explicitStopPort}, '127.0.0.1')"`,
          port: explicitStopPort,
          keepAliveAfterRun: false,
          readinessTimeoutSec: 5
        },
        context
      )
    ).resolves.toMatchObject({ ok: true });

    const cleanup = await finalizeManagedServices();
    expect(cleanup.stopped).toContain("temp");
    expect(cleanup.stopped).toContain("explicit-stop");
    expect(cleanup.kept).toContain("kept");
    expect(cleanup.kept).toContain("port-default");
    expect(cleanup.kept).toContain("readiness-default");

    await executeServiceTool({ action: "stop", name: "kept" }, context);
    await executeServiceTool({ action: "stop", name: "port-default" }, context);
    await executeServiceTool({ action: "stop", name: "readiness-default" }, context);
  });

  it("fails readiness timeouts while keeping service logs", async () => {
    const { dir, context } = await workspace();
    const previousRegistry = process.env.AGENT_SERVICE_REGISTRY;
    const previousLogDir = process.env.AGENT_SERVICE_LOG_DIR;
    process.env.AGENT_SERVICE_REGISTRY = path.join(dir, "services.json");
    delete process.env.AGENT_SERVICE_LOG_DIR;
    const logPath = path.join(dir, "not-ready.log");
    const port = await freePort();

    try {
      const result = await executeServiceTool(
        {
          action: "start",
          name: "not-ready",
          command: "node -e \"console.log('booting'); setInterval(function(){}, 1000)\"",
          port,
          logPath,
          readinessTimeoutSec: 3
        },
        context
      );

      expect(result.ok).toBe(false);
      await waitForFileContaining(logPath, "booting");
    } finally {
      if (previousRegistry === undefined) delete process.env.AGENT_SERVICE_REGISTRY;
      else process.env.AGENT_SERVICE_REGISTRY = previousRegistry;
      if (previousLogDir === undefined) delete process.env.AGENT_SERVICE_LOG_DIR;
      else process.env.AGENT_SERVICE_LOG_DIR = previousLogDir;
    }
  });
});
