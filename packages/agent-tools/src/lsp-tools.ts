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
import type { EvidenceRecord, JsonValue, ToolCallPlan, ToolDescriptor, ToolReceipt, ToolRequest } from "agent-protocol";
import { applyUnifiedPatch } from "./atomic-patch.js";
import type { RegisteredEffectTool } from "./registry.js";

export interface CodeIntelToolOptions {
  broker: ExecutionBroker;
  presets: LanguageServerPreset[];
  additionalReadRoots?: string[];
}

type Operation = "symbols" | "definition" | "references" | "hover" | "diagnostics" | "rename";

function object(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function string(input: Record<string, JsonValue>, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || !value) throw new Error(`Tool argument '${name}' must be a non-empty string.`);
  return value;
}

function operation(input: Record<string, JsonValue>): Operation {
  const value = string(input, "operation");
  if (!["symbols", "definition", "references", "hover", "diagnostics", "rename"].includes(value)) {
    throw new Error(`Unsupported LSP operation '${value}'.`);
  }
  return value as Operation;
}

function position(input: Record<string, JsonValue>): LspPosition {
  const line = input.line;
  const character = input.character;
  if (!Number.isSafeInteger(line) || (line as number) < 0 || !Number.isSafeInteger(character) || (character as number) < 0) {
    throw new Error("line and character must be non-negative integers.");
  }
  return { line: line as number, character: character as number };
}

function languageFor(file: string): string {
  return ({
    ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact",
    ".py": "python", ".rs": "rust", ".go": "go"
  } as Record<string, string>)[path.extname(file).toLowerCase()] ?? "";
}

function selectPreset(presets: LanguageServerPreset[], file: string): LanguageServerPreset {
  const language = languageFor(file);
  const preset = presets.find((candidate) => candidate.available && candidate.languages.includes(language));
  if (preset) return preset;
  const reason = presets.find((candidate) => candidate.languages.includes(language))?.unavailableReason;
  throw Object.assign(new Error(reason ?? `No language server is configured for '${file}'.`), { code: "lsp_unavailable" });
}

function callPlan(value: JsonValue, runMode: "analyze" | "change"): ToolCallPlan {
  const input = object(value);
  const op = operation(input);
  const file = string(input, "file");
  if (op === "rename" && runMode !== "change") throw new Error("LSP rename is available only in change mode.");
  const effects: ToolCallPlan["exactEffects"] = ["filesystem.read", "process.spawn.readonly"];
  if (op === "rename") effects.push("filesystem.write");
  return {
    exactEffects: effects,
    readPaths: [file],
    writePaths: op === "rename" ? ["."] : [],
    network: "none",
    processMode: "background",
    checkpointScope: op === "rename" ? ["."] : [],
    idempotence: op === "rename" ? "non_replayable" : "read_only"
  };
}

function descriptor(): ToolDescriptor {
  return {
    name: "lsp",
    description: "Query a sandboxed language server for symbols, definitions, references, hover, diagnostics, or an atomic rename.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["symbols", "definition", "references", "hover", "diagnostics", "rename"] },
        file: { type: "string" },
        line: { type: "integer", minimum: 0 },
        character: { type: "integer", minimum: 0 },
        newName: { type: "string" }
      },
      required: ["operation", "file"],
      additionalProperties: false
    },
    possibleEffects: ["filesystem.read", "filesystem.write", "process.spawn.readonly"],
    maximumEffects: ["filesystem.read", "filesystem.write", "process.spawn.readonly"],
    availableModes: ["analyze", "change"],
    executionMode: "exclusive",
    resourceKeys: ["workspace:lsp"],
    contextPathArguments: ["file"],
    approval: "prompt",
    idempotent: false,
    timeoutMs: 120_000,
    prepare: (value, context) => callPlan(value, context.runMode)
  };
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

async function query(client: LspClient, op: Operation, input: Record<string, JsonValue>, signal: AbortSignal): Promise<unknown> {
  const file = string(input, "file");
  if (op === "symbols") return await client.symbols(file, signal);
  if (op === "diagnostics") return await client.documentDiagnostics(file, signal);
  const at = position(input);
  if (op === "definition") return await client.definition(file, at, signal);
  if (op === "references") return await client.references(file, at, signal);
  if (op === "hover") return await client.hover(file, at, signal);
  return await client.rename(file, at, string(input, "newName"), signal);
}

function evidence(
  request: ToolRequest,
  op: Operation,
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
  op: Operation,
  output: unknown,
  scope: { sessionId: string; runId: string }
): ToolReceipt {
  const completedAt = new Date().toISOString();
  return {
    callId: request.callId, ok: true, output: JSON.stringify(output),
    observedEffects: ["filesystem.read", "process.spawn.readonly"],
    actualEffects: ["filesystem.read", "process.spawn.readonly"], artifacts: [], diagnostics: [],
    evidence: evidence(request, op, output, completedAt, scope), startedAt, completedAt
  };
}

export function codeIntelTool(options: CodeIntelToolOptions): RegisteredEffectTool {
  return {
    descriptor: descriptor(),
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = object(request.arguments);
      const op = operation(input);
      const preset = selectPreset(options.presets, string(input, "file"));
      const client = new LspClient({
        rootPath: context.workspacePath,
        transport: new BrokerLspTransport({
          broker: options.broker, preset, workspacePath: context.workspacePath,
          additionalReadRoots: options.additionalReadRoots
        })
      });
      try {
        const result = await query(client, op, input, context.signal);
        if (op !== "rename") {
          return receipt(request, startedAt, op, result, { sessionId: context.sessionId, runId: context.runId });
        }
        if (!result) throw new Error("Language server declined the rename.");
        const applied = await applyRename(context.workspacePath, result as LspWorkspaceEdit);
        const completedAt = new Date().toISOString();
        return {
          callId: request.callId, ok: true, output: JSON.stringify(applied),
          observedEffects: ["filesystem.read", "process.spawn.readonly", "filesystem.write"],
          actualEffects: ["filesystem.read", "process.spawn.readonly", "filesystem.write"],
          workspaceDelta: applied.delta, artifacts: [], diagnostics: [], startedAt, completedAt,
          evidence: []
        };
      } finally {
        await client.close();
      }
    }
  };
}
