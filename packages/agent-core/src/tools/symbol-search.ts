import { truncateMiddle } from "../compaction.js";
import { getCodeIndexForTool, type CodeSymbol } from "../context/code-index.js";
import type { ToolExecutionContext, ToolResult } from "../types.js";

interface SymbolSearchArgs {
  query?: unknown;
  kind?: unknown;
  path?: unknown;
  maxResults?: unknown;
  maxChars?: unknown;
}

interface SymbolSearchMatch {
  path: string;
  name: string;
  kind: CodeSymbol["kind"];
  line: number;
  score: number;
  exported: boolean;
}

function numberOrDefault(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9_$.-]+/).map((token) => token.trim()).filter((token) => token.length >= 2))];
}

function scoreSymbol(symbol: CodeSymbol, filePath: string, tokens: string[]): number {
  const name = symbol.name.toLowerCase();
  const lowerPath = filePath.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (name === token) score += 50;
    else if (name.includes(token)) score += 24;
    if (lowerPath.includes(token)) score += 8;
  }
  if (symbol.exported && score > 0) score += 5;
  return score;
}

export async function executeSymbolSearchTool(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  const parsed = (args && typeof args === "object" ? args : {}) as SymbolSearchArgs;
  if (typeof parsed.query !== "string" || parsed.query.trim().length === 0) {
    return { ok: false, content: "symbol_search requires a non-empty query string" };
  }
  const tokens = tokenize(parsed.query);
  if (tokens.length === 0) return { ok: false, content: "symbol_search query did not contain searchable tokens" };
  const kind = typeof parsed.kind === "string" && parsed.kind.length > 0 ? parsed.kind : null;
  const requestedPath = typeof parsed.path === "string" && parsed.path.length > 0 ? parsed.path : ".";
  const maxResults = numberOrDefault(parsed.maxResults, 20, 1, 100);
  const maxChars = numberOrDefault(parsed.maxChars, context.maxToolOutputChars, 500, 50000);

  try {
    const index = await getCodeIndexForTool(context, { path: requestedPath });
    const matches: SymbolSearchMatch[] = [];
    for (const file of index.files) {
      for (const symbol of file.symbols) {
        if (kind && symbol.kind !== kind) continue;
        const score = scoreSymbol(symbol, file.path, tokens);
        if (score <= 0) continue;
        matches.push({
          path: file.path,
          name: symbol.name,
          kind: symbol.kind,
          line: symbol.line,
          score,
          exported: symbol.exported
        });
      }
    }
    matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, "en") || a.line - b.line);
    const selected = matches.slice(0, maxResults);
    const content = JSON.stringify(
      {
        query: parsed.query,
        matches: selected,
        truncated: index.truncated || matches.length > selected.length
      },
      null,
      2
    );
    const truncated = truncateMiddle(content, maxChars);
    return {
      ok: true,
      content: truncated.text,
      metadata: {
        matches: selected,
        truncated: index.truncated || matches.length > selected.length || truncated.truncated
      }
    };
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }
}
