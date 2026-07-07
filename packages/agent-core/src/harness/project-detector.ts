import { access, readFile } from "node:fs/promises";
import path from "node:path";

export type NodePackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface NodeProjectProfile {
  packageJsonPath?: string;
  packageManager: NodePackageManager;
  scripts: Record<string, string>;
  hasPackageJson: boolean;
  hasLockfile: boolean;
  hasTypeScript: boolean;
  hasLocalTsc: boolean;
  tscLikelyAvailable: boolean;
}

export interface PythonProjectProfile {
  hasPython: boolean;
  hasPyproject: boolean;
  hasRequirements: boolean;
  hasSetupPy: boolean;
  hasPytestConfig: boolean;
  hasUvLock: boolean;
  prefersUv: boolean;
  pytestLikely: boolean;
}

export interface ProjectProfile {
  workspacePath: string;
  files: Set<string>;
  node: NodeProjectProfile;
  python: PythonProjectProfile;
  hasGoMod: boolean;
  hasCargoToml: boolean;
  hasPomXml: boolean;
  hasGradle: boolean;
  hasGradleWrapper: boolean;
  hasMakefile: boolean;
  makeTargets: Set<string>;
}

async function exists(workspacePath: string, relativePath: string): Promise<boolean> {
  try {
    await access(path.join(workspacePath, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function readOptional(workspacePath: string, relativePath: string, maxBytes = 128000): Promise<string> {
  try {
    const buffer = await readFile(path.join(workspacePath, relativePath));
    return buffer.subarray(0, maxBytes).toString("utf8");
  } catch {
    return "";
  }
}

function parsePackageScripts(packageJson: string): Record<string, string> {
  try {
    const parsed = JSON.parse(packageJson) as {
      scripts?: unknown;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (!parsed.scripts || typeof parsed.scripts !== "object") return {};
    const scripts: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed.scripts as Record<string, unknown>)) {
      if (typeof value === "string") scripts[name] = value;
    }
    return scripts;
  } catch {
    return {};
  }
}

function packageJsonHasDependency(packageJson: string, dependencyName: string): boolean {
  try {
    const parsed = JSON.parse(packageJson) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    return Boolean(
      parsed.dependencies?.[dependencyName] ||
        parsed.devDependencies?.[dependencyName] ||
        parsed.peerDependencies?.[dependencyName]
    );
  } catch {
    return false;
  }
}

function packageManagerFromPackageJson(packageJson: string): NodePackageManager | null {
  try {
    const parsed = JSON.parse(packageJson) as { packageManager?: unknown };
    if (typeof parsed.packageManager !== "string") return null;
    const name = parsed.packageManager.split("@")[0];
    return name === "npm" || name === "pnpm" || name === "yarn" || name === "bun" ? name : null;
  } catch {
    return null;
  }
}

function packageManagerFromFiles(files: Set<string>, packageJson: string): NodePackageManager {
  const fromPackageJson = packageManagerFromPackageJson(packageJson);
  if (fromPackageJson) return fromPackageJson;
  if (files.has("pnpm-lock.yaml")) return "pnpm";
  if (files.has("yarn.lock")) return "yarn";
  if (files.has("bun.lock") || files.has("bun.lockb")) return "bun";
  return "npm";
}

function parseMakeTargets(makefile: string): Set<string> {
  const targets = new Set<string>();
  for (const line of makefile.split(/\r?\n/)) {
    if (/^\s/.test(line)) continue;
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*:(?!=)/);
    if (match) targets.add(match[1]);
  }
  return targets;
}

export async function detectProjectProfile(workspacePath: string): Promise<ProjectProfile> {
  const workspace = path.resolve(workspacePath);
  const candidateFiles = [
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "tsconfig.json",
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "pytest.ini",
    "tox.ini",
    "uv.lock",
    "go.mod",
    "Cargo.toml",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "gradlew",
    "Makefile",
    "makefile"
  ];
  const files = new Set<string>();
  await Promise.all(
    candidateFiles.map(async (file) => {
      if (await exists(workspace, file)) files.add(file);
    })
  );

  const packageJson = files.has("package.json") ? await readOptional(workspace, "package.json") : "";
  const pyproject = files.has("pyproject.toml") ? await readOptional(workspace, "pyproject.toml") : "";
  const requirements = files.has("requirements.txt") ? await readOptional(workspace, "requirements.txt") : "";
  const setupPy = files.has("setup.py") ? await readOptional(workspace, "setup.py") : "";
  const toxIni = files.has("tox.ini") ? await readOptional(workspace, "tox.ini") : "";
  const makefile = files.has("Makefile")
    ? await readOptional(workspace, "Makefile")
    : files.has("makefile")
      ? await readOptional(workspace, "makefile")
      : "";

  const scripts = parsePackageScripts(packageJson);
  const scriptText = Object.values(scripts).join("\n");
  const hasTypeScript =
    files.has("tsconfig.json") ||
    packageJsonHasDependency(packageJson, "typescript") ||
    /\btsc\b|typescript|ts-node|tsx/.test(scriptText);
  const hasLocalTsc =
    (await exists(workspace, path.join("node_modules", ".bin", "tsc"))) ||
    (await exists(workspace, path.join("node_modules", ".bin", "tsc.cmd")));

  const node: NodeProjectProfile = {
    packageJsonPath: files.has("package.json") ? "package.json" : undefined,
    packageManager: packageManagerFromFiles(files, packageJson),
    scripts,
    hasPackageJson: files.has("package.json"),
    hasLockfile:
      files.has("package-lock.json") ||
      files.has("npm-shrinkwrap.json") ||
      files.has("pnpm-lock.yaml") ||
      files.has("yarn.lock") ||
      files.has("bun.lock") ||
      files.has("bun.lockb"),
    hasTypeScript,
    hasLocalTsc,
    tscLikelyAvailable:
      hasTypeScript &&
      (packageJsonHasDependency(packageJson, "typescript") ||
        scriptText.includes("tsc") ||
        files.has("tsconfig.json") ||
        hasLocalTsc)
  };

  const hasPytestConfig =
    files.has("pytest.ini") ||
    /\[tool\.pytest/.test(pyproject) ||
    /\bpytest\b/.test(toxIni);
  const pytestLikely =
    hasPytestConfig ||
    /\bpytest\b/i.test(requirements) ||
    /\bpytest\b/i.test(pyproject) ||
    /\bpytest\b/i.test(setupPy);
  const prefersUv =
    files.has("uv.lock") ||
    /\[tool\.uv/.test(pyproject) ||
    /\buv\b/.test(pyproject);
  const python: PythonProjectProfile = {
    hasPython:
      files.has("pyproject.toml") ||
      files.has("requirements.txt") ||
      files.has("setup.py") ||
      files.has("pytest.ini") ||
      files.has("tox.ini") ||
      files.has("uv.lock"),
    hasPyproject: files.has("pyproject.toml"),
    hasRequirements: files.has("requirements.txt"),
    hasSetupPy: files.has("setup.py"),
    hasPytestConfig,
    hasUvLock: files.has("uv.lock"),
    prefersUv,
    pytestLikely
  };

  return {
    workspacePath: workspace,
    files,
    node,
    python,
    hasGoMod: files.has("go.mod"),
    hasCargoToml: files.has("Cargo.toml"),
    hasPomXml: files.has("pom.xml"),
    hasGradle: files.has("build.gradle") || files.has("build.gradle.kts"),
    hasGradleWrapper: files.has("gradlew"),
    hasMakefile: files.has("Makefile") || files.has("makefile"),
    makeTargets: parseMakeTargets(makefile)
  };
}
