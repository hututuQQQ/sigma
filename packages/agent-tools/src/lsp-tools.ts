import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BrokerLspTransport,
  LspClient,
  type LanguageServerPreset,
  type LspPosition,
  type LspTextEdit,
  type LspWorkspaceEdit
} from "agent-code-intel";
import type { ExecutionBroker } from "agent-execution";
import type { EvidenceRecord, JsonValue, ToolReceipt, ToolRequest } from "agent-protocol";
import { applyUnifiedPatch } from "./atomic-patch.js";
import {
  lspObject,
  lspOperation,
  lspPosition,
  lspString,
  lspToolDescriptor,
  selectLspPreset,
  type LspOperation
} from "./lsp-tool-definition.js";
import type { RegisteredEffectTool } from "./registry.js";

export interface CodeIntelToolOptions {
  broker: ExecutionBroker;
  presets: LanguageServerPreset[];
  additionalReadRoots?: string[];
}

interface PooledLspClient {
  client: LspClient;
  users: number;
  discard: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

interface LspClientLease {
  client: LspClient;
  release(discard?: boolean): void;
}

// Model turns routinely take longer than a second. Keep the indexed server
// warm across several tool turns so navigation does not repeatedly pay the
// spawn, project discovery, and indexing cost.
const LSP_CLIENT_IDLE_TIMEOUT_MS = 120_000;
const LSP_FAILURE_COOLDOWN_MS = 60_000;

interface LspFailureCooldown {
  until: number;
  message: string;
}

class LspClientPool {
  private readonly clients = new Map<string, PooledLspClient>();
  private readonly cooldowns = new Map<string, LspFailureCooldown>();

  constructor(private readonly options: CodeIntelToolOptions) {}

  private key(workspacePath: string, preset: LanguageServerPreset): string {
    return [
      path.resolve(workspacePath),
      preset.id,
      path.resolve(preset.executable),
      ...preset.args
    ].join("\0");
  }

  acquire(workspacePath: string, preset: LanguageServerPreset): LspClientLease {
    const key = this.key(workspacePath, preset);
    const cooldown = this.cooldowns.get(key);
    if (cooldown && cooldown.until > Date.now()) {
      throw Object.assign(new Error(
        `Language server '${preset.id}' is temporarily unavailable after exiting: ${cooldown.message}`
      ), { code: "lsp_temporarily_unavailable" });
    }
    if (cooldown) this.cooldowns.delete(key);
    let entry = this.clients.get(key);
    if (!entry) {
      entry = {
        client: new LspClient({
          rootPath: workspacePath,
          transport: new BrokerLspTransport({
            broker: this.options.broker,
            preset,
            workspacePath,
            additionalReadRoots: this.options.additionalReadRoots
          })
        }),
        users: 0,
        discard: false
      };
      this.clients.set(key, entry);
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    entry.users += 1;
    let released = false;
    return {
      client: entry.client,
      release: (discard = false) => {
        if (released) return;
        released = true;
        entry!.users -= 1;
        if (discard) {
          entry!.discard = true;
          if (this.clients.get(key) === entry) this.clients.delete(key);
        }
        if (entry!.users > 0) return;
        if (entry!.discard) {
          this.close(entry!.client);
          return;
        }
        entry!.idleTimer = setTimeout(() => {
          if (entry!.users > 0 || this.clients.get(key) !== entry) return;
          this.clients.delete(key);
          this.close(entry!.client);
        }, LSP_CLIENT_IDLE_TIMEOUT_MS);
        entry!.idleTimer.unref();
      }
    };
  }

  recordFailure(workspacePath: string, preset: LanguageServerPreset, error: unknown): void {
    if ((error as { code?: unknown } | undefined)?.code !== "lsp_server_exited") return;
    this.cooldowns.set(this.key(workspacePath, preset), {
      until: Date.now() + LSP_FAILURE_COOLDOWN_MS,
      message: error instanceof Error ? error.message : String(error)
    });
  }

  private close(client: LspClient): void {
    void client.close().catch(() => undefined);
  }
}

function offsetAt(content: string, value: LspPosition): number {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) if (content[index] === "\n") starts.push(index + 1);
  const start = starts[value.line];
  if (start === undefined) throw new Error(`LSP edit line ${value.line} is outside the document.`);
  let end = content.indexOf("\n", start);
  if (end < 0) end = content.length;
  if (end > start && content[end - 1] === "\r") end -= 1;
  const result = start + value.character;
  if (result > end) throw new Error(`LSP edit character ${value.character} is outside line ${value.line}.`);
  return result;
}

function applyTextEdits(content: string, edits: LspTextEdit[]): string {
  const ranges = edits.map((edit) => ({
    edit,
    start: offsetAt(content, edit.range.start),
    end: offsetAt(content, edit.range.end)
  })).sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]!.start < ranges[index - 1]!.end) throw new Error("Language server returned overlapping rename edits.");
  }
  let output = content;
  for (const item of ranges.reverse()) output = `${output.slice(0, item.start)}${item.edit.newText}${output.slice(item.end)}`;
  return output;
}

