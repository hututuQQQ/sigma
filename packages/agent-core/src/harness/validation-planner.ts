import type { ProjectProfile } from "./project-detector.js";
import { detectProjectProfile } from "./project-detector.js";
import {
  explicitValidationCommandSpecs,
  genericValidationCommandSpecs,
  type ValidationCommandSpec
} from "./validation.js";

const DEFAULT_MAX_VALIDATION_COMMANDS = 12;
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
  "makefile",
  "Dockerfile",
  "biome.json",
  "deno.json",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "nx.json",
  "turbo.json"
]);
const PROJECT_RELEVANT_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|sh|bash|zsh|go|rs|java|kt|kts|c|cc|cpp|cxx|h|hpp|cs|rb|php|swift|scala|sql)$/i;

export interface ValidationPlanOptions {
  workspacePath: string;
  configuredCommands?: string[];
  changedFiles?: string[];
  maxCommands?: number;
  profile?: ProjectProfile;
}

function guardCommand(tool: string, command: string): string {
  return `if command -v ${tool} >/dev/null 2>&1; then ${command}; else echo '${tool} not found for validation' >&2; exit 127; fi`;
}

function nodeScriptCommand(packageManager: ProjectProfile["node"]["packageManager"], script: string): string {
  if (packageManager === "npm") {
    return script === "test" ? "npm test" : `npm run ${script}`;
  }
  if (packageManager === "pnpm") {
    return script === "test" ? "pnpm test" : `pnpm run ${script}`;
  }
  if (packageManager === "yarn") {
    return `yarn ${script}`;
  }
  return script === "test" ? "bun test" : `bun run ${script}`;
}

function packageManagerExecutable(packageManager: ProjectProfile["node"]["packageManager"]): string {
  return packageManager;
}

function localOrGlobalTscCommand(): string {
  return [
    "if [ -f ./node_modules/.bin/tsc ]; then ./node_modules/.bin/tsc --noEmit",
    "elif [ -f ./node_modules/.bin/tsc.cmd ]; then ./node_modules/.bin/tsc.cmd --noEmit",
    "elif command -v tsc >/dev/null 2>&1; then tsc --noEmit",
    "else echo 'tsc not found for validation' >&2; exit 127; fi"
  ].join("; ");
}

function nodeTypecheckCommand(profile: ProjectProfile): string | null {
  const scripts = profile.node.scripts;
  const packageManager = profile.node.packageManager;
  const explicitScript = ["typecheck", "type-check", "check:types", "tsc"].find((name) => scripts[name]);
  if (explicitScript) {
    return guardCommand(packageManagerExecutable(packageManager), nodeScriptCommand(packageManager, explicitScript));
  }
  if (!profile.node.hasTypeScript || !profile.node.tscLikelyAvailable) return null;
  return localOrGlobalTscCommand();
}

function nodeProjectSpecs(profile: ProjectProfile): ValidationCommandSpec[] {
  if (!profile.node.hasPackageJson) return [];
  const scripts = profile.node.scripts;
  const packageManager = profile.node.packageManager;
  const relatedFiles = ["package.json"];
  const specs: ValidationCommandSpec[] = [];

  if (scripts.test) {
    specs.push({
      source: "project-node",
      command: guardCommand(packageManagerExecutable(packageManager), nodeScriptCommand(packageManager, "test")),
      relatedFiles
    });
  }
  if (scripts.build) {
    specs.push({
      source: "project-node",
      command: guardCommand(packageManagerExecutable(packageManager), nodeScriptCommand(packageManager, "build")),
      relatedFiles
    });
  }
  const typecheck = nodeTypecheckCommand(profile);
  if (typecheck) {
    specs.push({ source: "project-node", command: typecheck, relatedFiles });
  }
  return specs;
}

