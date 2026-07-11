import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BrokerLspTransport,
  discoverLanguageServers,
  encodeLspMessage,
  LspClient,
  LspFrameDecoder,
  type LspTransport
} from "../packages/agent-code-intel/src/index.js";
import type {
  ExecutionBroker,
  ProcessHandle,
  ProcessPollResult,
  ProcessSpawnRequest
} from "../packages/agent-execution/src/index.js";
import { codeIntelTool } from "../packages/agent-tools/src/index.js";

class FakeTransport implements LspTransport {
  private readonly decoder = new LspFrameDecoder();
  private readonly queued: Uint8Array[] = [];
  private readonly waiters: Array<(value: IteratorResult<Uint8Array>) => void> = [];
  private closed = false;

  async write(data: Uint8Array): Promise<void> {
    for (const body of this.decoder.push(data)) {
      const message = JSON.parse(body) as { id?: number; method?: string; params?: unknown };
      if (message.method === "initialize") this.push({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
      if (message.method === "textDocument/documentSymbol") {
        this.push({ jsonrpc: "2.0", id: message.id, result: [{ name: "answer", kind: 12 }] });
      }
      if (message.method === "textDocument/definition") {
        this.push({ jsonrpc: "2.0", id: message.id, result: { uri: "file:///fixture.ts", range: range() } });
      }
      if (message.method === "textDocument/references") {
        this.push({ jsonrpc: "2.0", id: message.id, result: [{ uri: "file:///fixture.ts", range: range() }] });
      }
      if (message.method === "textDocument/hover") {
        this.push({ jsonrpc: "2.0", id: message.id, result: { contents: "fixture hover" } });
      }
      if (message.method === "textDocument/rename") {
        this.push({ jsonrpc: "2.0", id: message.id, result: { changes: {} } });
      }
      if (message.method === "textDocument/diagnostic") {
        this.push({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } });
      }
      if (message.method === "shutdown") this.push({ jsonrpc: "2.0", id: message.id, result: null });
      if (message.method === "textDocument/didOpen") {
        const uri = (message.params as { textDocument: { uri: string } }).textDocument.uri;
        this.push({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: { uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "fixture" }] }
        });
      }
    }
  }

  async *chunks(): AsyncIterable<Uint8Array> {
    while (!this.closed || this.queued.length > 0) {
      const value = this.queued.shift();
      if (value) yield value;
      else {
        const next = await new Promise<IteratorResult<Uint8Array>>((resolve) => this.waiters.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  private push(message: unknown): void {
    const bytes = encodeLspMessage(message);
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: bytes });
    else this.queued.push(bytes);
  }
}

function range() {
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
}

class ChildProcessLspTransport implements LspTransport {
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(executable: string, args: string[], cwd: string) {
    this.child = spawn(executable, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.stderr.on("data", () => undefined);
  }

  async write(data: Uint8Array): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(data, (error) => error ? reject(error) : resolve());
    });
  }

  async *chunks(): AsyncIterable<Uint8Array> {
    for await (const chunk of this.child.stdout) yield Buffer.from(chunk as Buffer);
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    if (this.child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 2_000);
      timer.unref();
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 5_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await delay(50);
    value = await read();
  }
  return value;
}

class FakeLspBroker implements ExecutionBroker {
  readonly lostProcessHandles: readonly ProcessHandle[] = [];
  readonly decoder = new LspFrameDecoder();
  readonly output: string[] = [];
  spawnRequest?: ProcessSpawnRequest;

