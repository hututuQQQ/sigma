import path from "node:path";
import type { LanguageServerPreset, LspPosition } from "agent-code-intel";
import type { JsonValue, ToolCallPlan, ToolDescriptor } from "agent-protocol";

export type LspOperation =
  | "symbols" | "workspace_symbols" | "definition" | "references"
  | "hover" | "diagnostics" | "rename";

const operations: LspOperation[] = [
  "symbols", "workspace_symbols", "definition", "references", "hover", "diagnostics", "rename"
];

export function lspObject(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function lspString(input: Record<string, JsonValue>, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || !value) {
    throw new Error(`Tool argument '${name}' must be a non-empty string.`);
  }
  return value;
}

export function lspOperation(input: Record<string, JsonValue>): LspOperation {
  const value = lspString(input, "operation");
  if (!operations.includes(value as LspOperation)) {
    throw new Error(`Unsupported LSP operation '${value}'.`);
  }
  return value as LspOperation;
}

export function lspPosition(input: Record<string, JsonValue>): LspPosition {
  const line = input.line;
  const character = input.character;
  if (!Number.isSafeInteger(line) || (line as number) < 0
    || !Number.isSafeInteger(character) || (character as number) < 0) {
    throw new Error("line and character must be non-negative integers.");
  }
  return { line: line as number, character: character as number };
}

function languageFor(file: string): string {
  return ({
    ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact",
    ".mts": "typescript", ".cts": "typescript", ".mjs": "javascript", ".cjs": "javascript",
    ".py": "python", ".rs": "rust", ".go": "go"
  } as Record<string, string>)[path.extname(file).toLowerCase()] ?? "";
}

export function selectLspPreset(
  presets: LanguageServerPreset[],
  file: string
): LanguageServerPreset {
  const language = languageFor(file);
  const preset = presets.find((candidate) =>
    candidate.available && candidate.languages.includes(language));
  if (preset) return preset;
  const reason = presets.find((candidate) =>
    candidate.languages.includes(language))?.unavailableReason;
  throw Object.assign(new Error(
    reason ?? `No language server is configured for '${file}'.`
  ), { code: "lsp_unavailable" });
}

function callPlan(value: JsonValue, runMode: "analyze" | "change"): ToolCallPlan {
  const input = lspObject(value);
  const op = lspOperation(input);
  const file = lspString(input, "file");
  if (op === "workspace_symbols") lspString(input, "query");
  if (op === "rename" && runMode !== "change") {
    throw new Error("LSP rename is available only in change mode.");
  }
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

export function lspToolDescriptor(): ToolDescriptor {
  return {
    name: "lsp",
    description: "Query a sandboxed language server. Use workspace_symbols with a representative file and query to locate declarations across the project before broad text search; use symbols for one file, then definition, references, hover, diagnostics, or an atomic rename.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: operations },
        file: { type: "string" },
        query: { type: "string" },
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
    executionMode: "parallel",
    resourceKeys: [],
    contextPathArguments: ["file"],
    // Read operations are auto-approved when policy allows; rename still has
    // an exact filesystem.write plan and therefore retains per-call approval.
    approval: "auto",
    idempotent: false,
    workspaceDeltaAuthority: "structured_tool_receipt",
    timeoutMs: 120_000,
    prepare: (value, context) => callPlan(value, context.runMode)
  };
}
