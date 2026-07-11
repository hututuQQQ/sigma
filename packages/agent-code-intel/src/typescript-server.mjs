import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const documents = new Map();
let rootPath = process.cwd();
let projectVersion = 0;
let shuttingDown = false;
let projectFiles = [];
let projectKey = "";
let projectConfigurationError;

const defaultCompilerOptions = {
  allowJs: true,
  checkJs: true,
  jsx: ts.JsxEmit.ReactJSX,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022
};
let compilerOptions = defaultCompilerOptions;
const maximumProjectFiles = 20_000;
const maximumHeaderBytes = 64 * 1024;
const maximumFrameBytes = 16 * 1024 * 1024;

function document(fileName) {
  return documents.get(path.resolve(fileName));
}

const host = {
  getCompilationSettings: () => compilerOptions,
  getScriptFileNames: () => [...new Set([...projectFiles, ...documents.keys()])],
  getScriptVersion: (fileName) => String(document(fileName)?.version ?? 0),
  getScriptSnapshot(fileName) {
    const text = document(fileName)?.text ?? ts.sys.readFile(fileName);
    return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
  },
  getCurrentDirectory: () => rootPath,
  getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
  realpath: (fileName) => path.resolve(fileName),
  useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  getNewLine: () => ts.sys.newLine,
  getProjectVersion: () => String(projectVersion)
};