function pythonProjectSpecs(profile: ProjectProfile): ValidationCommandSpec[] {
  if (!profile.python.hasPython || !profile.python.pytestLikely) return [];
  const relatedFiles = [
    profile.python.hasPyproject ? "pyproject.toml" : "",
    profile.python.hasRequirements ? "requirements.txt" : "",
    profile.python.hasSetupPy ? "setup.py" : "",
    profile.python.hasPytestConfig ? "pytest.ini" : "",
    profile.python.hasUvLock ? "uv.lock" : ""
  ].filter(Boolean);
  const command = profile.python.prefersUv
    ? "if command -v uv >/dev/null 2>&1; then uv run pytest -q; else python -m pytest -q; fi"
    : "python -m pytest -q";
  return [{ source: "project-python", command, relatedFiles }];
}

function isProjectRelevantChangedFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  if (PROJECT_RELEVANT_BASE_NAMES.has(base)) return true;
  if (/^\.github\/workflows\//.test(normalized)) return true;
  if (/(^|\/)(eslint|prettier|vitest|vite|webpack|rollup|babel|jest|mocha|pytest|ruff|mypy|tsup|turbo|nx)\.config\./i.test(normalized)) {
    return true;
  }
  if (/(^|\/)(?:tsconfig|jsconfig)(?:\.[^/]+)?\.json$/i.test(normalized)) {
    return true;
  }
  if (/(^|\/)\.(?:eslintrc|prettierrc|npmrc|yarnrc|node-version|python-version)(?:\.|$)/i.test(normalized)) {
    return true;
  }
  return PROJECT_RELEVANT_EXTENSIONS.test(base);
}

function projectLevelSpecs(profile: ProjectProfile): ValidationCommandSpec[] {
  const specs: ValidationCommandSpec[] = [
    ...nodeProjectSpecs(profile),
    ...pythonProjectSpecs(profile)
  ];
  if (profile.hasGoMod) {
    specs.push({
      source: "project-go",
      command: guardCommand("go", "go test ./..."),
      relatedFiles: ["go.mod"]
    });
  }
  if (profile.hasCargoToml) {
    specs.push({
      source: "project-rust",
      command: guardCommand("cargo", "cargo test --quiet"),
      relatedFiles: ["Cargo.toml"]
    });
  }
  if (profile.hasPomXml) {
    specs.push({
      source: "project-maven",
      command: guardCommand("mvn", "mvn test -q"),
      relatedFiles: ["pom.xml"]
    });
  }
  if (profile.hasGradle) {
    specs.push({
      source: "project-gradle",
      command: profile.hasGradleWrapper ? "./gradlew test" : guardCommand("gradle", "gradle test"),
      relatedFiles: [profile.files.has("build.gradle.kts") ? "build.gradle.kts" : "build.gradle"]
    });
  }
  if (profile.hasMakefile && profile.makeTargets.has("test")) {
    specs.push({
      source: "project-make",
      command: guardCommand("make", "make test"),
      relatedFiles: [profile.files.has("Makefile") ? "Makefile" : "makefile"]
    });
  }
  return specs;
}

export function dedupeAndBoundValidationSpecs(
  specs: ValidationCommandSpec[],
  maxCommands = DEFAULT_MAX_VALIDATION_COMMANDS
): ValidationCommandSpec[] {
  const seen = new Set<string>();
  const bounded: ValidationCommandSpec[] = [];
  const limit = Math.max(1, Math.floor(maxCommands));
  for (const spec of specs) {
    const command = spec.command.trim();
    if (!command || seen.has(command)) continue;
    seen.add(command);
    bounded.push({ ...spec, command });
    if (bounded.length >= limit) break;
  }
  return bounded;
}

export async function planValidationCommandSpecs(options: ValidationPlanOptions): Promise<ValidationCommandSpec[]> {
  const profile = options.profile ?? await detectProjectProfile(options.workspacePath);
  const configuredSpecs = explicitValidationCommandSpecs(options.configuredCommands ?? []);
  const changedFiles = options.changedFiles ?? [];
  const includeProjectLevelSpecs = changedFiles.some(isProjectRelevantChangedFile);
  const specs = [
    ...configuredSpecs,
    ...genericValidationCommandSpecs(changedFiles),
    ...(includeProjectLevelSpecs ? projectLevelSpecs(profile) : [])
  ];
  return dedupeAndBoundValidationSpecs(specs, options.maxCommands);
}
