#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const scriptPath = fileURLToPath(import.meta.url);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await readFile(filePath));
}

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (["--bundle", "--broker", "--target-platform", "--output"].includes(argument) && value) {
      options[argument.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument '${argument}'.`);
    }
  }
  for (const key of ["bundle", "broker", "targetPlatform", "output"]) {
    if (!options[key]) throw new Error(`--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required.`);
  }
  if (!["linux", "win32"].includes(options.targetPlatform)) {
    throw new Error("--target-platform must be 'linux' or 'win32'.");
  }
  return options;
}

export function portableLayout(bundlePath, targetPlatform) {
  const bundle = path.resolve(bundlePath);
  const executableSuffix = targetPlatform === "win32" ? ".exe" : "";
  return {
    bundle,
    metadata: path.join(bundle, "package-metadata.json"),
    integrityManifest: path.join(bundle, "integrity-manifest.json"),
    node: path.join(bundle, "bin", `node${executableSuffix}`),
    lspRoot: path.join(bundle, "node_modules"),
    typescriptEntry: path.join(bundle, "node_modules", "agent-code-intel", "dist", "typescript-server.mjs"),
    pyrightEntry: path.join(bundle, "node_modules", "pyright", "langserver.index.js"),
    executionModule: path.join(bundle, "node_modules", "agent-execution", "dist", "index.js"),
    codeIntelModule: path.join(bundle, "node_modules", "agent-code-intel", "dist", "index.js"),
    mcpModule: path.join(bundle, "node_modules", "agent-mcp", "dist", "index.js")
  };
}

function requireFiles(layout, brokerPath) {
  const files = [
    layout.metadata, layout.integrityManifest, layout.node, layout.typescriptEntry, layout.pyrightEntry,
    layout.executionModule, layout.codeIntelModule, layout.mcpModule, brokerPath
  ];
  const missing = files.filter((filePath) => !existsSync(filePath));
  if (missing.length > 0) throw new Error(`Portable LSP smoke inputs are missing: ${missing.join(", ")}`);
}

async function verifyPortableIntegrity(layout, metadata) {
  const manifestDigest = await sha256File(layout.integrityManifest);
  if (metadata.integrity?.manifest !== "integrity-manifest.json"
    || metadata.integrity?.manifestSha256 !== manifestDigest) {
    throw new Error("Portable integrity manifest does not match package metadata.");
  }
  const manifest = JSON.parse(await readFile(layout.integrityManifest, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.algorithm !== "sha256"
    || manifest.targetPlatform !== metadata.targetPlatform || manifest.targetArch !== metadata.targetArch
    || !Array.isArray(manifest.entries)) {
    throw new Error("Portable integrity manifest has an invalid schema or target.");
  }
  const entries = new Map();
  for (const entry of manifest.entries) {
    const absolute = path.resolve(layout.bundle, String(entry?.path ?? ""));
    const relative = path.relative(layout.bundle, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || entries.has(entry.path)) {
      throw new Error(`Portable integrity entry is unsafe or duplicated: ${String(entry?.path)}`);
    }
    const stats = await lstat(absolute);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== entry.size
      || await sha256File(absolute) !== entry.sha256) {
      throw new Error(`Portable integrity entry failed verification: ${entry.path}`);
    }
    entries.set(entry.path, entry);
  }
  async function assertTreeCovered(relativeRoot) {
    async function visit(absolute) {
      const stats = await lstat(absolute);
      const relative = path.relative(layout.bundle, absolute).replaceAll(path.sep, "/");
      if (stats.isSymbolicLink()) throw new Error(`Language runtime tree contains a link: ${relative}`);
      if (stats.isDirectory()) {
        for (const item of await readdir(absolute, { withFileTypes: true })) await visit(path.join(absolute, item.name));
      } else if (stats.isFile() && !entries.has(relative)) {
        throw new Error(`Portable integrity manifest omits language runtime file: ${relative}`);
      }
    }
    await visit(path.join(layout.bundle, ...relativeRoot.split("/")));
  }
  await assertTreeCovered("node_modules/typescript");
  await assertTreeCovered("node_modules/pyright");
  return { manifestDigest, entries: entries.size, manifest };
}

export function assertMetadata(metadata, targetPlatform, brokerPath, brokerDigest, layout) {
  const productMajor = Number.parseInt(String(metadata.productVersion ?? "").split(".")[0] ?? "", 10);
  if ((productMajor !== 3 && productMajor !== 4) || metadata.schemaVersion !== productMajor) {
    throw new Error(
      `Portable package metadata schemaVersion=${String(metadata.schemaVersion)} must match supported product major ${String(metadata.productVersion)}.`
    );
  }
  if (metadata.targetPlatform !== targetPlatform || typeof metadata.targetArch !== "string") {
    throw new Error(`Package target does not match ${targetPlatform}: ${String(metadata.targetPlatform)}-${String(metadata.targetArch)}.`);
  }
  const expectedBroker = path.resolve(layout.bundle, String(metadata.sigmaExec?.path ?? ""));
  if (path.resolve(brokerPath) !== expectedBroker) throw new Error("--broker must identify the broker inside --bundle.");
  if (metadata.sigmaExec?.sha256 !== brokerDigest) throw new Error("Packaged broker digest does not match package metadata.");
}

export function portableNodeToolchain(api, layout, metadata, integrityManifest, nodeDigest) {
  if (metadata.node?.sha256 !== nodeDigest) {
    throw new Error("Bundled Node digest does not match package metadata.");
  }
  const targetPlatform = metadata.targetPlatform;
  const metadataCompatibility = metadata.node?.compatibility;
  const manifestCompatibility = integrityManifest?.nodeCompatibility;
  const toolchain = {
    id: "bundled-runtime",
    runtime: "node",
    executable: layout.node,
    aliases: targetPlatform === "win32" ? ["node", "node.exe"] : ["node"],
    executionRoots: [layout.node],
    pathEntries: [],
    environment: {}
  };
  if (targetPlatform !== "win32") {
    if (metadataCompatibility !== undefined || manifestCompatibility !== undefined) {
      throw new Error("Windows Node compatibility metadata must not appear on another target.");
    }
    return toolchain;
  }
  if (!metadataCompatibility || !isDeepStrictEqual(metadataCompatibility, manifestCompatibility)) {
    throw new Error("Windows Node compatibility metadata does not match the integrity manifest.");
  }
  const contract = api.WINDOWS_APPCONTAINER_NODE_COMPATIBILITY;
  if (!contract || typeof api.createWindowsAppContainerNodeCompatibilityProof !== "function") {
    throw new Error("Portable agent-execution does not expose the Windows Node compatibility contract.");
  }
  for (const field of [
    "kind", "patchId", "reason", "nodeVersion", "targetPlatform", "targetArch", "sourceSha256",
    "unsignedPatchedSha256", "normalizedContentSha256"
  ]) {
    if (metadataCompatibility[field] !== contract[field]) {
      throw new Error(`Windows Node compatibility field ${field} does not match packaged agent-execution.`);
    }
  }
  if (!isDeepStrictEqual(metadataCompatibility.sandboxRuntimeEnvironment, {
    NODE_OPTIONS: contract.requiredNodeOptions
  })) {
    throw new Error("Windows Node sandbox compatibility environment is not the required exact environment.");
  }
  const compatibility = api.createWindowsAppContainerNodeCompatibilityProof(layout.node, toolchain.id);
  if (compatibility.executableSha256 !== nodeDigest) {
    throw new Error("Windows Node compatibility proof is not bound to the verified bundled executable.");
  }
  return {
    ...toolchain,
    environment: { ...metadataCompatibility.sandboxRuntimeEnvironment },
    compatibility
  };
}

function assertBrokerTarget(doctor, targetPlatform, targetArch) {
  const platforms = targetPlatform === "win32" ? ["win32", "windows"] : ["linux"];
  const architectures = targetArch === "x64" ? ["x64", "x86_64", "amd64"] : [targetArch];
  if (!platforms.includes(String(doctor.platform).toLowerCase())) {
    throw new Error(`Broker platform '${String(doctor.platform)}' does not match ${targetPlatform}.`);
  }
  if (!architectures.includes(String(doctor.architecture).toLowerCase())) {
    throw new Error(`Broker architecture '${String(doctor.architecture)}' does not match ${targetArch}.`);
  }
}

function preset(id, executable, args) {
  return {
    id,
    languages: id === "typescript" ? ["typescript", "javascript"] : ["python"],
    executable,
    args,
    source: "bundled",
    available: true
  };
}

function nonEmpty(value) {
  return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined;
}

function containsRename(edit, newName) {
  return edit !== null && typeof edit === "object" && JSON.stringify(edit).includes(newName);
}

async function waitForDiagnostics(client, filePath) {
  const deadline = Date.now() + 30_000;
  let diagnostics = [];
  while (Date.now() < deadline) {
    diagnostics = await client.documentDiagnostics(filePath);
    if (diagnostics.length > 0) return diagnostics;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return diagnostics;
}

async function runTypeScriptSmoke(api, broker, workspace, layout) {
  const libPath = path.join(workspace, "lib.ts");
  const mainPath = path.join(workspace, "main.ts");
  await writeFile(libPath, "export function greet(name: string): string { return `Hello ${name}`; }\n", "utf8");
  await writeFile(mainPath, "import { greet } from \"./lib.js\";\nexport const message = greet(\"Sigma\");\n", "utf8");
  const before = await Promise.all([sha256File(libPath), sha256File(mainPath)]);
  const transport = new api.BrokerLspTransport({
    broker,
    preset: preset("typescript", layout.node, api.nodeLanguageServerArguments(layout.typescriptEntry)),
    workspacePath: workspace,
    additionalReadRoots: [layout.bundle]
  });
  const client = new api.LspClient({ rootPath: workspace, transport, requestTimeoutMs: 45_000 });
  try {
    const symbols = await client.symbols(mainPath);
    const position = { line: 1, character: 23 };
    const definition = await client.definition(mainPath, position);
    const references = await client.references(mainPath, position);
    const hover = await client.hover(mainPath, position);
    const renameEdit = await client.rename(mainPath, position, "renamedGreeting");
    const after = await Promise.all([sha256File(libPath), sha256File(mainPath)]);
    const checks = {
      symbols: nonEmpty(symbols),
      definition: nonEmpty(definition),
      references: Array.isArray(references) && references.length > 0,
      hover: nonEmpty(hover),
      renameWorkspaceEdit: containsRename(renameEdit, "renamedGreeting"),
      renameDidNotWrite: before[0] === after[0] && before[1] === after[1]
    };
    if (!Object.values(checks).every(Boolean)) throw new Error(`TypeScript LSP checks failed: ${JSON.stringify(checks)}`);
    return {
      ready: true,
      operations: ["symbols", "definition", "references", "hover", "rename"],
      referenceCount: references.length,
      ...checks
    };
  } finally {
    await client.close();
  }
}

async function runPyrightSmoke(api, broker, workspace, layout) {
  const filePath = path.join(workspace, "diagnostic.py");
  await writeFile(filePath, "def expects_number(value: int) -> int:\n    return value\n\nresult: int = expects_number(\"wrong\")\n", "utf8");
  const before = await sha256File(filePath);
  const transport = new api.BrokerLspTransport({
    broker,
    preset: preset("python", layout.node, api.nodeLanguageServerArguments(layout.pyrightEntry, { foregroundOnly: true })),
    workspacePath: workspace,
    additionalReadRoots: [layout.bundle]
  });
  const logs = [];
  const client = new api.LspClient({
    rootPath: workspace,
    transport,
    requestTimeoutMs: 20_000,
    onNotification(method, params) {
      if (["window/logMessage", "window/showMessage"].includes(method)) {
        logs.push(String(params?.message ?? params).slice(0, 2_000));
        if (logs.length > 20) logs.shift();
      }
    }
  });
  try {
    let diagnostics;
    try {
      diagnostics = await waitForDiagnostics(client, filePath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Pyright sandbox diagnostics failed: ${detail}. Logs: ${logs.join(" | ") || "none"}`,
        { cause: error }
      );
    }
    const unchanged = before === await sha256File(filePath);
    if (diagnostics.length === 0 || !unchanged) {
      throw new Error(`Pyright checks failed: diagnostics=${diagnostics.length}, unchanged=${String(unchanged)}.`);
    }
    return {
      ready: true,
      operation: "diagnostics",
      diagnosticCount: diagnostics.length,
      errorCount: diagnostics.filter((item) => item.severity === 1).length,
      workspaceUnchanged: unchanged
    };
  } finally {
    await client.close();
  }
}