const service = ts.createLanguageService(host, ts.createDocumentRegistry());

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function response(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function failure(id, error) {
  send({
    jsonrpc: "2.0",
    id,
    error: {
      code: typeof error?.code === "number" ? error.code : -32603,
      message: error instanceof Error ? error.message : String(error)
    }
  });
}

function withinRoot(fileName) {
  const relative = path.relative(rootPath, path.resolve(fileName));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

function nearestProjectConfig(fileName) {
  let directory = path.dirname(path.resolve(fileName));
  while (withinRoot(directory)) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = path.join(directory, name);
      if (ts.sys.fileExists(candidate)) return candidate;
    }
    if (path.resolve(directory) === path.resolve(rootPath)) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function boundedProjectFiles(values) {
  const files = [...new Set(values.map((item) => path.resolve(item)).filter(withinRoot))];
  if (files.length > maximumProjectFiles) {
    throw new Error(`TypeScript project exceeds the ${maximumProjectFiles} file safety limit.`);
  }
  return files;
}

function configureProject(fileName) {
  const configPath = nearestProjectConfig(fileName);
  const nextKey = configPath ?? `${rootPath}\0fallback`;
  if (projectKey === nextKey) return;
  if (configPath) {
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
    if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n"));
    const parsed = ts.parseJsonConfigFileContent(
      loaded.config, ts.sys, path.dirname(configPath), { noEmit: true }, configPath
    );
    const configError = parsed.errors.find((item) => item.category === ts.DiagnosticCategory.Error);
    if (configError) throw new Error(ts.flattenDiagnosticMessageText(configError.messageText, "\n"));
    compilerOptions = { ...parsed.options, noEmit: true };
    projectFiles = boundedProjectFiles(parsed.fileNames);
  } else {
    compilerOptions = defaultCompilerOptions;
    projectFiles = boundedProjectFiles(ts.sys.readDirectory(
      rootPath,
      [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
      ["**/node_modules/**", "**/.git/**", "**/.agent/**"],
      ["**/*"],
      20
    ));
  }
  projectKey = nextKey;
  projectConfigurationError = undefined;
  projectVersion += 1;
}

function fileFromUri(uri) {
  if (typeof uri !== "string" || !uri.startsWith("file:")) throw new Error("A file URI is required.");
  const fileName = path.resolve(fileURLToPath(uri));
  if (!withinRoot(fileName)) throw new Error("Language-server path escapes the workspace.");
  return fileName;
}

function sourceFile(fileName) {
  const source = service.getProgram()?.getSourceFile(fileName);
  if (!source) throw new Error(`TypeScript did not load '${fileName}'.`);
  return source;
}

function offset(fileName, position) {
  const source = sourceFile(fileName);
  return source.getPositionOfLineAndCharacter(
    Number(position?.line ?? 0), Number(position?.character ?? 0)
  );
}

function range(fileName, span) {
  const source = sourceFile(fileName);
  return {
    start: source.getLineAndCharacterOfPosition(span.start),
    end: source.getLineAndCharacterOfPosition(span.start + span.length)
  };
}

function location(fileName, span) {
  return { uri: pathToFileURL(fileName).href, range: range(fileName, span) };
}

const symbolKinds = new Map([
  [ts.ScriptElementKind.moduleElement, 2],
  [ts.ScriptElementKind.classElement, 5],
  [ts.ScriptElementKind.memberFunctionElement, 6],
  [ts.ScriptElementKind.memberVariableElement, 8],
  [ts.ScriptElementKind.constructorImplementationElement, 9],
  [ts.ScriptElementKind.enumElement, 10],
  [ts.ScriptElementKind.interfaceElement, 11],
  [ts.ScriptElementKind.functionElement, 12],
  [ts.ScriptElementKind.variableElement, 13],
  [ts.ScriptElementKind.constElement, 14],
  [ts.ScriptElementKind.enumMemberElement, 22],
  [ts.ScriptElementKind.typeElement, 26]
]);

function documentSymbols(fileName) {
  const tree = service.getNavigationTree(fileName);
  const flatten = (items = []) => items.flatMap((item) => {
    const span = item.spans?.[0];
    const own = span ? [{
      name: item.text,
      kind: symbolKinds.get(item.kind) ?? 13,
      range: range(fileName, span),
      selectionRange: range(fileName, span)
    }] : [];
    return [...own, ...flatten(item.childItems)];
  });
  return flatten(tree?.childItems);
}

function definition(fileName, position) {
  const values = service.getDefinitionAtPosition(fileName, offset(fileName, position)) ?? [];
  return values.map((item) => location(path.resolve(item.fileName), item.textSpan));
}

function references(fileName, position) {
  const values = service.getReferencesAtPosition(fileName, offset(fileName, position)) ?? [];
  return values.map((item) => location(path.resolve(item.fileName), item.textSpan));
}

function hover(fileName, position) {
  const value = service.getQuickInfoAtPosition(fileName, offset(fileName, position));
  if (!value) return null;
  const display = ts.displayPartsToString(value.displayParts);
  const documentation = ts.displayPartsToString(value.documentation);
  return {
    contents: { kind: "markdown", value: `\`\`\`typescript\n${display}\n\`\`\`${documentation ? `\n\n${documentation}` : ""}` },
    range: range(fileName, value.textSpan)
  };
}

function rename(fileName, position, newName) {
  if (!ts.isIdentifierText(newName, compilerOptions.target ?? ts.ScriptTarget.ES2022)) {
    throw new Error(`'${newName}' is not a valid TypeScript identifier.`);
  }
  const renamePosition = offset(fileName, position);
  const info = service.getRenameInfo(fileName, renamePosition, { allowRenameOfImportPath: false });
  if (!info.canRename) throw new Error(info.localizedErrorMessage ?? "The selected symbol cannot be renamed.");
  const values = service.findRenameLocations(
    fileName, renamePosition, false, false, true
  ) ?? [];
  if (values.some((item) => !withinRoot(path.resolve(item.fileName)))) {
    throw new Error("TypeScript rename would modify a path outside the workspace.");
  }
  const changes = {};
  for (const item of values) {
    const target = path.resolve(item.fileName);
    const uri = pathToFileURL(target).href;
    const replacement = `${item.prefixText ?? ""}${newName}${item.suffixText ?? ""}`;
    (changes[uri] ??= []).push({ range: range(target, item.textSpan), newText: replacement });
  }
  return Object.keys(changes).length === 0 ? null : { changes };
}

function diagnosticSeverity(category) {
  if (category === ts.DiagnosticCategory.Error) return 1;
  if (category === ts.DiagnosticCategory.Warning) return 2;
  if (category === ts.DiagnosticCategory.Suggestion) return 4;
  return 3;
}

function diagnostics(fileName) {
  return [...service.getSyntacticDiagnostics(fileName), ...service.getSemanticDiagnostics(fileName)]
    .map((item) => ({
      range: item.start === undefined
        ? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
        : range(fileName, { start: item.start, length: item.length ?? 0 }),
      severity: diagnosticSeverity(item.category),
      code: item.code,
      source: "typescript",
      message: ts.flattenDiagnosticMessageText(item.messageText, "\n")
    }));
}

function openDocument(params) {
  const item = params?.textDocument;
  const fileName = fileFromUri(item?.uri);
  try { configureProject(fileName); }
  catch (error) {
    projectConfigurationError = error instanceof Error ? error : new Error(String(error));
  }
  documents.set(fileName, {
    text: String(item?.text ?? ""),
    version: Number(item?.version ?? 1)
  });
  projectVersion += 1;
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri: item.uri,
      version: item.version,
      diagnostics: projectConfigurationError ? [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        severity: 1,
        source: "typescript-config",
        message: projectConfigurationError.message
      }] : diagnostics(fileName)
    }
  });
}

