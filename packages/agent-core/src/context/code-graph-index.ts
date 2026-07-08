import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  buildCodeIndex,
  isConfigPath,
  isTestPath,
  type BuildCodeIndexOptions,
  type CodeIndex,
  type CodeIndexFile,
  type CodeSymbol
} from "./code-index.js";
import type { ToolExecutionContext } from "../types.js";

export interface CodeGraphDefinition {
  symbol: string;
  kind: CodeSymbol["kind"];
  path: string;
  line: number;
  exported: boolean;
}

export interface CodeGraphReference {
  symbol: string;
  path: string;
  line: number;
  context: string;
}

export interface CodeGraphImport {
  source: string;
  resolvedPath?: string;
  path: string;
}

export interface CodeGraphDependencyEdge {
  from: string;
  to: string;
  kind: "import" | "test-to-source" | "config";
  label?: string;
}

export interface CodeGraphFile extends CodeIndexFile {
  hash: string;
  exports: string[];
  definitions: CodeGraphDefinition[];
  references: CodeGraphReference[];
  resolvedImports: CodeGraphImport[];
  testDeclarations: CodeSymbol[];
  dependencyEdges: CodeGraphDependencyEdge[];
}

export interface CodeGraphIndex {
  workspacePath: string;
  rootPath: string;
  files: CodeGraphFile[];
  symbols: CodeSymbol[];
  definitions: CodeGraphDefinition[];
  references: CodeGraphReference[];
  imports: CodeGraphImport[];
  exports: CodeGraphDefinition[];
  testDeclarations: CodeGraphDefinition[];
  configFiles: string[];
  dependencyEdges: CodeGraphDependencyEdge[];
  testToSource: CodeGraphDependencyEdge[];
  fileCache: Record<string, { mtimeMs: number; hash: string }>;
  truncated: boolean;
  generatedAt: string;
}

export interface CodeGraphParserProvider {
  parseFile?(file: CodeIndexFile, content: string): Partial<Pick<CodeGraphFile, "references" | "resolvedImports" | "dependencyEdges">>;
}

