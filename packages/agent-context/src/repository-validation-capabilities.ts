import path from "node:path";
import { withHostRepositorySnapshot } from "./repository-host-snapshot.js";

const MAX_MANIFEST_BYTES = 256_000;
const PROJECT_MANIFEST = /(?:^|\/)(?:package\.json|pyproject\.toml|pytest\.ini|setup\.cfg|go\.mod|go\.work|cargo\.toml|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gemfile|rakefile|_config\.ya?ml|makefile|gnumakefile|cmakelists\.txt|meson\.build|[^/]+\.(?:csproj|fsproj|vbproj|sln))$/iu;
const TEST_FILE = /(?:^|\/)(?:tests?|specs?|__tests__)(?:\/|$)|(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$|_test\.go$|\.(?:test|spec)\.[cm]?[jt]sx?$/iu;
const TEST_CONFIG = /(?:^|\/)(?:vitest|jest|playwright|pytest|tox|nose|mocha)(?:\.config)?\.[^/]+$|(?:^|\/)conftest\.py$/iu;
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|cs|fs|vb)$/iu;
const SOURCE_WITHOUT_VALIDATION_CAPABILITY = /\.(?:swift|c|cc|cpp|h|hpp)$/iu;

export function isRepositorySourcePath(file: string): boolean {
  return SOURCE_EXTENSION.test(file) || SOURCE_WITHOUT_VALIDATION_CAPABILITY.test(file);
}

/** False means the structural profile has no language-specific evidence model
 * for this path, so it must not be used as a negative capability proof. This
 * deliberately excludes configuration, unknown, and known-but-unsupported
 * source formats; absence of a recognized validator is not proof for them. */
export function repositoryValidationCapabilityCoversPath(file: string): boolean {
  return SOURCE_EXTENSION.test(file);
}

export interface ProjectValidationCapabilities {
  projectId: string;
  unit: boolean;
  staticClaims: Array<"syntax" | "typecheck">;
  evidence: string[];
  commandFamilies: string[];
}

export interface RepositoryValidationCapabilityProfile {
  stateDigest: string;
  complete: boolean;
  availableCommands: string[];
  availableCommandsComplete: boolean;
  projects: ProjectValidationCapabilities[];
}

export interface ValidationCapabilityOptions {
  stateDigest: string;
  availableCommands: readonly string[];
  availableCommandsComplete?: boolean;
  deadlineMs?: number;
}

function portableDirectory(file: string): string {
  const directory = path.posix.dirname(file);
  return directory === "." ? "." : directory;
}

function withinProject(file: string, root: string): boolean {
  return root === "." || file === root || file.startsWith(`${root}/`);
}

function nearestProject(file: string, roots: readonly string[]): string {
  return roots.filter((root) => withinProject(file, root))
    .sort((left, right) => right.length - left.length)[0] ?? ".";
}

function commandNames(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => path.basename(value).toLowerCase()
    .replace(/\.(?:exe|cmd|bat|ps1)$/u, "")));
}

function commandAvailable(commands: ReadonlySet<string>, ...names: string[]): boolean {
  return names.some((name) => commands.has(name));
}

function packageTestScript(content: string | null): string | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as { scripts?: Record<string, unknown> };
    const script = typeof parsed.scripts?.test === "string" ? parsed.scripts.test.trim() : "";
    if (!script || /(?:no tests? specified|not implemented|todo)|(?:^|\s)exit\s+1(?:\s|$)/iu.test(script)) return null;
    return script;
  } catch {
    return null;
  }
}

function packageTypecheckScript(content: string | null): boolean {
  if (!content) return false;
  try {
    const parsed = JSON.parse(content) as { scripts?: Record<string, unknown> };
    return Object.entries(parsed.scripts ?? {}).some(([name, value]) =>
      /^(?:typecheck|check-types)$/iu.test(name) && typeof value === "string" && value.trim().length > 0);
  } catch {
    return false;
  }
}