function changeDocument(params) {
  const item = params?.textDocument;
  const fileName = fileFromUri(item?.uri);
  const current = document(fileName);
  const changes = Array.isArray(params?.contentChanges) ? params.contentChanges : [];
  const latest = changes.at(-1);
  if (!current || typeof latest?.text !== "string" || latest.range !== undefined) {
    throw new Error("Only full-document TypeScript changes are supported.");
  }
  documents.set(fileName, { text: latest.text, version: Number(item?.version ?? current.version + 1) });
  projectVersion += 1;
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri: item.uri, version: item.version, diagnostics: diagnostics(fileName) }
  });
}

function closeDocument(params) {
  const uri = params?.textDocument?.uri;
  const fileName = fileFromUri(uri);
  documents.delete(fileName);
  projectVersion += 1;
  send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
}

function capabilities(params) {
  rootPath = path.resolve(params?.rootUri ? fileURLToPath(params.rootUri) : process.cwd());
  return {
    capabilities: {
      definitionProvider: true,
      diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false },
      documentSymbolProvider: true,
      hoverProvider: true,
      referencesProvider: true,
      renameProvider: true,
      textDocumentSync: { openClose: true, change: 1 }
    },
    serverInfo: { name: "sigma-typescript-language-server", version: "3.0.0" }
  };
}

function request(method, params) {
  const fileName = params?.textDocument?.uri ? fileFromUri(params.textDocument.uri) : undefined;
  if (method === "initialize") return capabilities(params);
  if (method === "shutdown") { shuttingDown = true; return null; }
  if (projectConfigurationError) throw projectConfigurationError;
  if (method === "textDocument/documentSymbol") return documentSymbols(fileName);
  if (method === "textDocument/definition") return definition(fileName, params.position);
  if (method === "textDocument/references") return references(fileName, params.position);
  if (method === "textDocument/hover") return hover(fileName, params.position);
  if (method === "textDocument/rename") return rename(fileName, params.position, String(params.newName));
  if (method === "textDocument/diagnostic") return { kind: "full", items: diagnostics(fileName) };
  throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
}

async function handle(message) {
  if (message.method === "textDocument/didOpen") { openDocument(message.params); return; }
  if (message.method === "textDocument/didChange") { changeDocument(message.params); return; }
  if (message.method === "textDocument/didClose") { closeDocument(message.params); return; }
  if (message.method === "exit") { process.exitCode = shuttingDown ? 0 : 1; process.stdin.pause(); return; }
  if (message.id === undefined) return;
  try { response(message.id, request(message.method, message.params)); }
  catch (error) { failure(message.id, error); }
}

let input = Buffer.alloc(0);
let chain = Promise.resolve();
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, Buffer.from(chunk)]);
  while (true) {
    const separator = input.indexOf("\r\n\r\n");
    if (separator < 0) {
      if (input.length > maximumHeaderBytes) {
        process.stderr.write("LSP header exceeds the safety limit.\n");
        process.exitCode = 1;
        process.stdin.pause();
      }
      break;
    }
    if (separator > maximumHeaderBytes) {
      process.stderr.write("LSP header exceeds the safety limit.\n");
      process.exitCode = 1;
      process.stdin.pause();
      break;
    }
    const header = input.subarray(0, separator).toString("ascii");
    const match = /(?:^|\r\n)Content-Length:\s*(\d+)/iu.exec(header);
    if (!match) { process.exitCode = 1; process.stdin.pause(); break; }
    const length = Number(match[1]);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumFrameBytes) {
      process.stderr.write("LSP frame exceeds the safety limit.\n");
      process.exitCode = 1;
      process.stdin.pause();
      break;
    }
    const bodyStart = separator + 4;
    if (input.length < bodyStart + length) break;
    const body = input.subarray(bodyStart, bodyStart + length).toString("utf8");
    input = input.subarray(bodyStart + length);
    chain = chain.then(async () => await handle(JSON.parse(body))).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
  }
});
