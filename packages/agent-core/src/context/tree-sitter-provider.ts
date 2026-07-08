import { createRequire } from "node:module";
import path from "node:path";
import type { CodeSymbol, CodeSymbolKind } from "./code-index.js";

const require = createRequire(import.meta.url);

interface TreeNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  namedChildren: TreeNode[];
  parent?: TreeNode | null;
  childForFieldName(name: string): TreeNode | null;
}

type Language = unknown;

let ParserCtor: (new () => { setLanguage(language: Language): void; parse(text: string): { rootNode: TreeNode } }) | null | undefined;
const languageCache = new Map<string, Language | null>();

function parserCtor(): NonNullable<typeof ParserCtor> | null {
  if (ParserCtor !== undefined) return ParserCtor;
  try {
    ParserCtor = require("tree-sitter") as NonNullable<typeof ParserCtor>;
  } catch {
    ParserCtor = null;
  }
  return ParserCtor;
}

function loadLanguage(language: string, ext: string): Language | null {
  const cacheKey = `${language}:${ext}`;
  if (languageCache.has(cacheKey)) return languageCache.get(cacheKey) ?? null;
  let loaded: Language | null = null;
  try {
    if (language === "typescript") {
      const ts = require("tree-sitter-typescript") as { typescript?: Language; tsx?: Language };
      loaded = ext === ".tsx" ? ts.tsx ?? null : ts.typescript ?? null;
    } else if (language === "javascript") {
      loaded = require("tree-sitter-javascript") as Language;
    } else if (language === "python") {
      loaded = require("tree-sitter-python") as Language;
    } else if (language === "go") {
      loaded = require("tree-sitter-go") as Language;
    } else if (language === "rust") {
      loaded = require("tree-sitter-rust") as Language;
    }
  } catch {
    loaded = null;
  }
  languageCache.set(cacheKey, loaded);
  return loaded;
}

function exported(node: TreeNode): boolean {
  let current: TreeNode | null | undefined = node;
  while (current) {
    if (current.type === "export_statement" || current.text.trimStart().startsWith("export ") || current.text.trimStart().startsWith("pub ")) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function pushSymbol(symbols: CodeSymbol[], node: TreeNode, name: string | undefined, kind: CodeSymbolKind): void {
  if (!name) return;
  const line = node.startPosition.row + 1;
  const existing = symbols.find((symbol) => symbol.name === name && symbol.kind === kind && symbol.line === line);
  if (existing) {
    existing.exported = existing.exported || exported(node);
    return;
  }
  symbols.push({
    name,
    kind,
    line,
    exported: exported(node)
  });
}

function named(node: TreeNode, field = "name"): string | undefined {
  return node.childForFieldName(field)?.text;
}

function stringLiteralText(node: TreeNode): string | undefined {
  const match = node.text.match(/["'`]([^"'`]+)["'`]/);
  return match?.[1];
}

function visit(node: TreeNode, callback: (node: TreeNode) => void): void {
  callback(node);
  for (const child of node.namedChildren) visit(child, callback);
}

function parseJsLike(root: TreeNode, symbols: CodeSymbol[], imports: Set<string>): void {
  visit(root, (node) => {
    if (node.type === "function_declaration") pushSymbol(symbols, node, named(node), "function");
    if (node.type === "class_declaration") pushSymbol(symbols, node, named(node), "class");
    if (node.type === "interface_declaration") pushSymbol(symbols, node, named(node), "interface");
    if (node.type === "type_alias_declaration") pushSymbol(symbols, node, named(node), "type");
    if (node.type === "method_definition") pushSymbol(symbols, node, named(node), "method");
    if (node.type === "variable_declarator") pushSymbol(symbols, node, named(node), "const");
    if (node.type === "import_statement") {
      const value = stringLiteralText(node);
      if (value) imports.add(value);
    }
    if (node.type === "call_expression") {
      const text = node.text;
      if (/^(describe|it|test)\s*\(/.test(text)) {
        const title = stringLiteralText(node);
        if (title) pushSymbol(symbols, node, title, "test");
      }
      const requireMatch = text.match(/require\(\s*["']([^"']+)["']\s*\)/);
      if (requireMatch?.[1]) imports.add(requireMatch[1]);
    }
  });
}

function parsePython(root: TreeNode, symbols: CodeSymbol[], imports: Set<string>): void {
  visit(root, (node) => {
    if (node.type === "function_definition") pushSymbol(symbols, node, named(node), "function");
    if (node.type === "class_definition") pushSymbol(symbols, node, named(node), "class");
    if (node.type === "import_statement" || node.type === "import_from_statement") {
      const importText = node.text.replace(/\s+/g, " ");
      const match = importText.match(/^(?:from\s+([A-Za-z0-9_.$]+)\s+import|import\s+([A-Za-z0-9_.$]+))/);
      const value = match?.[1] ?? match?.[2];
      if (value) imports.add(value);
    }
  });
}

function parseGo(root: TreeNode, symbols: CodeSymbol[], imports: Set<string>): void {
  visit(root, (node) => {
    if (node.type === "function_declaration" || node.type === "method_declaration") pushSymbol(symbols, node, named(node), "function");
    if (node.type === "type_spec") pushSymbol(symbols, node, named(node), "type");
    if (node.type === "import_spec") {
      const value = stringLiteralText(node);
      if (value) imports.add(value);
    }
  });
}

function parseRust(root: TreeNode, symbols: CodeSymbol[], imports: Set<string>): void {
  visit(root, (node) => {
    if (node.type === "function_item") pushSymbol(symbols, node, named(node), "function");
    if (node.type === "struct_item" || node.type === "enum_item" || node.type === "trait_item") pushSymbol(symbols, node, named(node), "type");
    if (node.type === "use_declaration") imports.add(node.text.replace(/^use\s+/, "").replace(/;$/, "").trim());
  });
}

export function parseWithTreeSitter(options: {
  filePath: string;
  language: string;
  text: string;
}): { symbols: CodeSymbol[]; imports: string[] } | null {
  const Parser = parserCtor();
  if (!Parser) return null;
  const ext = path.posix.extname(options.filePath).toLowerCase();
  const language = loadLanguage(options.language, ext);
  if (!language) return null;
  try {
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(options.text);
    const symbols: CodeSymbol[] = [];
    const imports = new Set<string>();
    if (options.language === "typescript" || options.language === "javascript") parseJsLike(tree.rootNode, symbols, imports);
    else if (options.language === "python") parsePython(tree.rootNode, symbols, imports);
    else if (options.language === "go") parseGo(tree.rootNode, symbols, imports);
    else if (options.language === "rust") parseRust(tree.rootNode, symbols, imports);
    else return null;
    return {
      symbols,
      imports: [...imports].sort((a, b) => a.localeCompare(b, "en"))
    };
  } catch {
    return null;
  }
}