function packageBuildScripts(content: string | null): Array<{ name: string; script: string }> {
  if (!content) return [];
  try {
    const parsed = JSON.parse(content) as { scripts?: Record<string, unknown> };
    return Object.entries(parsed.scripts ?? {}).flatMap(([name, value]) => {
      if (!/^(?:build|check|verify)$/iu.test(name) || typeof value !== "string") return [];
      const script = value.trim();
      if (!script || /(?:not implemented|todo)|(?:^|\s)exit\s+1(?:\s|$)/iu.test(script)) return [];
      return [{ name: name.toLowerCase(), script }];
    });
  } catch {
    return [];
  }
}

function hasRuntimeForPath(file: string, commands: ReadonlySet<string>): boolean {
  if (/\.[cm]?jsx?$/iu.test(file)) return commandAvailable(commands, "node", "bun", "deno");
  if (/\.tsx?$/iu.test(file)) return commandAvailable(commands, "tsc", "deno", "bun");
  if (/\.py$/iu.test(file)) return commandAvailable(commands, "python", "python3", "py", "pytest");
  if (/\.go$/iu.test(file)) return commands.has("go");
  if (/\.rs$/iu.test(file)) return commandAvailable(commands, "cargo", "rustc");
  if (/\.(?:cs|fs|vb)$/iu.test(file)) return commands.has("dotnet");
  if (/\.(?:java|kt)$/iu.test(file)) return commandAvailable(commands, "mvn", "gradle", "java", "javac", "kotlinc");
  return false;
}

function packageScriptExecutable(script: string, commands: ReadonlySet<string>): boolean {
  if (commandAvailable(commands, "npm", "pnpm", "yarn", "bun")) return true;
  if (/^node(?:\.exe)?\s+--test(?:\s|$)/iu.test(script)) return commands.has("node");
  return false;
}

interface ProjectCapabilityInput {
  root: string;
  files: readonly string[];
  manifests: ReadonlyMap<string, string | null>;
  commands: ReadonlySet<string>;
}

interface CapabilityAccumulator {
  evidence: string[];
  commandFamilies: Set<string>;
  unit: boolean;
}

function projectManifest(root: string, name: string): string {
  return root === "." ? name : `${root}/${name}`;
}

function projectWrapper(input: ProjectCapabilityInput, names: readonly string[]): string | undefined {
  return names.map((name) => projectManifest(input.root, name))
    .find((candidate) => input.files.includes(candidate));
}

function addUnitCapability(
  target: CapabilityAccumulator,
  available: boolean,
  commandFamily: string
): void {
  if (!available) return;
  target.unit = true;
  target.commandFamilies.add(commandFamily);
}

function packageCapabilities(input: ProjectCapabilityInput, target: CapabilityAccumulator): boolean {
  const { root, manifests, commands } = input;
  const packagePath = root === "." ? "package.json" : `${root}/package.json`;
  const packageContent = manifests.get(packagePath) ?? null;
  const packageScript = packageTestScript(packageContent);
  const packageTypecheck = packageTypecheckScript(packageContent);
  const testAvailable = Boolean(packageScript && packageScriptExecutable(packageScript, commands));
  if (testAvailable) {
    target.evidence.push(`${packagePath}#scripts.test`);
    addUnitCapability(target, true, "package-manager test");
  }
  for (const { name, script } of packageBuildScripts(packageContent)) {
    if (!packageScriptExecutable(script, commands)) continue;
    target.commandFamilies.add(`package-manager ${name}`);
    target.evidence.push(`${packagePath}#scripts.${name}`);
  }
  return packageTypecheck;
}

function discoveredTestCapabilities(
  tests: readonly string[],
  commands: ReadonlySet<string>,
  target: CapabilityAccumulator
): void {
  addUnitCapability(target,
    tests.some((file) => /\.[cm]?jsx?$/iu.test(file)) && commands.has("node"),
    "node --test");
  addUnitCapability(target,
    tests.some((file) => /\.py$/iu.test(file))
      && commandAvailable(commands, "python", "python3", "py", "pytest"),
    "python -m unittest/pytest");
  addUnitCapability(target,
    tests.some((file) => /_test\.go$/iu.test(file)) && commands.has("go"),
    "go test");
}

function projectManifestMatches(
  input: ProjectCapabilityInput,
  pattern: RegExp
): boolean {
  return [...input.manifests.keys()].some((file) =>
    withinProject(file, input.root) && pattern.test(file));
}

