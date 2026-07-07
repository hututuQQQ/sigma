import type { ProjectProfile } from "./project-detector.js";
import { detectProjectProfile } from "./project-detector.js";
import {
  explicitValidationCommandSpecs,
  genericValidationCommandSpecs,
  type ValidationCommandSpec
} from "./validation.js";

const DEFAULT_MAX_VALIDATION_COMMANDS = 12;

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

function nodeTypecheckCommand(profile: ProjectProfile): string | null {
  const scripts = profile.node.scripts;
  const packageManager = profile.node.packageManager;
  const explicitScript = ["typecheck", "type-check", "check:types", "tsc"].find((name) => scripts[name]);
  if (explicitScript) {
    return guardCommand(packageManagerExecutable(packageManager), nodeScriptCommand(packageManager, explicitScript));
  }
  if (!profile.node.hasTypeScript || !profile.node.tscLikelyAvailable) return null;
  if (packageManager === "pnpm") return guardCommand("pnpm", "pnpm exec tsc --noEmit");
  if (packageManager === "yarn") return guardCommand("yarn", "yarn tsc --noEmit");
  if (packageManager === "bun") return guardCommand("bun", "bun x tsc --noEmit");
  return guardCommand("npx", "npx tsc --noEmit");
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
    ? guardCommand("uv", "uv run pytest -q")
    : "python -m pytest -q";
  return [{ source: "project-python", command, relatedFiles }];
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
  const specs = [
    ...explicitValidationCommandSpecs(options.configuredCommands ?? []),
    ...genericValidationCommandSpecs(options.changedFiles ?? []),
    ...projectLevelSpecs(profile)
  ];
  return dedupeAndBoundValidationSpecs(specs, options.maxCommands);
}
