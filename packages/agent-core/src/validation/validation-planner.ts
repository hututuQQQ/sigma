import path from "node:path";
import { withEstimatedCost } from "./command-cost.js";
import { discoverProjects } from "./project-discovery.js";
import type {
  DiscoveredProjectRoot,
  ProjectDiscoveryResult,
  ValidationCandidate,
  ValidationPlan,
  ValidationPlannerOptions
} from "./validation-types.js";

export type { ValidationPlan, ValidationPlannerOptions } from "./validation-types.js";

const DEFAULT_TIMEOUT_SEC = 60;
const DEFAULT_MAX_COMMANDS = 12;
const PROJECT_RELEVANT_BASE_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "tsconfig.json",
  "jsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "setup.cfg",
  "pytest.ini",
  "tox.ini",
  "uv.lock",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gradle.properties",
  "gradlew",
  "Makefile",
  "makefile"
]);
const PROJECT_RELEVANT_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|sh|bash|zsh|go|rs|java|kt|kts|c|cc|cpp|cxx|h|hpp|cs|rb|php|swift|scala|sql)$/i;

function normalizeRelative(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isProjectRelevantChangedFile(filePath: string): boolean {
  const normalized = normalizeRelative(filePath);
  const base = normalized.split("/").pop() ?? normalized;
  if (PROJECT_RELEVANT_BASE_NAMES.has(base)) return true;
  if (/^\.github\/workflows\//.test(normalized)) return true;
  if (/(^|\/)(eslint|prettier|vitest|vite|webpack|rollup|babel|jest|mocha|pytest|ruff|mypy|tsup|turbo|nx)\.config\./i.test(normalized)) return true;
  if (/(^|\/)(?:tsconfig|jsconfig)(?:\.[^/]+)?\.json$/i.test(normalized)) return true;
  if (/(^|\/)\.(?:eslintrc|prettierrc|npmrc|yarnrc|node-version|python-version)(?:\.|$)/i.test(normalized)) return true;
  return PROJECT_RELEVANT_EXTENSIONS.test(base);
}

function guardCommand(tool: string, command: string): string {
  return `if command -v ${tool} >/dev/null 2>&1; then ${command}; else echo '${tool} not found for validation' >&2; exit 127; fi`;
}

function relativeToRoot(root: DiscoveredProjectRoot, filePath: string): string {
  const normalized = normalizeRelative(filePath);
  if (!root.relativeRoot) return normalized;
  return normalized.startsWith(`${root.relativeRoot}/`) ? normalized.slice(root.relativeRoot.length + 1) : normalized;
}

function nodeScriptCommand(packageManager: NonNullable<DiscoveredProjectRoot["packageManager"]>, script: string, extraArgs = ""): string {
  const suffix = extraArgs ? ` -- ${extraArgs}` : "";
  if (packageManager === "npm") return script === "test" ? `npm test${suffix}` : `npm run ${script}${suffix}`;
  if (packageManager === "pnpm") return script === "test" ? `pnpm test${suffix}` : `pnpm run ${script}${suffix}`;
  if (packageManager === "yarn") return `yarn ${script}${suffix}`;
  return script === "test" ? `bun test${extraArgs ? ` ${extraArgs}` : ""}` : `bun run ${script}${suffix}`;
}

function localOrGlobalTscCommand(): string {
  return [
    "if [ -f ./node_modules/.bin/tsc ]; then ./node_modules/.bin/tsc --noEmit",
    "elif [ -f ./node_modules/.bin/tsc.cmd ]; then ./node_modules/.bin/tsc.cmd --noEmit",
    "elif command -v tsc >/dev/null 2>&1; then tsc --noEmit",
    "else echo 'tsc not found for validation' >&2; exit 127; fi"
  ].join("; ");
}

function candidate(options: Omit<ValidationCandidate, "cost"> & { cost?: ValidationCandidate["cost"] }): ValidationCandidate {
  return withEstimatedCost(options);
}

function syntaxCandidates(discovery: ProjectDiscoveryResult, timeoutSec: number): ValidationCandidate[] {
  const candidates: ValidationCandidate[] = [];
  for (const file of discovery.changedFiles) {
    const quoted = shellQuote(file);
    if (file.endsWith(".py")) {
      candidates.push(candidate({
        command: `python -m py_compile ${quoted}`,
        cwd: discovery.workspacePath,
        scope: "syntax",
        kind: "compile",
        relatedFiles: [file],
        reason: "Changed Python file can be bytecode-compiled cheaply.",
        timeoutSec,
        analyzerHints: ["python", "compile"],
        source: "changed-file"
      }));
    } else if (file.endsWith(".sh") || file.endsWith(".bash") || file.endsWith(".zsh")) {
      candidates.push(candidate({
        command: `bash -n ${quoted}`,
        cwd: discovery.workspacePath,
        scope: "syntax",
        kind: "compile",
        relatedFiles: [file],
        reason: "Changed shell script can be syntax-checked cheaply.",
        timeoutSec,
        analyzerHints: ["shell", "compile"],
        source: "changed-file"
      }));
    } else if (/\.(?:js|mjs|cjs)$/.test(file)) {
      candidates.push(candidate({
        command: guardCommand("node", `node --check ${quoted}`),
        cwd: discovery.workspacePath,
        scope: "syntax",
        kind: "compile",
        relatedFiles: [file],
        reason: "Changed JavaScript file can be parsed with node --check.",
        timeoutSec,
        analyzerHints: ["node", "compile"],
        source: "changed-file"
      }));
    }
  }
  return candidates;
}

function focusedTestCandidates(root: DiscoveredProjectRoot, files: string[], timeoutSec: number): ValidationCandidate[] {
  const candidates: ValidationCandidate[] = [];
  for (const file of files) {
    const inRoot = relativeToRoot(root, file);
    const quoted = shellQuote(inRoot);
    if (root.type === "python" && /(^|\/)(test_.*|.*_test)\.py$|(^|\/)tests\/.*\.py$/.test(inRoot)) {
      candidates.push(candidate({
        command: `python -m pytest -q ${quoted}`,
        cwd: root.root,
        scope: "focused",
        kind: "test",
        relatedFiles: [file],
        reason: "Changed file looks like a pytest test, so run that test file first.",
        timeoutSec,
        analyzerHints: ["pytest"],
        source: "focused-python"
      }));
    }
    if (root.type === "node" && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(inRoot)) {
      const pm = root.packageManager ?? "npm";
      const scripts = root.scripts ?? {};
      if (scripts.test) {
        candidates.push(candidate({
          command: guardCommand(pm, nodeScriptCommand(pm, "test", quoted)),
          cwd: root.root,
          scope: "focused",
          kind: "test",
          relatedFiles: [file],
          reason: "Changed file looks like a Node test, so pass that file to the package test script.",
          timeoutSec,
          analyzerHints: ["node-test"],
          source: "focused-node"
        }));
      }
    }
  }
  return candidates;
}

function nodeCandidates(root: DiscoveredProjectRoot, relatedFiles: string[], timeoutSec: number): ValidationCandidate[] {
  if (root.type !== "node") return [];
  const pm = root.packageManager ?? "npm";
  const scripts = root.scripts ?? {};
  const candidates: ValidationCandidate[] = [];
  const related = relatedFiles.length > 0 ? relatedFiles : root.markerFiles.map((file) => path.posix.join(root.relativeRoot, file).replace(/^\//, ""));
  const addScript = (script: string, kind: ValidationCandidate["kind"], reason: string, source: string) => {
    if (!scripts[script]) return;
    candidates.push(candidate({
      command: guardCommand(pm, nodeScriptCommand(pm, script)),
      cwd: root.root,
      scope: "package",
      kind,
      relatedFiles: related,
      reason,
      timeoutSec,
      analyzerHints: [kind === "test" ? "node-test" : "typescript"],
      source
    }));
  };
  const typecheckScript = ["typecheck", "type-check", "check:types", "tsc"].find((script) => scripts[script]);
  if (typecheckScript) addScript(typecheckScript, "typecheck", "Package declares a typecheck script.", "package-node");
  else if (related.some((file) => /\.(?:ts|tsx)$/.test(file)) || root.markerFiles.includes("tsconfig.json")) {
    candidates.push(candidate({
      command: localOrGlobalTscCommand(),
      cwd: root.root,
      scope: "package",
      kind: "typecheck",
      relatedFiles: related,
      reason: "Changed TypeScript files or config make a package typecheck relevant.",
      timeoutSec,
      analyzerHints: ["typescript"],
      source: "package-node"
    }));
  }
  addScript("test", "test", "Package declares a test script and changed files affect this package.", "package-node");
  addScript("build", "build", "Package declares a build script and changed files affect this package.", "package-node");
  addScript("lint", "lint", "Package declares a lint script and changed files affect this package.", "package-node");
  return candidates;
}

function packageCandidates(root: DiscoveredProjectRoot, relatedFiles: string[], timeoutSec: number): ValidationCandidate[] {
  if (root.type === "node") return nodeCandidates(root, relatedFiles, timeoutSec);
  const related = relatedFiles.length > 0 ? relatedFiles : root.markerFiles.map((file) => path.posix.join(root.relativeRoot, file).replace(/^\//, ""));
  if (root.type === "python") {
    const commandText = root.markerFiles.includes("uv.lock")
      ? "if command -v uv >/dev/null 2>&1; then uv run pytest -q; else python -m pytest -q; fi"
      : "python -m pytest -q";
    return [candidate({
      command: commandText,
      cwd: root.root,
      scope: "package",
      kind: "test",
      relatedFiles: related,
      reason: "Python project metadata and changed files make pytest relevant.",
      timeoutSec,
      analyzerHints: ["pytest"],
      source: "package-python"
    })];
  }
  if (root.type === "go") {
    return [candidate({
      command: guardCommand("go", "go test ./..."),
      cwd: root.root,
      scope: "package",
      kind: "test",
      relatedFiles: related,
      reason: "Changed files affect this Go module.",
      timeoutSec,
      analyzerHints: ["go-test"],
      source: "package-go"
    })];
  }
  if (root.type === "rust") {
    return [candidate({
      command: guardCommand("cargo", "cargo test --quiet"),
      cwd: root.root,
      scope: "package",
      kind: "test",
      relatedFiles: related,
      reason: "Changed files affect this Rust crate.",
      timeoutSec,
      analyzerHints: ["cargo"],
      source: "package-rust"
    })];
  }
  if (root.type === "maven") {
    return [candidate({
      command: guardCommand("mvn", "mvn test -q"),
      cwd: root.root,
      scope: "package",
      kind: "test",
      relatedFiles: related,
      reason: "Changed files affect this Maven project.",
      timeoutSec,
      analyzerHints: ["java"],
      source: "package-maven"
    })];
  }
  if (root.type === "gradle") {
    return [candidate({
      command: root.markerFiles.includes("gradlew") ? "./gradlew test" : guardCommand("gradle", "gradle test"),
      cwd: root.root,
      scope: "package",
      kind: "test",
      relatedFiles: related,
      reason: "Changed files affect this Gradle project.",
      timeoutSec,
      analyzerHints: ["java"],
      source: "package-gradle"
    })];
  }
  if (root.type === "make" && root.makeTargets?.includes("test")) {
    return [candidate({
      command: guardCommand("make", "make test"),
      cwd: root.root,
      scope: "package",
      kind: "test",
      relatedFiles: related,
      reason: "Makefile declares a test target.",
      timeoutSec,
      analyzerHints: ["generic"],
      source: "package-make"
    })];
  }
  return [];
}

function explicitCandidates(options: ValidationPlannerOptions, timeoutSec: number): ValidationCandidate[] {
  const seen = new Set<string>();
  const candidates: ValidationCandidate[] = [];
  for (const raw of options.configuredCommands ?? []) {
    const commandText = raw.trim();
    if (!commandText || seen.has(commandText)) continue;
    seen.add(commandText);
    candidates.push(candidate({
      command: commandText,
      cwd: path.resolve(options.workspacePath),
      scope: "project",
      kind: "manual-check",
      relatedFiles: [],
      reason: "User-configured validation commands always have highest priority.",
      timeoutSec,
      analyzerHints: ["configured"],
      source: "configured",
      cost: "medium"
    }));
  }
  return candidates;
}

function dedupeAndBound(candidates: ValidationCandidate[], maxCommands: number): ValidationCandidate[] {
  const seen = new Set<string>();
  const result: ValidationCandidate[] = [];
  for (const item of candidates) {
    const key = `${item.cwd}\0${item.command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= maxCommands) break;
  }
  return result;
}

export async function createValidationPlan(options: ValidationPlannerOptions): Promise<ValidationPlan> {
  const timeoutSec = options.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const maxCommands = Math.max(1, Math.floor(options.maxCommands ?? DEFAULT_MAX_COMMANDS));
  const discovery = await discoverProjects({
    workspacePath: options.workspacePath,
    changedFiles: options.changedFiles ?? []
  });
  const changedFiles = discovery.changedFiles;
  const byRoot = new Map<DiscoveredProjectRoot, string[]>();
  for (const file of changedFiles) {
    if (!isProjectRelevantChangedFile(file)) continue;
    const matchingRootNames = new Set(discovery.changedFileRoots[file] ?? []);
    for (const root of discovery.roots.filter((candidateRoot) => matchingRootNames.has(candidateRoot.relativeRoot))) {
      const current = byRoot.get(root) ?? [];
      current.push(file);
      byRoot.set(root, current);
    }
  }

  const explicit = explicitCandidates(options, timeoutSec);
  const syntax = syntaxCandidates(discovery, timeoutSec);
  const focused = [...byRoot.entries()].flatMap(([root, files]) => focusedTestCandidates(root, files, timeoutSec));
  const packages = [...byRoot.entries()].flatMap(([root, files]) => packageCandidates(root, files, timeoutSec));
  const skipped = discovery.skipped.map((item) => ({ ...item }));
  if (explicit.length === 0 && changedFiles.length === 0) {
    skipped.push({ reason: "No changed files or configured validation commands; skipping automatic validation plan.", relatedFiles: [] });
  }
  if (explicit.length === 0 && changedFiles.length > 0 && syntax.length === 0 && focused.length === 0 && packages.length === 0) {
    skipped.push({ reason: "Changed files did not map to a known cheap syntax check or discovered project command.", relatedFiles: changedFiles });
  }

  return {
    workspacePath: discovery.workspacePath,
    candidates: dedupeAndBound([...explicit, ...syntax, ...focused, ...packages], maxCommands),
    skipped
  };
}