function manifestUnitCapabilities(
  input: ProjectCapabilityInput,
  hasTests: boolean,
  target: CapabilityAccumulator
): void {
  const { root, manifests, commands } = input;
  addUnitCapability(target,
    manifests.has(projectManifest(root, "Cargo.toml")) && commands.has("cargo"),
    "cargo test");
  addUnitCapability(target,
    hasTests && commands.has("dotnet")
      && projectManifestMatches(input, /\.(?:csproj|fsproj|vbproj|sln)$/iu),
    "dotnet test");
  const pom = projectManifest(root, "pom.xml");
  const mavenWrapper = projectWrapper(input, ["mvnw", "mvnw.cmd"]);
  const maven = manifests.has(pom) && (commandAvailable(commands, "mvn") || mavenWrapper !== undefined);
  if (maven) {
    target.commandFamilies.add("maven build/check");
    target.evidence.push(pom, ...(mavenWrapper ? [mavenWrapper] : []));
  }
  addUnitCapability(target, hasTests && maven, "maven test");

  const gradleManifest = [...manifests.keys()].find((file) =>
    withinProject(file, root) && /(?:^|\/)build\.gradle(?:\.kts)?$/iu.test(file));
  const gradleWrapper = projectWrapper(input, ["gradlew", "gradlew.bat"]);
  const gradle = gradleManifest !== undefined
    && (commandAvailable(commands, "gradle") || gradleWrapper !== undefined);
  if (gradle) {
    target.commandFamilies.add("gradle build/check");
    target.evidence.push(gradleManifest, ...(gradleWrapper ? [gradleWrapper] : []));
  }
  addUnitCapability(target, hasTests && gradle, "gradle test");
}

function manifestBuildCapabilities(
  input: ProjectCapabilityInput,
  target: CapabilityAccumulator
): void {
  const { root, manifests, commands } = input;
  const candidates = (names: readonly string[]): string | undefined => names
    .map((name) => projectManifest(root, name))
    .find((name) => manifests.has(name));
  const makefile = candidates(["Makefile", "makefile", "GNUmakefile"]);
  if (makefile && commandAvailable(commands, "make", "gmake")) {
    target.commandFamilies.add("make build/check");
    target.evidence.push(makefile);
  }
  const cmake = candidates(["CMakeLists.txt"]);
  if (cmake && commands.has("cmake")) {
    target.commandFamilies.add("cmake build/check");
    target.evidence.push(cmake);
  }
  const meson = candidates(["meson.build"]);
  if (meson && commands.has("meson")) {
    target.commandFamilies.add("meson build/check");
    target.evidence.push(meson);
  }
  const gemfile = candidates(["Gemfile"]);
  const jekyll = candidates(["_config.yml", "_config.yaml"]);
  if ((gemfile || jekyll) && commandAvailable(commands, "bundle", "jekyll")) {
    target.commandFamilies.add(jekyll ? "jekyll build" : "bundle/ruby build");
    target.evidence.push(...[gemfile, jekyll].filter((item): item is string => item !== undefined));
  }
}

function staticCapabilities(
  source: readonly string[],
  commands: ReadonlySet<string>,
  packageTypecheck: boolean,
  commandFamilies: Set<string>
): Array<"syntax" | "typecheck"> {
  const claims = new Set<"syntax" | "typecheck">();
  const nodeSyntax = source.some((file) => /\.[cm]?jsx?$/iu.test(file)) && commands.has("node");
  if (nodeSyntax) {
    claims.add("syntax");
    commandFamilies.add("node --check <file>");
  }
  const pythonSyntax = source.some((file) => /\.py$/iu.test(file))
    && commandAvailable(commands, "python", "python3", "py");
  if (pythonSyntax) {
    claims.add("syntax");
    commandFamilies.add("python -m py_compile <file>");
  }
  const typescript = source.some((file) => /\.tsx?$/iu.test(file));
  const packageTypecheckAvailable = packageTypecheck
    && commandAvailable(commands, "npm", "pnpm", "yarn", "bun");
  if (typescript && (commandAvailable(commands, "tsc", "deno") || packageTypecheckAvailable)) {
    claims.add("typecheck");
    commandFamilies.add("typecheck");
  }
  const compiled = source.some((file) => /\.(?:go|rs|cs|fs|vb|java|kt)$/iu.test(file));
  if (compiled && source.some((file) => hasRuntimeForPath(file, commands))) {
    claims.add("syntax");
    commandFamilies.add("language build/check");
  }
  return [...claims].sort();
}