  async connect() { return this.report(); }
  async doctor() { return this.report(); }
  async execute(): Promise<never> { throw new Error("not used"); }
  async spawn(request: ProcessSpawnRequest): Promise<ProcessHandle> {
    this.spawnRequest = request;
    return { id: "lsp", brokerInstanceId: "fixture" };
  }
  async poll(handle: ProcessHandle): Promise<ProcessPollResult> {
    return {
      handle, state: "running", exitCode: null, signal: null, durationMs: 1,
      stdout: this.output.shift() ?? "", stderr: "", stdoutDroppedBytes: 0,
      stderrDroppedBytes: 0, outputTruncated: false
    };
  }
  async write(_handle: ProcessHandle, data: string): Promise<void> {
    for (const body of this.decoder.push(Buffer.from(data))) {
      const message = JSON.parse(body) as { id?: number; method?: string; params?: unknown };
      if (message.method === "initialize") this.respond(message.id, { capabilities: {} });
      if (message.method === "textDocument/documentSymbol") this.respond(message.id, [{ name: "brokered", kind: 12 }]);
      if (message.method === "textDocument/definition") {
        this.respond(message.id, { uri: "file:///definition", range: range() });
      }
      if (message.method === "textDocument/references") {
        this.respond(message.id, [{ uri: "file:///reference", range: range() }]);
      }
      if (message.method === "textDocument/hover") this.respond(message.id, { contents: "brokered hover" });
      if (message.method === "textDocument/diagnostic") this.respond(message.id, { items: [] });
      if (message.method === "textDocument/rename") {
        const uri = (message.params as { textDocument: { uri: string } }).textDocument.uri;
        this.respond(message.id, { changes: { [uri]: [
          { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }, newText: "newName" },
          { range: { start: { line: 1, character: 12 }, end: { line: 1, character: 19 } }, newText: "newName" }
        ] } });
      }
      if (message.method === "shutdown") this.respond(message.id, null);
    }
  }
  async terminate(handle: ProcessHandle): Promise<ProcessPollResult> {
    return { ...(await this.poll(handle)), state: "terminated", signal: "SIGTERM" };
  }
  async close(): Promise<void> {}

  private respond(id: number | undefined, result: unknown): void {
    this.output.push(Buffer.from(encodeLspMessage({ jsonrpc: "2.0", id, result })).toString("utf8"));
  }
  private report() {
    return {
      protocolVersion: 1 as const, brokerVersion: "fixture", platform: process.platform,
      architecture: process.arch,
      sandbox: { available: true, backend: "fixture", selfTestPassed: true, setupRequired: false },
      capabilities: { foreground: true, background: true, stdin: true, pty: false, networkModes: ["none" as const] }
    };
  }
}