export interface BuildCodeGraphIndexOptions extends BuildCodeIndexOptions {
  parserProvider?: CodeGraphParserProvider;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt"];
const IMPORT_RESOLUTION_EXTENSIONS = ["", ...SOURCE_EXTENSIONS, ".json"];

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function stripExtension(filePath: string): string {
  return filePath.replace(/\.[^.\/]+$/, "");
}

function normalizeImportPath(importPath: string): string {
  return importPath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function resolveRelativeImport(file: CodeIndexFile, importPath: string, paths: Set<string>): string | undefined {
  if (!importPath.startsWith(".")) return undefined;
  const directory = path.posix.dirname(file.path);
  const base = normalizeImportPath(path.posix.normalize(path.posix.join(directory, importPath)));
  for (const ext of IMPORT_RESOLUTION_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (paths.has(candidate)) return candidate;
  }
  for (const ext of IMPORT_RESOLUTION_EXTENSIONS.filter(Boolean)) {
    const candidate = `${base}/index${ext}`;
    if (paths.has(candidate)) return candidate;
  }
  return undefined;
}

function pythonModuleToPath(importPath: string, paths: Set<string>): string | undefined {
  const base = importPath.replace(/\./g, "/");
  for (const candidate of [`${base}.py`, `${base}/__init__.py`]) {
    if (paths.has(candidate)) return candidate;
  }
  return undefined;
}

function resolveImport(file: CodeIndexFile, importPath: string, paths: Set<string>): string | undefined {
  if (file.language === "python" && !importPath.startsWith(".")) return pythonModuleToPath(importPath, paths);
  return resolveRelativeImport(file, importPath, paths);
}

function inferredSourceNames(testPath: string): string[] {
  const normalized = testPath.replace(/\\/g, "/");
  const withoutExt = stripExtension(normalized);
  const names = new Set<string>();
  names.add(withoutExt.replace(/(?:\.test|\.spec|_test|_spec)$/, ""));
  names.add(withoutExt.replace(/(^|\/)tests\//, "$1src/").replace(/(^|\/)test\//, "$1src/"));
  names.add(withoutExt.replace(/(^|\/)__tests__\//, "$1"));
  return [...names].filter((name) => name && name !== withoutExt);
}

function sourceForTestPath(testPath: string, paths: Set<string>): string | undefined {
  for (const name of inferredSourceNames(testPath)) {
    for (const ext of SOURCE_EXTENSIONS) {
      const candidate = `${name}${ext}`;
      if (paths.has(candidate) && candidate !== testPath) return candidate;
    }
  }
  return undefined;
}

function referencesForFile(file: CodeIndexFile, content: string, knownSymbols: Set<string>): CodeGraphReference[] {
  if (knownSymbols.size === 0) return [];
  const references: CodeGraphReference[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const symbol of knownSymbols) {
      if (line.includes(symbol) && !new RegExp(`\\b(?:function|class|interface|type|const|def|func|struct|enum|trait)\\s+${symbol}\\b`).test(line)) {
        references.push({
          symbol,
          path: file.path,
          line: index + 1,
          context: line.trim().slice(0, 240)
        });
      }
    }
  }
  return references.slice(0, 200);
}

async function safeReadFile(file: CodeIndexFile): Promise<string> {
  try {
    return await readFile(file.absolutePath, "utf8");
  } catch {
    return "";
  }
}

function definitionsForFile(file: CodeIndexFile): CodeGraphDefinition[] {
  return file.symbols.map((symbol) => ({
    symbol: symbol.name,
    kind: symbol.kind,
    path: file.path,
    line: symbol.line,
    exported: symbol.exported
  }));
}

function buildGraphFile(options: {
  file: CodeIndexFile;
  content: string;
  paths: Set<string>;
  knownSymbols: Set<string>;
  parserProvider?: CodeGraphParserProvider;
}): CodeGraphFile {
  const definitions = definitionsForFile(options.file);
  const exports = definitions.filter((definition) => definition.exported).map((definition) => definition.symbol);
  const resolvedImports = options.file.imports.map((source) => ({
    source,
    path: options.file.path,
    ...(resolveImport(options.file, source, options.paths) ? { resolvedPath: resolveImport(options.file, source, options.paths) } : {})
  }));
  const importEdges = resolvedImports
    .filter((item): item is CodeGraphImport & { resolvedPath: string } => typeof item.resolvedPath === "string")
    .map((item) => ({ from: options.file.path, to: item.resolvedPath, kind: "import" as const, label: item.source }));
  const testSource = options.file.isTest ? sourceForTestPath(options.file.path, options.paths) : undefined;
  const testEdges = testSource ? [{ from: options.file.path, to: testSource, kind: "test-to-source" as const }] : [];
  const providerParsed = options.parserProvider?.parseFile?.(options.file, options.content);

  return {
    ...options.file,
    hash: sha1(options.content),
    exports,
    definitions,
    references: providerParsed?.references ?? referencesForFile(options.file, options.content, options.knownSymbols),
    resolvedImports: providerParsed?.resolvedImports ?? resolvedImports,
    testDeclarations: options.file.symbols.filter((symbol) => symbol.kind === "test"),
    dependencyEdges: [...importEdges, ...testEdges, ...(providerParsed?.dependencyEdges ?? [])]
  };
}

export async function buildCodeGraphIndex(options: BuildCodeGraphIndexOptions): Promise<CodeGraphIndex> {
  const index: CodeIndex = await buildCodeIndex(options);
  const paths = new Set(index.files.map((file) => file.path));
  const knownSymbols = new Set(index.files.flatMap((file) => file.symbols.map((symbol) => symbol.name)));
  const graphFiles: CodeGraphFile[] = [];
  for (const file of index.files) {
    const content = await safeReadFile(file);
    graphFiles.push(buildGraphFile({
      file,
      content,
      paths,
      knownSymbols,
      parserProvider: options.parserProvider
    }));
  }
  const definitions = graphFiles.flatMap((file) => file.definitions);
  const references = graphFiles.flatMap((file) => file.references);
  const imports = graphFiles.flatMap((file) => file.resolvedImports);
  const exports = definitions.filter((definition) => definition.exported);
  const testDeclarations = graphFiles.flatMap((file) => file.testDeclarations.map((symbol) => ({
    symbol: symbol.name,
    kind: symbol.kind,
    path: file.path,
    line: symbol.line,
    exported: symbol.exported
  })));
  const dependencyEdges = graphFiles.flatMap((file) => file.dependencyEdges);
  return {
    workspacePath: index.workspacePath,
    rootPath: index.rootPath,
    files: graphFiles,
    symbols: graphFiles.flatMap((file) => file.symbols),
    definitions,
    references,
    imports,
    exports,
    testDeclarations,
    configFiles: graphFiles.filter((file) => file.isConfig || isConfigPath(file.path)).map((file) => file.path),
    dependencyEdges,
    testToSource: dependencyEdges.filter((edge) => edge.kind === "test-to-source"),
    fileCache: Object.fromEntries(graphFiles.map((file) => [file.path, { mtimeMs: file.mtimeMs, hash: file.hash }])),
    truncated: index.truncated,
    generatedAt: index.generatedAt
  };
}

export async function getCodeGraphIndexForTool(
  context: ToolExecutionContext,
  options: Omit<BuildCodeGraphIndexOptions, "workspacePath"> = {}
): Promise<CodeGraphIndex> {
  const cacheKey = JSON.stringify({
    graph: true,
    path: options.path ?? ".",
    maxFiles: options.maxFiles ?? 20000,
    maxFileBytes: options.maxFileBytes ?? 256000,
    version: context.runState.contextIndexVersion ?? 0
  });
  context.runState.contextIndexes ??= new Map<string, unknown>();
  const cached = context.runState.contextIndexes.get(cacheKey);
  if (cached) return cached as CodeGraphIndex;
  const graph = await buildCodeGraphIndex({ workspacePath: context.workspacePath, ...options });
  context.runState.contextIndexes.set(cacheKey, graph);
  return graph;
}

export function relatedSourceForTest(graph: CodeGraphIndex, testPath: string): string | undefined {
  return graph.testToSource.find((edge) => edge.from === testPath)?.to;
}

export { isTestPath };
