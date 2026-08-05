import path from "node:path";
import { repositoryLanguage } from "./repository-path-metadata.js";

const IDENTIFIER = "[$_A-Za-z\\u0080-\\uFFFF][$_0-9A-Za-z\\u0080-\\uFFFF]*";
const MAX_SYMBOLS_PER_FILE = 240;
const MAX_REFERENCES_PER_FILE = 1_200;
const keywordSet = new Set([
  "abstract", "and", "as", "async", "await", "break", "case", "catch", "class",
  "const", "continue", "def", "default", "delete", "do", "else", "enum", "export",
  "extends", "false", "final", "finally", "fn", "for", "from", "func", "function",
  "if", "implements", "import", "in", "interface", "is", "let", "match", "mod",
  "module", "namespace", "new", "nil", "none", "not", "null", "or", "package",
  "pass", "private", "protected", "public", "raise", "record", "return", "self",
  "static", "struct", "super", "switch", "this", "throw", "trait", "true", "try",
  "type", "typeof", "undefined", "use", "var", "void", "while", "with", "yield"
]);

export interface RepositoryCodeSymbol {
  name: string;
  kind: string;
  line: number;
}

export interface RepositoryCodeFile {
  file: string;
  language: string;
  byteLength: number;
  symbols: RepositoryCodeSymbol[];
  imports: string[];
  references: Array<[string, number]>;
}

interface SymbolCollector {
  add(name: string | undefined, kind: string, line: number): void;
  values(): RepositoryCodeSymbol[];
}

function collector(): SymbolCollector {
  const symbols: RepositoryCodeSymbol[] = [];
  const seen = new Set<string>();
  return {
    add(name, kind, line) {
      if (!name || symbols.length >= MAX_SYMBOLS_PER_FILE) return;
      const normalized = name.normalize("NFKC");
      if (keywordSet.has(normalized.toLowerCase())) return;
      const key = `${kind}\0${normalized}\0${line}`;
      if (seen.has(key)) return;
      seen.add(key);
      symbols.push({ name: normalized, kind, line });
    },
    values: () => symbols
  };
}

function maskBlock(value: string): string {
  return value.replace(/[^\r\n]/gu, " ");
}