function projectCapabilities(input: ProjectCapabilityInput): ProjectValidationCapabilities {
  const { root, files, commands } = input;
  const target: CapabilityAccumulator = { evidence: [], commandFamilies: new Set(), unit: false };
  const packageTypecheck = packageCapabilities(input, target);
  const tests = files.filter((file) => TEST_FILE.test(file));
  const testConfigs = files.filter((file) => TEST_CONFIG.test(file));
  target.evidence.push(...tests.slice(0, 20), ...testConfigs.slice(0, 10));
  discoveredTestCapabilities(tests, commands, target);
  manifestUnitCapabilities(input, tests.length > 0, target);
  manifestBuildCapabilities(input, target);
  const source = files.filter((file) => SOURCE_EXTENSION.test(file));
  return {
    projectId: root,
    unit: target.unit,
    staticClaims: staticCapabilities(source, commands, packageTypecheck, target.commandFamilies),
    evidence: [...new Set(target.evidence)].sort(),
    commandFamilies: [...target.commandFamilies].sort()
  };
}

export function projectCapabilitiesForPath(
  profile: RepositoryValidationCapabilityProfile,
  file: string
): ProjectValidationCapabilities | undefined {
  const root = nearestProject(file.replaceAll("\\", "/"), profile.projects.map((item) => item.projectId));
  return profile.projects.find((item) => item.projectId === root);
}

export function staticValidationClaimsForPath(
  profile: RepositoryValidationCapabilityProfile,
  file: string
): Array<"syntax" | "typecheck"> {
  const project = projectCapabilitiesForPath(profile, file);
  if (!project) return [];
  const commands = new Set(profile.availableCommands);
  const claims: Array<"syntax" | "typecheck"> = [];
  if (project.staticClaims.includes("syntax") && hasRuntimeForPath(file, commands)
    && !/\.tsx?$/iu.test(file)) claims.push("syntax");
  if (project.staticClaims.includes("typecheck") && /\.tsx?$/iu.test(file)) claims.push("typecheck");
  return claims;
}

export async function deriveRepositoryValidationCapabilities(
  workspace: string,
  signal: AbortSignal,
  options: ValidationCapabilityOptions
): Promise<RepositoryValidationCapabilityProfile> {
  const commands = commandNames(options.availableCommands);
  const deadline = performance.now() + (options.deadlineMs ?? 2_000);
  return await withHostRepositorySnapshot(workspace, signal, { deadline }, async (snapshot, access) => {
    const manifestPaths = snapshot.files.filter((file) => PROJECT_MANIFEST.test(file));
    const manifests = new Map<string, string | null>();
    let manifestsComplete = true;
    for (const file of manifestPaths) {
      const loaded = await access.readText(file, MAX_MANIFEST_BYTES, signal);
      if (loaded.rejected) manifestsComplete = false;
      manifests.set(file, loaded.rejected ? null : loaded.content);
    }
    const roots = [...new Set([".", ...manifestPaths.map(portableDirectory)])]
      .sort((left, right) => left.length - right.length || left.localeCompare(right));
    const filesByRoot = new Map(roots.map((root) => [root, [] as string[]]));
    for (const file of snapshot.files) filesByRoot.get(nearestProject(file, roots))!.push(file);
    return {
      stateDigest: options.stateDigest,
      complete: options.availableCommandsComplete === true
        && manifestsComplete && !snapshot.truncated && !snapshot.deadlineReached,
      availableCommands: [...commands].sort(),
      availableCommandsComplete: options.availableCommandsComplete === true,
      projects: roots.map((root) => projectCapabilities({
        root,
        files: filesByRoot.get(root) ?? [],
        manifests,
        commands
      }))
    };
  });
}