function patchLines(content: string): string[] {
  const normalized = content.replaceAll("\r\n", "\n");
  if (!normalized) return [];
  return (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
}

function fullFilePatch(relative: string, before: string, after: string): string {
  const oldLines = patchLines(before);
  const newLines = patchLines(after);
  return [
    `diff --git a/${relative} b/${relative}`,
    `--- a/${relative}`,
    `+++ b/${relative}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`)
  ].join("\n");
}

function collectWorkspaceEdits(edit: LspWorkspaceEdit): Map<string, LspTextEdit[]> {
  const result = new Map<string, LspTextEdit[]>();
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) result.set(uri, [...edits]);
  for (const raw of edit.documentChanges ?? []) {
    if (!raw || typeof raw !== "object" || !("textDocument" in raw) || !("edits" in raw)) {
      throw new Error("Language server returned an unsupported workspace resource operation.");
    }
    const item = raw as { textDocument?: { uri?: unknown }; edits?: unknown };
    if (typeof item.textDocument?.uri !== "string" || !Array.isArray(item.edits)) throw new Error("Malformed LSP document edit.");
    result.set(item.textDocument.uri, [...(result.get(item.textDocument.uri) ?? []), ...(item.edits as LspTextEdit[])]);
  }
  return result;
}

async function safeWorkspaceFile(workspace: string, uri: string): Promise<string> {
  const absolute = fileURLToPath(uri);
  const root = await realpath(workspace);
  const relative = path.relative(root, absolute).replaceAll("\\", "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)
    || relative === ".git" || relative.startsWith(".git/") || relative === ".agent" || relative.startsWith(".agent/")) {
    throw new Error(`LSP edit escapes or targets a protected workspace path: ${uri}`);
  }
  let current = root;
  for (const component of relative.split("/")) {
    current = path.join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`LSP edit targets a symbolic-link path: ${uri}`);
  }
  const target = await realpath(current);
  const canonicalRelative = path.relative(root, target);
  if (canonicalRelative.startsWith("..") || path.isAbsolute(canonicalRelative)) {
    throw new Error(`LSP edit resolves outside the workspace: ${uri}`);
  }
  const targetInfo = await lstat(target);
  if (!targetInfo.isFile()) throw new Error(`LSP edit target is not a regular file: ${uri}`);
  return relative;
}

async function applyRename(workspace: string, edit: LspWorkspaceEdit): Promise<Awaited<ReturnType<typeof applyUnifiedPatch>>> {
  const patches: string[] = [];
  for (const [uri, edits] of collectWorkspaceEdits(edit)) {
    const relative = await safeWorkspaceFile(workspace, uri);
    const before = await readFile(path.join(workspace, ...relative.split("/")), "utf8");
    const after = applyTextEdits(before, edits);
    if (after !== before) patches.push(fullFilePatch(relative, before, after));
  }
  if (patches.length === 0) throw new Error("Language server returned no rename edits.");
  return await applyUnifiedPatch(workspace, patches.join("\n"));
}