function blockCommentPatterns(language: string): RegExp[] {
  const patterns = [/\/\*[\s\S]*?\*\//gu, /<!--[\s\S]*?-->/gu];
  if (language === "Python") patterns.push(/("""|''')[\s\S]*?\1/gu);
  if (language === "Lua") patterns.push(/--\[\[[\s\S]*?\]\]/gu);
  return patterns;
}

function lineCommentPattern(language: string): RegExp | undefined {
  if (["Python", "Ruby", "Shell"].includes(language)) return /#.*$/gu;
  if (["SQL", "Lua"].includes(language)) return /--.*$/gu;
  if (language === "HTML") return undefined;
  return /\/\/.*$/gu;
}

function maskStrings(line: string): string {
  return line.replace(/(['"`])(?:\\.|(?!\1).)*\1/gu, maskBlock);
}

function maskSource(content: string, language: string): string {
  let masked = content;
  for (const pattern of blockCommentPatterns(language)) masked = masked.replace(pattern, maskBlock);
  const lineComment = lineCommentPattern(language);
  return masked.split(/\r?\n/u).map((line) => {
    const withoutComment = lineComment ? line.replace(lineComment, maskBlock) : line;
    return maskStrings(withoutComment);
  }).join("\n");
}

function match(line: string, expression: RegExp): RegExpExecArray | null {
  expression.lastIndex = 0;
  return expression.exec(line);
}

function scriptSymbols(lines: string[], output: SymbolCollector): void {
  const type = new RegExp(
    `^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(class|interface|enum|type|namespace|module)\\s+(${IDENTIFIER})`, "u"
  );
  const fn = new RegExp(
    `^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${IDENTIFIER})`, "u"
  );
  const arrow = new RegExp(
    `^\\s*(export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+(${IDENTIFIER})\\b[^=]*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|${IDENTIFIER})\\s*=>`, "u"
  );
  const exportedValue = new RegExp(
    `^\\s*export\\s+(?:declare\\s+)?(?:const|let|var)\\s+(${IDENTIFIER})\\b`, "u"
  );
  lines.forEach((line, index) => {
    const typeMatch = match(line, type);
    if (typeMatch) output.add(typeMatch[2], typeMatch[1]!, index + 1);
    const functionMatch = match(line, fn);
    if (functionMatch) output.add(functionMatch[1], "function", index + 1);
    const arrowMatch = match(line, arrow);
    if (arrowMatch && (arrowMatch[1] || !/^\s/u.test(line))) {
      output.add(arrowMatch[2], "function", index + 1);
    }
    const valueMatch = match(line, exportedValue);
    if (valueMatch) output.add(valueMatch[1], "value", index + 1);
  });
}

function pythonSymbols(lines: string[], output: SymbolCollector): void {
  const definition = new RegExp(`^\\s*(?:async\\s+)?def\\s+(${IDENTIFIER})`, "u");
  const type = new RegExp(`^\\s*class\\s+(${IDENTIFIER})`, "u");
  const constant = new RegExp(`^([A-Z][A-Z0-9_]*)\\s*(?::[^=]+)?=`, "u");
  lines.forEach((line, index) => {
    const definitionMatch = match(line, definition);
    if (definitionMatch) output.add(definitionMatch[1], "function", index + 1);
    const typeMatch = match(line, type);
    if (typeMatch) output.add(typeMatch[1], "class", index + 1);
    const constantMatch = match(line, constant);
    if (constantMatch) output.add(constantMatch[1], "constant", index + 1);
  });
}

function goSymbols(lines: string[], output: SymbolCollector): void {
  const fn = new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?(${IDENTIFIER})`, "u");
  const type = new RegExp(`^\\s*type\\s+(${IDENTIFIER})\\s+(struct|interface|${IDENTIFIER})`, "u");
  lines.forEach((line, index) => {
    const functionMatch = match(line, fn);
    if (functionMatch) output.add(functionMatch[1], "function", index + 1);
    const typeMatch = match(line, type);
    if (typeMatch) output.add(typeMatch[1], "type", index + 1);
  });
}

function rustSymbols(lines: string[], output: SymbolCollector): void {
  const item = new RegExp(
    `^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+|unsafe\\s+|const\\s+)*(fn|struct|enum|trait|type|mod|const|static)\\s+(${IDENTIFIER})`, "u"
  );
  lines.forEach((line, index) => {
    const itemMatch = match(line, item);
    if (itemMatch) output.add(itemMatch[2], itemMatch[1]!, index + 1);
  });
}

function declaredMethodSymbols(lines: string[], output: SymbolCollector): void {
  const type = new RegExp(
    `^\\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open)\\s+)*(class|interface|enum|struct|record|protocol)\\s+(${IDENTIFIER})`, "u"
  );
  const method = new RegExp(
    `^\\s*(?:(?:public|private|protected|internal|static|final|abstract|async|virtual|override|open|suspend|native|synchronized)\\s+)+(?:${IDENTIFIER}(?:[<>,.?\\[\\]]|\\s)*)?\\s+(${IDENTIFIER})\\s*\\(`, "u"
  );
  lines.forEach((line, index) => {
    const typeMatch = match(line, type);
    if (typeMatch) output.add(typeMatch[2], typeMatch[1]!, index + 1);
    const methodMatch = match(line, method);
    if (methodMatch) output.add(methodMatch[1], "method", index + 1);
  });
}

function dynamicLanguageSymbols(lines: string[], language: string, output: SymbolCollector): void {
  const patterns = language === "Ruby"
    ? [new RegExp(`^\\s*(class|module|def)\\s+(?:self\\.)?(${IDENTIFIER}[!?=]?)`, "u")]
    : language === "Elixir"
      ? [new RegExp(`^\\s*(defmodule|defprotocol|defimpl|defmacro|defp|def)\\s+(${IDENTIFIER}(?:\\.${IDENTIFIER})*)`, "u")]
      : language === "Lua"
        ? [new RegExp(`^\\s*(?:local\\s+)?function\\s+(${IDENTIFIER}(?:\\.${IDENTIFIER})*)`, "u")]
        : [new RegExp(`^\\s*(?:function\\s+)?(${IDENTIFIER})\\s*\\(\\s*\\)\\s*\\{?`, "u")];
  lines.forEach((line, index) => {
    const value = match(line, patterns[0]!);
    if (!value) return;
    const name = language === "Lua" || language === "Shell" ? value[1] : value[2];
    const kind = language === "Ruby" || language === "Elixir" ? value[1]! : "function";
    output.add(name, kind, index + 1);
  });
}

function markupSymbols(lines: string[], language: string, output: SymbolCollector): void {
  if (language === "CSS") {
    const selector = /^\s*([.#][-_A-Za-z][-_0-9A-Za-z]*)[^{}]*\{/u;
    lines.forEach((line, index) => output.add(match(line, selector)?.[1], "selector", index + 1));
    return;
  }
  const attribute = /\b(?:id|class)\s*=\s*["']([^"']+)["']/gu;
  lines.forEach((line, index) => {
    for (const value of line.matchAll(attribute)) {
      for (const name of value[1]!.split(/\s+/u).filter(Boolean)) {
        output.add(name, "selector", index + 1);
      }
    }
  });
}

function symbols(content: string, language: string): RepositoryCodeSymbol[] {
  const output = collector();
  const lines = maskSource(content, language).split("\n");
  if (["TypeScript", "JavaScript", "Dart", "Vue"].includes(language)) scriptSymbols(lines, output);
  else if (language === "Python") pythonSymbols(lines, output);
  else if (language === "Go") goSymbols(lines, output);
  else if (language === "Rust") rustSymbols(lines, output);
  else if (["Java", "C#", "Kotlin", "Swift", "C", "C++", "PHP"].includes(language)) {
    declaredMethodSymbols(lines, output);
  } else if (["Ruby", "Elixir", "Lua", "Shell"].includes(language)) {
    dynamicLanguageSymbols(lines, language, output);
  } else if (["CSS", "HTML"].includes(language)) markupSymbols(content.split(/\r?\n/u), language, output);
  return output.values();
}

function referenceCounts(content: string, language: string): Array<[string, number]> {
  const counts = new Map<string, number>();
  const identifier = /[$_A-Za-z\u0080-\uFFFF][$_0-9A-Za-z\u0080-\uFFFF]*/gu;
  for (const value of maskSource(content, language).matchAll(identifier)) {
    const name = value[0]!.normalize("NFKC");
    if (name.length < 2 || keywordSet.has(name.toLowerCase())) continue;
    counts.set(name, Math.min(100, (counts.get(name) ?? 0) + 1));
    if (counts.size >= MAX_REFERENCES_PER_FILE) break;
  }
  return [...counts].sort((left, right) => left[0].localeCompare(right[0]));
}

function importSpecifiers(content: string, language: string): string[] {
  const values: string[] = [];
  const expressions = ["TypeScript", "JavaScript", "Dart", "Vue"].includes(language)
    ? [/(?:import|export)\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gu,
        /(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/gu]
    : language === "Python"
      ? [/^\s*from\s+([.\w]+)\s+import\s+/gmu, /^\s*import\s+([.\w]+)/gmu]
      : [/#include\s*["<]([^">]+)[">]/gu];
  for (const expression of expressions) {
    for (const value of content.matchAll(expression)) if (value[1]) values.push(value[1]);
  }
  return [...new Set(values)].slice(0, 120);
}

function relativeImportBase(importer: string, specifier: string, language: string): string | null {
  if (language === "Python") {
    const dots = /^\.+/u.exec(specifier)?.[0].length ?? 0;
    let directory = path.posix.dirname(importer);
    for (let index = 1; index < dots; index += 1) directory = path.posix.dirname(directory);
    const module = specifier.slice(dots).replaceAll(".", "/");
    return path.posix.normalize(path.posix.join(dots > 0 ? directory : "", module));
  }
  if (specifier.startsWith(".")) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  }
  if (["C", "C++"].includes(language) && !specifier.includes(":")) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  }
  return null;
}

function resolvedImport(
  importer: string,
  specifier: string,
  language: string,
  files: ReadonlySet<string>
): string | undefined {
  const base = relativeImportBase(importer, specifier, language);
  if (!base || base === ".." || base.startsWith("../") || path.posix.isAbsolute(base)) return undefined;
  const importerExtension = path.posix.extname(importer);
  const extensions = [importerExtension, ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".cs"];
  const suppliedExtension = path.posix.extname(base).toLowerCase();
  const moduleRoots = [base];
  if ([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"].includes(suppliedExtension)) {
    moduleRoots.push(base.slice(0, -suppliedExtension.length));
  }
  const candidates = moduleRoots.flatMap((root) => [root, ...extensions.flatMap((extension) => [
    `${root}${extension}`, `${root}/index${extension}`, `${root}/__init__${extension}`
  ])]);
  return [...new Set(candidates)].find((candidate) => files.has(candidate));
}

export function parseRepositoryCodeFile(
  file: string,
  content: string,
  repositoryFiles: ReadonlySet<string>
): RepositoryCodeFile | undefined {
  const language = repositoryLanguage(file);
  if (!language) return undefined;
  const imports = importSpecifiers(content, language)
    .map((specifier) => resolvedImport(file, specifier, language, repositoryFiles))
    .filter((value): value is string => Boolean(value));
  return {
    file,
    language,
    byteLength: Buffer.byteLength(content, "utf8"),
    symbols: symbols(content, language),
    imports: [...new Set(imports)].sort((left, right) => left.localeCompare(right)),
    references: referenceCounts(content, language)
  };
}
