import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { encodeLspMessage, LspFrameDecoder } from "./framing.js";
import type {
  LspClientOptions,
  LspDiagnostic,
  LspLocation,
  LspPosition,
  LspTransport,
  LspWorkspaceEdit
} from "./types.js";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

function languageId(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact",
    ".py": "python", ".rs": "rust", ".go": "go"
  } as Record<string, string>)[extension] ?? "plaintext";
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class LspClient {
  private readonly rootPath: string;
  private readonly transport: LspTransport;
  private readonly requestTimeoutMs: number;
  private readonly clientName: string;
  private readonly onNotification?: (method: string, params: unknown) => void;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly diagnostics = new Map<string, LspDiagnostic[]>();
  private readonly opened = new Set<string>();
  private nextId = 1;
  private pump?: Promise<void>;
  private initialized = false;
  private closed = false;

  constructor(options: LspClientOptions) {
    this.rootPath = path.resolve(options.rootPath);
    this.transport = options.transport;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.clientName = options.clientName ?? "sigma-code";
    this.onNotification = options.onNotification;
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return;
    if (this.closed) throw new Error("LSP client is closed.");
    this.pump = this.readLoop(signal);
    await this.request("initialize", {
      processId: process.pid,
      clientInfo: { name: this.clientName, version: "3.0.0" },
      rootUri: pathToFileURL(this.rootPath).href,
      capabilities: {
        textDocument: {
          documentSymbol: {}, definition: {}, references: {}, hover: {}, rename: {}, publishDiagnostics: {}
        },
        workspace: { workspaceEdit: { documentChanges: true } }
      },
      workspaceFolders: [{ uri: pathToFileURL(this.rootPath).href, name: path.basename(this.rootPath) }]
    }, signal);
    await this.notify("initialized", {}, signal);
    this.initialized = true;
  }

  async symbols(filePath: string, signal?: AbortSignal): Promise<unknown> {
    const uri = await this.open(filePath, signal);
    return await this.request("textDocument/documentSymbol", { textDocument: { uri } }, signal);
  }

  async definition(filePath: string, position: LspPosition, signal?: AbortSignal): Promise<LspLocation | LspLocation[] | null> {
    return await this.positionRequest("textDocument/definition", filePath, position, signal) as LspLocation | LspLocation[] | null;
  }

  async references(filePath: string, position: LspPosition, signal?: AbortSignal): Promise<LspLocation[]> {
    return await this.positionRequest("textDocument/references", filePath, position, signal, {
      context: { includeDeclaration: true }
    }) as LspLocation[];
  }

  async hover(filePath: string, position: LspPosition, signal?: AbortSignal): Promise<unknown> {
    return await this.positionRequest("textDocument/hover", filePath, position, signal);
  }

  async rename(filePath: string, position: LspPosition, newName: string, signal?: AbortSignal): Promise<LspWorkspaceEdit | null> {
    return await this.positionRequest("textDocument/rename", filePath, position, signal, { newName }) as LspWorkspaceEdit | null;
  }

  async documentDiagnostics(filePath: string, signal?: AbortSignal): Promise<LspDiagnostic[]> {
    const uri = await this.open(filePath, signal);
    try {
      const report = await this.request("textDocument/diagnostic", { textDocument: { uri } }, signal) as { items?: LspDiagnostic[] };
      if (Array.isArray(report?.items)) this.diagnostics.set(uri, report.items);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== -32601) throw error;
    }
    return [...(this.diagnostics.get(uri) ?? [])];
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.initialized) {
      await this.request("shutdown", null).catch(() => undefined);
      await this.notify("exit", {}).catch(() => undefined);
    }
    this.closed = true;
    await this.transport.close();
    await this.pump?.catch(() => undefined);
    this.failPending(new Error("LSP client closed."));
  }

  private async positionRequest(
    method: string,
    filePath: string,
    position: LspPosition,
    signal?: AbortSignal,
    extra: Record<string, unknown> = {}
  ): Promise<unknown> {
    const uri = await this.open(filePath, signal);
    return await this.request(method, { textDocument: { uri }, position, ...extra }, signal);
  }

  private async open(filePath: string, signal?: AbortSignal): Promise<string> {
    await this.start(signal);
    const root = await realpath(this.rootPath);
    const requested = path.resolve(root, filePath);
    if (!isContained(root, requested)) throw new Error(`LSP path escapes workspace: ${filePath}`);
    const info = await lstat(requested);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`LSP path is not a regular workspace file: ${filePath}`);
    }
    const target = await realpath(requested);
    if (!isContained(root, target)) throw new Error(`LSP path resolves outside workspace: ${filePath}`);
    const uri = pathToFileURL(target).href;
    if (this.opened.has(uri)) return uri;
    const text = await readFile(target, "utf8");
    await this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: languageId(target), version: 1, text }
    }, signal);
    this.opened.add(uri);
    return uri;
  }

  private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error("LSP client is closed.");
    signal?.throwIfAborted();
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`LSP request '${method}' timed out.`), { code: "lsp_timeout" }));
      }, this.requestTimeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
    const onAbort = (): void => {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(signal?.reason ?? new Error("LSP request cancelled."));
      void this.notify("$/cancelRequest", { id }).catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await this.send({ jsonrpc: "2.0", id, method, params }, signal);
      return await response;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async notify(method: string, params: unknown, signal?: AbortSignal): Promise<void> {
    await this.send({ jsonrpc: "2.0", method, params }, signal);
  }

  private async send(message: unknown, signal?: AbortSignal): Promise<void> {
    await this.transport.write(encodeLspMessage(message), signal);
  }

  private async readLoop(signal?: AbortSignal): Promise<void> {
    const decoder = new LspFrameDecoder();
    try {
      for await (const chunk of this.transport.chunks(signal)) {
        for (const body of decoder.push(chunk)) this.receive(JSON.parse(body) as Record<string, unknown>);
      }
      if (!this.closed) this.failPending(Object.assign(new Error("Language server exited."), { code: "lsp_server_exited" }));
    } catch (error) {
      this.failPending(error);
      if (!this.closed) throw error;
    }
  }

  private receive(message: Record<string, unknown>): void {
    if (typeof message.id === "number" && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const rpc = message.error as RpcError;
        pending.reject(Object.assign(new Error(rpc.message), { code: rpc.code, data: rpc.data }));
      } else pending.resolve(message.result);
      return;
    }
    if (typeof message.id === "number" && typeof message.method === "string") {
      this.respondToServerRequest(message.id, message.method, message.params);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as { uri?: unknown; diagnostics?: unknown };
      if (typeof params?.uri === "string" && Array.isArray(params.diagnostics)) {
        this.diagnostics.set(params.uri, params.diagnostics as LspDiagnostic[]);
      }
    }
    if (typeof message.method === "string") this.onNotification?.(message.method, message.params);
  }

  private respondToServerRequest(id: number, method: string, params: unknown): void {
    let result: unknown;
    if (method === "workspace/configuration") {
      const items = (params as { items?: unknown } | undefined)?.items;
      result = Array.isArray(items) ? items.map(() => ({})) : [];
    } else if (method === "workspace/workspaceFolders") {
      result = [{ uri: pathToFileURL(this.rootPath).href, name: path.basename(this.rootPath) }];
    } else if ([
      "client/registerCapability", "client/unregisterCapability", "window/workDoneProgress/create"
    ].includes(method)) {
      result = null;
    } else {
      void this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported client method '${method}'.` } })
        .catch((error) => this.failPending(error));
      return;
    }
    void this.send({ jsonrpc: "2.0", id, result }).catch((error) => this.failPending(error));
  }

  private failPending(error: unknown): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