async function query(client: LspClient, op: LspOperation, input: Record<string, JsonValue>, signal: AbortSignal): Promise<unknown> {
  const file = lspString(input, "file");
  if (op === "symbols") return await client.symbols(file, signal);
  if (op === "workspace_symbols") {
    const result = await client.workspaceSymbols(file, lspString(input, "query"), signal);
    return Array.isArray(result) ? result.slice(0, 100) : result;
  }
  if (op === "diagnostics") return await client.documentDiagnostics(file, signal);
  const at = lspPosition(input);
  if (op === "definition") return await client.definition(file, at, signal);
  if (op === "references") return await client.references(file, at, signal);
  if (op === "hover") return await client.hover(file, at, signal);
  return await client.rename(file, at, lspString(input, "newName"), signal);
}

function evidence(
  request: ToolRequest,
  op: LspOperation,
  output: unknown,
  completedAt: string,
  scope: { sessionId: string; runId: string }
): EvidenceRecord[] {
  if (op !== "diagnostics") return [];
  return [{
    evidenceId: randomUUID(), sessionId: scope.sessionId, runId: scope.runId,
    kind: "diagnostic", status: "informational", createdAt: completedAt,
    producer: { authority: "tool", id: request.callId }, summary: "Collected language-server diagnostics.",
    data: { source: "lsp", diagnostic: JSON.parse(JSON.stringify(output)) as JsonValue }
  }];
}

function receipt(
  request: ToolRequest,
  startedAt: string,
  op: LspOperation,
  output: unknown,
  scope: { sessionId: string; runId: string }
): ToolReceipt {
  const completedAt = new Date().toISOString();
  const outputText = JSON.stringify(output);
  return {
    callId: request.callId, ok: true, output: outputText,
    outcome: { status: "succeeded", output: outputText, diagnosticCodes: [] },
    observedEffects: ["filesystem.read", "process.spawn.readonly"],
    actualEffects: ["filesystem.read", "process.spawn.readonly"], artifacts: [], diagnostics: [],
    evidence: evidence(request, op, output, completedAt, scope), startedAt, completedAt
  };
}

export function codeIntelTool(options: CodeIntelToolOptions): RegisteredEffectTool {
  const clients = new LspClientPool(options);
  return {
    descriptor: lspToolDescriptor(),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = lspObject(request.arguments);
      const op = lspOperation(input);
      const preset = selectLspPreset(options.presets, lspString(input, "file"));
      const lease = clients.acquire(context.workspacePath, preset);
      let discard = true;
      try {
        const result = await query(lease.client, op, input, context.signal);
        if (op !== "rename") {
          discard = false;
          return receipt(request, startedAt, op, result, { sessionId: context.sessionId, runId: context.runId });
        }
        if (!result) throw new Error("Language server declined the rename.");
        const applied = await applyRename(context.workspacePath, result as LspWorkspaceEdit);
        const completedAt = new Date().toISOString();
        const output = JSON.stringify(applied);
        discard = false;
        return {
          callId: request.callId, ok: true, output,
          outcome: { status: "succeeded", output, diagnosticCodes: [] },
          observedEffects: ["filesystem.read", "process.spawn.readonly", "filesystem.write"],
          actualEffects: ["filesystem.read", "process.spawn.readonly", "filesystem.write"],
          workspaceDelta: applied.delta, artifacts: [], diagnostics: [], startedAt, completedAt,
          evidence: []
        };
      } catch (error) {
        clients.recordFailure(context.workspacePath, preset, error);
        throw error;
      } finally {
        lease.release(discard);
      }
    }
  };
}
