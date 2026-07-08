import { readFile } from "node:fs/promises";
import { truncateMiddle } from "../compaction.js";
import {
  type CodeSymbol
} from "../context/code-index.js";
import { getCodeGraphIndexForTool, type CodeGraphFile, type CodeGraphIndex } from "../context/code-graph-index.js";
import type { ToolExecutionContext, ToolResult } from "../types.js";

type RepoQueryKind = "text" | "symbol" | "test" | "config" | "path";

interface RepoQueryArgs {
  query?: unknown;
  kind?: unknown;
  path?: unknown;
  maxSnippets?: unknown;
  maxChars?: unknown;
}

export interface RepoQueryMatch {
  path: string;
  lineStart: number;
  lineEnd: number;
  score: number;
  reasons: string[];
  graphSignals: string[];
  why_this_file: string;
  snippet: string;
}

const MAX_FILE_BYTES = 256000;
const MAX_FILES = 20000;

function numberOrDefault(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function kindValue(value: unknown): RepoQueryKind {
  return value === "symbol" || value === "test" || value === "config" || value === "path" ? value : "text";
}

function tokenize(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_.@/$+-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  return [...new Set(tokens)];
}

function fileMentions(query: string): string[] {
  return query
    .split(/\s+/)
    .map((token) => token.trim().replace(/^["'`]|["'`,.;:]$/g, ""))
    .filter((token) => /(?:^|\/)[A-Za-z0-9_.-]+\.[A-Za-z0-9]+$/.test(token) || token.includes("/"))
    .map((token) => token.replace(/\\/g, "/").toLowerCase());
}

function tokenHits(text: string, tokens: string[]): number {
  const lower = text.toLowerCase();
  return tokens.filter((token) => lower.includes(token)).length;
}

function symbolScore(symbol: CodeSymbol, tokens: string[]): { score: number; reasons: string[] } {
  const lowerName = symbol.name.toLowerCase();
  let score = 0;
  const reasons: string[] = [];
  for (const token of tokens) {
    if (lowerName === token) {
      score += 36;
      reasons.push("symbol:exact");
    } else if (lowerName.includes(token)) {
      score += 18;
      reasons.push("symbol:partial");
    }
  }
  if (symbol.exported && score > 0) {
    score += 6;
    reasons.push("symbol:exported");
  }
  return { score, reasons };
}

function graphSignalsForFile(file: CodeGraphFile, graph: CodeGraphIndex, tokens: string[], mentions: string[], changedFiles: Set<string>): string[] {
  const signals: string[] = [];
  const lowerPath = file.path.toLowerCase();
  if (changedFiles.has(file.path)) signals.push("changed-file");
  if (file.exports.some((item) => tokens.some((token) => item.toLowerCase().includes(token)))) signals.push("exported-symbol");
  if (file.resolvedImports.some((item) => tokens.some((token) => item.source.toLowerCase().includes(token)))) signals.push("import");
  if (file.references.some((item) => tokens.some((token) => item.symbol.toLowerCase().includes(token)))) signals.push("reference");
  if (graph.dependencyEdges.some((edge) => edge.to === file.path && mentions.some((mention) => edge.from.toLowerCase().includes(mention)))) signals.push("dependency-target");
  if (graph.testToSource.some((edge) => edge.from === file.path || edge.to === file.path)) signals.push("test-source-relation");
  if (mentions.some((mention) => lowerPath.includes(mention))) signals.push("file-mention");
  return [...new Set(signals)];
}

function whyThisFile(file: CodeGraphFile, reasons: string[], graphSignals: string[]): string {
  const pieces = [
    ...reasons.map((reason) => `matched ${reason}`),
    ...graphSignals.map((signal) => `graph signal ${signal}`)
  ];
  if (file.isTest) pieces.push("file is a test");
  if (file.isConfig) pieces.push("file is project/config metadata");
  if (file.exports.length > 0) pieces.push(`exports ${file.exports.slice(0, 4).join(", ")}`);
  return pieces.length > 0 ? pieces.join("; ") : "Matched the query text.";
}

function fileBaseScore(file: CodeGraphFile, graph: CodeGraphIndex, tokens: string[], mentions: string[], kind: RepoQueryKind, changedFiles: Set<string>): {
  score: number;
  reasons: string[];
  graphSignals: string[];
} {
  let score = 0;
  const reasons: string[] = [];
  const lowerPath = file.path.toLowerCase();
  for (const token of tokens) {
    if (lowerPath.includes(token)) {
      score += 9;
      reasons.push("path");
    }
  }
  for (const mention of mentions) {
    if (lowerPath.endsWith(mention) || lowerPath.includes(mention)) {
      score += 30;
      reasons.push("file-mention");
    }
  }
  if (kind === "test" && file.isTest) {
    score += 24;
    reasons.push("test-file");
  }
  if (kind === "config" && file.isConfig) {
    score += 24;
    reasons.push("config-file");
  }
  const graphSignals = graphSignalsForFile(file, graph, tokens, mentions, changedFiles);
  score += graphSignals.length * 10;
  if (graphSignals.includes("dependency-target")) score += 18;
  if (graphSignals.includes("changed-file")) score += 12;
  return { score, reasons: [...new Set(reasons)], graphSignals };
}

function snippetForLines(lines: string[], index: number, radius: number): { lineStart: number; lineEnd: number; snippet: string } {
  const start = Math.max(0, index - radius);
  const end = Math.min(lines.length - 1, index + radius);
  return {
    lineStart: start + 1,
    lineEnd: end + 1,
    snippet: lines.slice(start, end + 1).join("\n")
  };
}

function pathOnlyMatch(file: CodeGraphFile, base: { score: number; reasons: string[]; graphSignals: string[] }): RepoQueryMatch | null {
  if (base.score <= 0) return null;
  return {
    path: file.path,
    lineStart: 1,
    lineEnd: 1,
    score: base.score,
    reasons: base.reasons,
    graphSignals: base.graphSignals,
    why_this_file: whyThisFile(file, base.reasons, base.graphSignals),
    snippet: file.path
  };
}

async function textMatches(options: {
  file: CodeGraphFile;
  tokens: string[];
  baseScore: number;
  baseReasons: string[];
  baseGraphSignals: string[];
  kind: RepoQueryKind;
}): Promise<RepoQueryMatch[]> {
  if (options.file.size > MAX_FILE_BYTES) return [];
  const text = await readFile(options.file.absolutePath, "utf8");
  const lines = text.split(/\r?\n/);
  const matches: RepoQueryMatch[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const hits = tokenHits(line, options.tokens);
    if (hits === 0) continue;
    if (options.kind === "test" && !options.file.isTest && !/\b(describe|it|test|expect|assert)\b/.test(line)) continue;
    if (options.kind === "config" && !options.file.isConfig) continue;
    if (options.kind === "symbol" && !/^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|def|func|struct|enum|trait)\b/.test(line)) continue;

    const reasons = [...options.baseReasons, "text"];
    let score = options.baseScore + hits * 10;
    if (options.kind === "symbol") score += 12;
    if (options.kind === "test") score += 8;
    if (options.kind === "config") score += 8;
    const snippet = snippetForLines(lines, index, options.kind === "symbol" ? 1 : 2);
    matches.push({
      path: options.file.path,
      lineStart: snippet.lineStart,
      lineEnd: snippet.lineEnd,
      score,
      reasons: [...new Set(reasons)],
      graphSignals: options.baseGraphSignals,
      why_this_file: whyThisFile(options.file, reasons, options.baseGraphSignals),
      snippet: snippet.snippet
    });
  }
  return matches;
}

function symbolMatches(options: {
  file: CodeGraphFile;
  tokens: string[];
  baseScore: number;
  baseReasons: string[];
  baseGraphSignals: string[];
  kind: RepoQueryKind;
}): RepoQueryMatch[] {
  const matches: RepoQueryMatch[] = [];
  for (const symbol of options.file.symbols) {
    const scored = symbolScore(symbol, options.tokens);
    if (scored.score <= 0) continue;
    if (options.kind === "test" && symbol.kind !== "test" && !options.file.isTest) continue;
    const reasons = [...options.baseReasons, ...scored.reasons];
    matches.push({
      path: options.file.path,
      lineStart: symbol.line,
      lineEnd: symbol.line,
      score: options.baseScore + scored.score,
      reasons: [...new Set(reasons)],
      graphSignals: options.baseGraphSignals,
      why_this_file: whyThisFile(options.file, reasons, options.baseGraphSignals),
      snippet: `${symbol.exported ? "export " : ""}${symbol.kind} ${symbol.name}`
    });
  }
  return matches;
}

function importReferenceMatches(options: {
  file: CodeGraphFile;
  tokens: string[];
  baseScore: number;
  baseReasons: string[];
  baseGraphSignals: string[];
}): RepoQueryMatch[] {
  const matches: RepoQueryMatch[] = [];
  const imports = options.file.imports.filter((item) => tokenHits(item, options.tokens) > 0);
  if (imports.length === 0) return matches;
  matches.push({
    path: options.file.path,
    lineStart: 1,
    lineEnd: 1,
    score: options.baseScore + imports.length * 14,
    reasons: [...new Set([...options.baseReasons, "import/reference"])],
    graphSignals: options.baseGraphSignals,
    why_this_file: whyThisFile(options.file, [...options.baseReasons, "import/reference"], options.baseGraphSignals),
    snippet: `imports: ${imports.join(", ")}`
  });
  return matches;
}

function testSourceMatches(graph: CodeGraphIndex, mentions: string[], tokens: string[]): RepoQueryMatch[] {
  const matches: RepoQueryMatch[] = [];
  for (const edge of graph.testToSource) {
    const lowerFrom = edge.from.toLowerCase();
    const lowerTo = edge.to.toLowerCase();
    const mentioned = mentions.some((mention) => lowerFrom.includes(mention) || lowerTo.includes(mention));
    const tokenHit = tokens.some((token) => lowerFrom.includes(token) || lowerTo.includes(token));
    if (!mentioned && !tokenHit) continue;
    const source = graph.files.find((file) => file.path === edge.to);
    if (!source) continue;
    const graphSignals = ["test-source-relation"];
    const reasons = ["related-source"];
    matches.push({
      path: source.path,
      lineStart: 1,
      lineEnd: 1,
      score: 42,
      reasons,
      graphSignals,
      why_this_file: `Related source for test ${edge.from}.`,
      snippet: `${edge.from} -> ${edge.to}`
    });
  }
  return matches;
}

export async function executeRepoQueryTool(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
  const parsed = (args && typeof args === "object" ? args : {}) as RepoQueryArgs;
  if (typeof parsed.query !== "string" || parsed.query.trim().length === 0) {
    return { ok: false, content: "repo_query requires a non-empty query string" };
  }
  const kind = kindValue(parsed.kind);
  const requestedPath = typeof parsed.path === "string" && parsed.path.length > 0 ? parsed.path : ".";
  const maxSnippets = numberOrDefault(parsed.maxSnippets, 8, 1, 50);
  const maxChars = numberOrDefault(parsed.maxChars, context.maxToolOutputChars, 500, 50000);
  const tokens = tokenize(parsed.query);
  const mentions = fileMentions(parsed.query);
  if (tokens.length === 0 && mentions.length === 0) {
    return { ok: false, content: "repo_query query did not contain searchable tokens" };
  }

  try {
    const index = await getCodeGraphIndexForTool(context, {
      path: requestedPath,
      maxFiles: MAX_FILES,
      maxFileBytes: MAX_FILE_BYTES
    });
    const matches: RepoQueryMatch[] = testSourceMatches(index, mentions, tokens);
    const changedFiles = new Set([...context.runState.changedFiles].map((file) => file.replace(/\\/g, "/")));
    for (const file of index.files) {
      const base = fileBaseScore(file, index, tokens, mentions, kind, changedFiles);
      if (kind === "path") {
        const pathMatch = pathOnlyMatch(file, base);
        if (pathMatch) matches.push(pathMatch);
        continue;
      }
      matches.push(...symbolMatches({ file, tokens, baseScore: base.score, baseReasons: base.reasons, baseGraphSignals: base.graphSignals, kind }));
      matches.push(...importReferenceMatches({ file, tokens, baseScore: base.score, baseReasons: base.reasons, baseGraphSignals: base.graphSignals }));
      matches.push(...(await textMatches({ file, tokens, baseScore: base.score, baseReasons: base.reasons, baseGraphSignals: base.graphSignals, kind })));
    }
    matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, "en") || a.lineStart - b.lineStart);
    const selected: RepoQueryMatch[] = [];
    const seen = new Set<string>();
    for (const match of matches) {
      const key = `${match.path}:${match.lineStart}:${match.lineEnd}:${match.snippet}`;
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(match);
      if (selected.length >= maxSnippets) break;
    }
    const content = JSON.stringify(
      {
        query: parsed.query,
        kind,
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