async function eventually(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function mcpExecution(
  broker,
  workspace,
  possibleEffects,
  writeRoots = [],
  additionalReadRoots = [],
  executionRoots = []
) {
  return {
    broker,
    possibleEffects,
    pollIntervalMs: 5,
    policy: {
      sandbox: "required",
      network: "none",
      readRoots: [workspace, ...additionalReadRoots],
      writeRoots,
      executionRoots,
      protectedPaths: [path.join(workspace, ".git"), path.join(workspace, ".agent")]
    }
  };
}

async function assertMcpRejectedBeforeSpawn(api, broker, workspace) {
  const originalSpawn = broker.spawn.bind(broker);
  let spawnCalls = 0;
  broker.spawn = async (...args) => {
    spawnCalls += 1;
    return await originalSpawn(...args);
  };
  try {
    for (const effect of ["filesystem.write", "destructive", "open_world"]) {
      const client = new api.McpStdioClient({
        name: `forbidden-${effect}`, command: process.execPath, args: [], cwd: workspace
      }, {}, mcpExecution(broker, workspace, [effect]));
      let rejected;
      try {
        await client.connect();
      } catch (error) {
        rejected = error;
      }
      if (rejected?.code !== "mcp_persistent_effect_forbidden") {
        throw new Error(`MCP ${effect} capability was not rejected with the typed policy error.`);
      }
    }
    const writeRootClient = new api.McpStdioClient({
      name: "forbidden-write-root", command: process.execPath, args: [], cwd: workspace
    }, {}, mcpExecution(broker, workspace, ["filesystem.read"], [workspace]));
    let writeRootError;
    try {
      await writeRootClient.connect();
    } catch (error) {
      writeRootError = error;
    }
    if (writeRootError?.code !== "mcp_write_roots_forbidden") {
      throw new Error("MCP writable roots were not rejected with the typed policy error.");
    }
    if (spawnCalls !== 0) throw new Error(`Unsafe MCP policy reached broker.spawn ${spawnCalls} time(s).`);
    return { forbiddenEffectsRejected: 3, writeRootsRejected: true, spawnCalls };
  } finally {
    broker.spawn = originalSpawn;
  }
}

async function runMcpSandboxSmoke(api, broker, workspace, brokerPath) {
  const preSpawn = await assertMcpRejectedBeforeSpawn(api, broker, workspace);
  const initializeMarker = path.join(workspace, "mcp-initialize-write.txt");
  const idleMarker = path.join(workspace, "mcp-idle-write.txt");
  let idleAttempted = false;
  const client = new api.McpStdioClient({
    name: "sandbox-readonly-probe",
    command: brokerPath,
    args: ["--internal-mcp-readonly-probe", initializeMarker, idleMarker],
    cwd: workspace
  }, {
    onNotification: (notification) => {
      if (notification.method === "sigma/read-only-probe"
        && notification.params?.phase === "idle-write-attempted") idleAttempted = true;
    }
  }, mcpExecution(
    broker,
    workspace,
    ["filesystem.read"],
    [],
    [path.dirname(brokerPath)],
    [brokerPath]
  ));
  try {
    await client.connect();
    const processStarted = Number.isInteger(client.processId) && client.processId > 0;
    await eventually(() => idleAttempted, "the MCP idle write attempt");
    const initializeWriteDenied = !existsSync(initializeMarker);
    const idleWriteDenied = !existsSync(idleMarker);
    if (!processStarted || !initializeWriteDenied || !idleWriteDenied) {
      throw new Error(`MCP read-only sandbox checks failed: ${JSON.stringify({
        processStarted, initializeWriteDenied, idleWriteDenied
      })}`);
    }
    return {
      ready: true,
      processStarted,
      initializeWriteDenied,
      idleWriteDenied,
      policy: { sandbox: "required", network: "none", writeRoots: [] },
      ...preSpawn
    };
  } finally {
    await client.close();
  }
}

async function importPortableApi(layout) {
  const [execution, codeIntel, mcp] = await Promise.all([
    import(pathToFileURL(layout.executionModule).href),
    import(pathToFileURL(layout.codeIntelModule).href),
    import(pathToFileURL(layout.mcpModule).href)
  ]);
  if (typeof execution.SigmaExecBrokerClient !== "function"
    || typeof execution.createWindowsAppContainerNodeCompatibilityProof !== "function"
    || !execution.WINDOWS_APPCONTAINER_NODE_COMPATIBILITY
    || typeof codeIntel.BrokerLspTransport !== "function"
    || typeof codeIntel.LspClient !== "function"
    || typeof codeIntel.discoverLanguageServers !== "function"
    || typeof codeIntel.nodeLanguageServerArguments !== "function"
    || typeof mcp.McpStdioClient !== "function") {
    throw new Error("Portable broker/LSP/MCP client exports are incomplete.");
  }
  return {
    SigmaExecBrokerClient: execution.SigmaExecBrokerClient,
    createWindowsAppContainerNodeCompatibilityProof: execution.createWindowsAppContainerNodeCompatibilityProof,
    WINDOWS_APPCONTAINER_NODE_COMPATIBILITY: execution.WINDOWS_APPCONTAINER_NODE_COMPATIBILITY,
    McpStdioClient: mcp.McpStdioClient,
    ...codeIntel
  };
}

async function writeEvidence(outputPath, evidence) {
  const output = path.resolve(outputPath);
  const temporary = `${output}.${process.pid}.tmp`;
  await mkdir(path.dirname(output), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await rm(output, { force: true });
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function runLspSandboxSmoke(options) {
  const layout = portableLayout(options.bundle, options.targetPlatform);
  const brokerPath = path.resolve(options.broker);
  requireFiles(layout, brokerPath);
  const [metadata, brokerDigest, nodeDigest, typescriptDigest, pyrightDigest] = await Promise.all([
    readFile(layout.metadata, "utf8").then(JSON.parse),
    sha256File(brokerPath),
    sha256File(layout.node),
    sha256File(layout.typescriptEntry),
    sha256File(layout.pyrightEntry)
  ]);
  assertMetadata(metadata, options.targetPlatform, brokerPath, brokerDigest, layout);
  if (metadata.node?.sha256 !== nodeDigest) throw new Error("Bundled Node digest does not match package metadata.");
  const integrity = await verifyPortableIntegrity(layout, metadata);

  const api = await importPortableApi(layout);
  const discovered = api.discoverLanguageServers({ nodeExecutable: layout.node, pathValue: "" });
  const discoveredTypescript = discovered.find((candidate) => candidate.id === "typescript");
  const discoveredPyright = discovered.find((candidate) => candidate.id === "python");
  if (discoveredTypescript?.available !== true || !discoveredTypescript.args.includes(layout.typescriptEntry)) {
    throw new Error("Portable TypeScript language server discovery did not resolve the packaged server.");
  }
  if (discoveredPyright?.available !== true || !discoveredPyright.args.includes(layout.pyrightEntry)) {
    throw new Error("Portable Pyright discovery did not resolve the packaged server.");
  }
  const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-lsp-sandbox-"));
  const broker = new api.SigmaExecBrokerClient({
    helperPath: brokerPath,
    sandboxMode: "required",
    trustedToolchains: [portableNodeToolchain(api, layout, metadata, integrity.manifest, nodeDigest)]
  });
  let doctor;
  try {
    doctor = await broker.connect();
    assertBrokerTarget(doctor, metadata.targetPlatform, metadata.targetArch);
    const typescript = await runTypeScriptSmoke(api, broker, workspace, layout);
    const pyright = await runPyrightSmoke(api, broker, workspace, layout);
    const mcp = await runMcpSandboxSmoke(api, broker, workspace, brokerPath);
    const evidence = {
      schemaVersion: 1,
      kind: "lspSandboxSmoke",
      ready: true,
      generatedAt: new Date().toISOString(),
      targetPlatform: metadata.targetPlatform,
      targetArch: metadata.targetArch,
      productVersion: metadata.productVersion,
      brokerSha256: brokerDigest,
      brokerPlatform: doctor.platform,
      brokerArchitecture: doctor.architecture,
      bundledNodeSha256: nodeDigest,
      integrityManifestSha256: integrity.manifestDigest,
      integrityEntries: integrity.entries,
      assets: { typescriptLanguageServerSha256: typescriptDigest, pyrightSha256: pyrightDigest },
      sandbox: {
        required: true,
        network: "none",
        writeRoots: [],
        backend: doctor.sandbox.backend,
        selfTestPassed: doctor.sandbox.selfTestPassed
      },
      checks: { packagedBrokerDigest: true, bundledNodeDigest: true, languageServerDiscovery: true, typescript, pyright, mcp }
    };
    await writeEvidence(options.output, evidence);
    return evidence;
  } finally {
    await broker.close().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const outputIndex = argv.indexOf("--output");
  const requestedOutput = outputIndex >= 0 ? argv[outputIndex + 1] : undefined;
  if (requestedOutput) await rm(path.resolve(requestedOutput), { force: true });
  const options = parseArguments(argv);
  const output = path.resolve(options.output);
  try {
    const evidence = await runLspSandboxSmoke(options);
    console.log(JSON.stringify(evidence));
  } catch (error) {
    await rm(output, { force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
