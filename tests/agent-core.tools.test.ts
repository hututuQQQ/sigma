import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanupServicesBeforeVerifier,
  executeBashTool,
  executeEditTool,
  executeReadTool,
  executeServiceTool,
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
      maxToolOutputChars: 200
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

  it("returns after shell exit even when a background child keeps stdout open", async () => {
    const { context } = await workspace();
    const startedAt = Date.now();
    const result = await executeBashTool({ command: "sleep 5 & printf done", timeoutSec: 2 }, context);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("done");
    expect(result.metadata?.settledOn).toMatch(/close|exit-drain/);
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it("truncates large bash output with head and tail", async () => {
    const { context } = await workspace();
    context.maxToolOutputChars = 80;
    const result = await executeBashTool({ command: "printf 'abcdef%.0s' {1..80}" }, context);
    expect(result.metadata?.truncated).toBe(true);
    expect(result.content).toContain("[truncated]");
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

    const status = await executeServiceTool({ action: "status", name: "web" }, context);
    expect(status.ok).toBe(true);
    expect(status.content).toContain('"alive": true');

    const logs = await executeServiceTool({ action: "logs", name: "web" }, context);
    expect(logs.ok).toBe(true);
    expect(logs.content).toContain("ready");

    const stop = await executeServiceTool({ action: "stop", name: "web" }, context);
    expect(stop.ok).toBe(true);
  });

  it("preserves keepForVerifier services during pre-verifier cleanup", async () => {
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
        { action: "start", name: "kept", command: "node -e \"setInterval(()=>{}, 1000)\"", keepForVerifier: true },
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
          keepForVerifier: false,
          readinessTimeoutSec: 5
        },
        context
      )
    ).resolves.toMatchObject({ ok: true });

    const cleanup = await cleanupServicesBeforeVerifier();
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
    process.env.AGENT_SERVICE_REGISTRY = path.join(dir, "services.json");
    const logPath = path.join(dir, "not-ready.log");
    const port = await freePort();

    const result = await executeServiceTool(
      {
        action: "start",
        name: "not-ready",
        command: "node -e \"console.error('booting'); setInterval(()=>{}, 1000)\"",
        port,
        logPath,
        readinessTimeoutSec: 0.2
      },
      context
    );

    expect(result.ok).toBe(false);
    await expect(readFile(logPath, "utf8")).resolves.toContain("booting");
  });
});
