import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = path.join(root, "packages");
const productionExtensions = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const maximumProductionLines = 1_000;
const maximumTuiComponentLines = 250;

async function packageRecords() {
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(packagesRoot, entry.name);
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      records.push({ directory, manifest, name: manifest.name });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return records.sort((left, right) => left.name.localeCompare(right.name));
}

async function sourceFiles(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && productionExtensions.has(path.extname(entry.name))) files.push(absolute);
    }
  }
  try {
    await visit(path.join(directory, "src"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return files;
}

function workspaceDependencies(record, packageNames) {
  const sections = ["dependencies", "optionalDependencies", "peerDependencies"];
  return sections.flatMap((section) =>
    Object.keys(record.manifest[section] ?? {}).filter((dependency) => packageNames.has(dependency)),
  );
}

function packageCycles(records) {
  const names = new Set(records.map((record) => record.name));
  const graph = new Map(records.map((record) => [record.name, workspaceDependencies(record, names)]));
  const complete = new Set();
  const active = [];
  const cycles = new Set();

  function visit(name) {
    const activeIndex = active.indexOf(name);
    if (activeIndex >= 0) {
      cycles.add([...active.slice(activeIndex), name].join(" -> "));
      return;
    }
    if (complete.has(name)) return;
    active.push(name);
    for (const dependency of graph.get(name) ?? []) visit(dependency);
    active.pop();
    complete.add(name);
  }

  for (const name of graph.keys()) visit(name);
  return [...cycles];
}

function importSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s*)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function directSourceViolation(specifier, owner, byName) {
  for (const [packageName, target] of byName) {
    if (packageName !== owner.name && (specifier === `${packageName}/src` || specifier.startsWith(`${packageName}/src/`))) {
      return packageName;
    }
    if (!specifier.startsWith(".")) continue;
    const resolved = path.resolve(path.dirname(owner.file), specifier);
    const targetSource = path.join(target.directory, "src");
    if (packageName !== owner.name && (resolved === targetSource || resolved.startsWith(`${targetSource}${path.sep}`))) {
      return packageName;
    }
  }
  return undefined;
}

function childProcessViolation(specifier, record) {
  if (specifier !== "node:child_process" && specifier !== "child_process") return false;
  return record.name !== "agent-execution";
}

const records = await packageRecords();
const byName = new Map(records.map((record) => [record.name, record]));
const violations = packageCycles(records).map((cycle) => `package dependency cycle: ${cycle}`);

for (const record of records) {
  for (const file of await sourceFiles(record.directory)) {
    const source = await readFile(file, "utf8");
    const relative = path.relative(root, file).replaceAll(path.sep, "/");
    const lineCount = source.length === 0 ? 0 : source.split(/\r?\n/).length - (source.endsWith("\n") ? 1 : 0);
    const lineLimit = relative.startsWith("packages/agent-tui/src/") ? maximumTuiComponentLines : maximumProductionLines;
    if (lineCount > lineLimit) {
      violations.push(`${relative}: ${lineCount} lines exceeds the ${lineLimit}-line production limit`);
    }
    const owner = { ...record, file };
    for (const specifier of importSpecifiers(source)) {
      if (specifier === "node:child_process" && record.name !== "agent-execution") {
        violations.push(`${relative}: only agent-execution may import node:child_process`);
      }
      const target = directSourceViolation(specifier, owner, byName);
      if (target) violations.push(`${relative}: imports private source from ${target} via ${specifier}`);
      if (childProcessViolation(specifier, record)) {
        violations.push(`${relative}: imports ${specifier}; arbitrary process creation is owned exclusively by agent-execution`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Architecture guard failed:\n" + violations.map((violation) => `- ${violation}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Architecture guard passed (${records.length} packages, max ${maximumProductionLines} production lines).`);
}