describe("agent-code-intel", () => {
  it("frames messages across arbitrary chunks", () => {
    const frame = Buffer.from(encodeLspMessage({ jsonrpc: "2.0", id: 1, result: "ok" }));
    const decoder = new LspFrameDecoder();
    expect(decoder.push(frame.subarray(0, 7))).toEqual([]);
    expect(decoder.push(frame.subarray(7))).toEqual([JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" })]);
    expect(() => new LspFrameDecoder().push(Buffer.alloc(64 * 1024 + 1, 65))).toThrow(/header exceeds/u);
    expect(() => new LspFrameDecoder().push(Buffer.from(
      `Content-Length: ${16 * 1024 * 1024 + 1}\r\n\r\n`, "ascii"
    ))).toThrow(/oversized/u);
  });

  it("initializes, opens a document and consumes symbols and diagnostics", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-lsp-"));
    await writeFile(path.join(workspace, "fixture.ts"), "const answer = 42;", "utf8");
    const client = new LspClient({ rootPath: workspace, transport: new FakeTransport() });
    await expect(client.symbols("fixture.ts")).resolves.toEqual([{ name: "answer", kind: 12 }]);
    await expect(client.definition("fixture.ts", { line: 0, character: 7 })).resolves.toMatchObject({ uri: "file:///fixture.ts" });
    await expect(client.references("fixture.ts", { line: 0, character: 7 })).resolves.toHaveLength(1);
    await expect(client.hover("fixture.ts", { line: 0, character: 7 })).resolves.toMatchObject({ contents: "fixture hover" });
    await expect(client.rename("fixture.ts", { line: 0, character: 7 }, "renamed")).resolves.toEqual({ changes: {} });
    await expect(client.documentDiagnostics("fixture.ts")).resolves.toMatchObject([{ message: "fixture" }]);
    await client.close();
  });

  it("settles the registered response when an LSP write fails", async () => {
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => { stop = resolve; });
    const transport: LspTransport = {
      async write() { throw new Error("fixture write failed"); },
      chunks() {
        return {
          [Symbol.asyncIterator]() {
            return { async next() { await stopped; return { done: true, value: undefined }; } };
          }
        };
      },
      async close() { stop(); }
    };
    const client = new LspClient({ rootPath: process.cwd(), transport });
    await expect(client.start()).rejects.toThrow("fixture write failed");
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("rejects language-server input that resolves outside the workspace through a link", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-lsp-contained-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "sigma-lsp-outside-"));
    await writeFile(path.join(outside, "secret.ts"), "export const secret = 'host';", "utf8");
    await symlink(outside, path.join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
    const client = new LspClient({ rootPath: workspace, transport: new FakeTransport() });
    await expect(client.symbols("linked/secret.ts")).rejects.toThrow(/resolves outside workspace/u);
    await client.close();
  });

  it("exercises all navigation operations against the bundled TypeScript server", async () => {
    const preset = discoverLanguageServers().find((item) => item.id === "typescript");
    expect(preset?.available).toBe(true);
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-lsp-real-ts-"));
    await writeFile(path.join(workspace, "fixture.ts"), [
      "export const answer: number = 42;",
      "export function readAnswer(): number { return answer; }",
      "const invalid: string = answer;",
      ""
    ].join("\n"), "utf8");
    const transport = new ChildProcessLspTransport(preset!.executable, [...preset!.args], workspace);
    const client = new LspClient({ rootPath: workspace, transport, requestTimeoutMs: 15_000 });
    const position = { line: 1, character: 47 };
    expect(await client.symbols("fixture.ts")).toBeTruthy();
    expect(await client.definition("fixture.ts", position)).toBeTruthy();
    expect((await client.references("fixture.ts", position)).length).toBeGreaterThanOrEqual(2);
    expect(await client.hover("fixture.ts", position)).toBeTruthy();
    expect(await client.rename("fixture.ts", position, "resolvedAnswer")).toBeTruthy();
    await client.close();
  });

  it("uses tsconfig paths for inverse references and preserves shorthand rename semantics", async () => {
    const preset = discoverLanguageServers().find((item) => item.id === "typescript");
    expect(preset?.available).toBe(true);
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-lsp-project-ts-"));
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "tsconfig.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/*"] }, strict: true },
      include: ["src/**/*.ts"]
    }), "utf8");
    await writeFile(path.join(workspace, "src", "value.ts"), "export const answer = 42;\n", "utf8");
    await writeFile(path.join(workspace, "src", "consumer.ts"), [
      "import { answer } from \"@lib/value\";",
      "export const payload = { answer };",
      ""
    ].join("\n"), "utf8");
    const transport = new ChildProcessLspTransport(preset!.executable, [...preset!.args], workspace);
    const client = new LspClient({ rootPath: workspace, transport, requestTimeoutMs: 15_000 });
    const references = await client.references("src/value.ts", { line: 0, character: 14 });
    expect(references.some((item) => item.uri.endsWith("/consumer.ts"))).toBe(true);
    const edit = await client.rename("src/consumer.ts", { line: 1, character: 26 }, "renamedAnswer");
    expect(JSON.stringify(edit)).toContain("answer: renamedAnswer");
    await expect(client.rename("src/consumer.ts", { line: 1, character: 26 }, "x y"))
      .rejects.toThrow(/valid TypeScript identifier/u);
    await client.close();
    await writeFile(path.join(workspace, "tsconfig.json"), JSON.stringify({
      extends: "./missing.json",
      include: ["src/**/*.ts"]
    }), "utf8");
    const invalidTransport = new ChildProcessLspTransport(preset!.executable, [...preset!.args], workspace);
    const invalidClient = new LspClient({ rootPath: workspace, transport: invalidTransport, requestTimeoutMs: 15_000 });
    await expect(invalidClient.rename("src/consumer.ts", { line: 1, character: 26 }, "stillValid"))
      .rejects.toThrow(/missing\.json|not found/u);
    await invalidClient.close();
  });

  it("collects real bundled Pyright diagnostics", async () => {
    const preset = discoverLanguageServers().find((item) => item.id === "python");
    expect(preset?.available).toBe(true);
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-lsp-real-pyright-"));
    await writeFile(path.join(workspace, "fixture.py"), "value: str = 42\n", "utf8");
    const transport = new ChildProcessLspTransport(preset!.executable, [...preset!.args], workspace);
    const client = new LspClient({ rootPath: workspace, transport, requestTimeoutMs: 15_000 });
    const diagnostics = await eventually(
      async () => await client.documentDiagnostics("fixture.py"),
      (items) => items.some((item) => item.message.includes("Literal[42]"))
    );
    expect(diagnostics.some((item) => item.message.includes("Literal[42]"))).toBe(true);
    await client.close();
  });

  it("discovers bundled and PATH presets without installing anything", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-lsp-bundle-"));
    await mkdir(path.join(root, "typescript"), { recursive: true });
    await mkdir(path.join(root, "pyright"), { recursive: true });
    await writeFile(path.join(root, "pyright", "langserver.index.js"), "", "utf8");
    const pathDirectory = path.join(root, "bin");
    await mkdir(pathDirectory);
    const suffix = process.platform === "win32" ? ".exe" : "";
    await writeFile(path.join(pathDirectory, `rust-analyzer${suffix}`), "", "utf8");

    const presets = discoverLanguageServers({ bundledRoot: root, pathValue: pathDirectory });
    const typescript = presets.find((item) => item.id === "typescript");
    expect(typescript?.available).toBe(true);
    expect(typescript?.args.slice(0, 3)).toEqual(["--preserve-symlinks", "--input-type=module", "--eval"]);
    expect(typescript?.args).toContain(path.resolve("packages", "agent-code-intel", "src", "typescript-server.mjs"));
    const python = presets.find((item) => item.id === "python");
    expect(python?.available).toBe(true);
    expect(python?.args[0]).toBe("--debug-port=0");
    expect(presets.find((item) => item.id === "rust")?.available).toBe(true);
    expect(presets.find((item) => item.id === "go")?.available).toBe(false);
  });

  it("runs language-server stdio through a read-only offline broker policy", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-lsp-broker-"));
    await writeFile(path.join(workspace, "fixture.ts"), "const brokered = true;", "utf8");
    const broker = new FakeLspBroker();
    const transport = new BrokerLspTransport({
      broker,
      workspacePath: workspace,
      pollIntervalMs: 5,
      preset: {
        id: "typescript", languages: ["typescript"], executable: process.execPath,
        args: ["server.mjs", "--stdio"], source: "configured", available: true
      }
    });
    const client = new LspClient({ rootPath: workspace, transport, requestTimeoutMs: 1_000 });
    await expect(client.symbols("fixture.ts")).resolves.toEqual([{ name: "brokered", kind: 12 }]);
    expect(broker.spawnRequest?.policy).toMatchObject({ sandbox: "required", network: "none", writeRoots: [] });
    expect(broker.spawnRequest).toMatchObject({
      maxOutputBytes: 64 * 1024 * 1024,
      outputRedaction: "framed_jsonrpc"
    });
    const declaredReadRoots = JSON.parse(
      broker.spawnRequest?.command.environment?.overrides?.SIGMA_LSP_READ_ROOTS ?? "[]"
    ) as string[];
    expect(declaredReadRoots).toEqual(expect.arrayContaining([
      path.resolve(workspace), path.dirname(process.execPath)
    ]));
    await client.close();
  });

  it("applies an LSP rename as one atomic workspace patch", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-lsp-rename-"));
    const target = path.join(workspace, "fixture.ts");
    await writeFile(target, "const oldName = 1;\nconsole.log(oldName);\n", "utf8");
    const broker = new FakeLspBroker();
    const tool = codeIntelTool({
      broker,
      presets: [{
        id: "typescript", languages: ["typescript"], executable: process.execPath,
        args: ["server.mjs", "--stdio"], source: "configured", available: true
      }]
    });
    const controller = new AbortController();
    const receipt = await tool.execute({
      callId: "rename", name: "lsp",
      arguments: { operation: "rename", file: "fixture.ts", line: 0, character: 8, newName: "newName" }
    }, {
      sessionId: "session", runId: "run", workspacePath: workspace, runMode: "change",
      signal: controller.signal, heartbeat() {}, progress: async () => undefined,
      createArtifact: async () => "artifact"
    });
    expect(receipt.ok).toBe(true);
    expect(receipt.workspaceDelta).toEqual({ added: [], modified: ["fixture.ts"], deleted: [] });
    expect(await readFile(target, "utf8")).toBe("const newName = 1;\nconsole.log(newName);\n");
  });

  it.each([
    ["rust", "rs"],
    ["go", "go"]
  ])("covers every LSP operation through a configured fake %s server", async (language, extension) => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), `sigma-lsp-fake-${language}-`));
    const file = `fixture.${extension}`;
    await writeFile(path.join(workspace, file), "const oldName = 1;\nconsole.log(oldName);\n", "utf8");
    const broker = new FakeLspBroker();
    const tool = codeIntelTool({
      broker,
      presets: [{
        id: language, languages: [language], executable: process.execPath,
        args: ["server.mjs", "--stdio"], source: "configured", available: true
      }]
    });
    const controller = new AbortController();
    const execute = async (operation: string, runMode: "analyze" | "change" = "analyze") =>
      await tool.execute({
        callId: `${language}-${operation}`,
        name: "lsp",
        arguments: {
          operation, file,
          ...(operation === "symbols" || operation === "diagnostics" ? {} : { line: 0, character: 6 }),
          ...(operation === "rename" ? { newName: "newName" } : {})
        }
      }, {
        sessionId: "session", runId: "run", workspacePath: workspace, runMode,
        signal: controller.signal, heartbeat() {}, progress: async () => undefined,
        createArtifact: async () => "artifact"
      });
    for (const operation of ["symbols", "definition", "references", "hover", "diagnostics"]) {
      await expect(execute(operation)).resolves.toMatchObject({ ok: true });
    }
    await expect(execute("rename", "change")).resolves.toMatchObject({ ok: true });
    await expect(readFile(path.join(workspace, file), "utf8"))
      .resolves.toBe("const newName = 1;\nconsole.log(newName);\n");
  });
});
