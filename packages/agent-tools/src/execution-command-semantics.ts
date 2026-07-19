import path from "node:path";
import type { ExecutionIntentV1, ValidationClaimKindV1 } from "agent-protocol";

export interface ExecutionCommandSemanticsInput {
  executable: string;
  args: readonly string[];
  validation: boolean;
  shellCommand?: string;
}

export interface ExecutionCommandSemantics {
  executable: string;
  args: string[];
  purpose: ExecutionIntentV1["purpose"];
  claimKind: ValidationClaimKindV1;
  safelyParsed: boolean;
}

interface Classification {
  claimKind: ValidationClaimKindV1;
  purpose: ExecutionIntentV1["purpose"];
}

type ShellScanMode = "unquoted" | "single" | "double";
type ShellScanAction = "continue" | "escape" | "open-single" | "open-double" | "close" | "unsafe";

function shellScanAction(command: string, index: number, mode: ShellScanMode): ShellScanAction {
  const character = command[index]!;
  if (mode === "single") return character === "'" ? "close" : "continue";
  if (mode === "double") {
    if (character === '"') return "close";
    if (character === "\\") return "escape";
    return character === "`" || (character === "$" && command[index + 1] === "(")
      ? "unsafe" : "continue";
  }
  if (character === "'") return "open-single";
  if (character === '"') return "open-double";
  if (character === "\\") return "escape";
  return /[;&|<>`\r\n]/u.test(character)
    || (character === "$" && command[index + 1] === "(") ? "unsafe" : "continue";
}

function nextShellMode(action: ShellScanAction, mode: ShellScanMode): ShellScanMode {
  if (action === "open-single") return "single";
  if (action === "open-double") return "double";
  return action === "close" ? "unquoted" : mode;
}

function simpleShellSyntax(command: string): boolean {
  let mode: ShellScanMode = "unquoted";
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    if (escaped) {
      escaped = false;
      continue;
    }
    const action = shellScanAction(command, index, mode);
    if (action === "unsafe") return false;
    escaped = action === "escape";
    mode = nextShellMode(action, mode);
  }
  return mode === "unquoted" && !escaped;
}

function simpleShellWords(command: string): string[] | null {
  if (!simpleShellSyntax(command)) return null;
  const words: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/gu;
  for (const match of command.matchAll(pattern)) words.push(match[1] ?? match[2] ?? match[3] ?? "");
  return words.length > 0 ? words : null;
}

function executableName(value: string): string {
  return path.basename(value).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/u, "");
}

function namedCommand(value: string): Classification | null {
  const name = path.basename(value).toLowerCase();
  if (/(?:integration|e2e)(?:[-_.]|$)/u.test(name)) return { claimKind: "integration", purpose: "test" };
  if (/(?:test|tests|spec)(?:[-_.]|$)|(?:^|[-_.])(?:test|tests|spec)/u.test(name)) {
    return { claimKind: "unit", purpose: "test" };
  }
  if (/(?:typecheck|check-types|tsc)(?:[-_.]|$)/u.test(name)) {
    return { claimKind: "typecheck", purpose: "build" };
  }
  if (/(?:lint|eslint|biome|ruff|stylelint)(?:[-_.]|$)/u.test(name)) {
    return { claimKind: "lint", purpose: "lint" };
  }
  if (/(?:build|compile|package)(?:[-_.]|$)/u.test(name)) {
    return { claimKind: "acceptance", purpose: "build" };
  }
  if (/(?:check|verify|validate|smoke)(?:[-_.]|$)/u.test(name)) {
    return { claimKind: "acceptance", purpose: "custom" };
  }
  return null;
}

function packageScript(args: readonly string[]): string | undefined {
  const optionsWithValues = new Set([
    "--filter", "-F", "--workspace", "-w", "--prefix", "--cwd", "-C", "--config"
  ]);
  let skipValue = false;
  for (const argument of args) {
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (argument === "run") continue;
    if (argument === "workspace") {
      skipValue = true;
      continue;
    }
    const option = argument.split("=", 1)[0] ?? argument;
    if (optionsWithValues.has(option)) {
      skipValue = !argument.includes("=");
      continue;
    }
    if (!argument.startsWith("-")) return argument.toLowerCase();
  }
  return undefined;
}

function packageClassification(args: readonly string[]): Classification | null {
  const script = packageScript(args);
  if (!script) return null;
  return namedCommand(script) ?? { claimKind: "acceptance", purpose: "custom" };
}

function cargoSubcommand(args: readonly string[]): string | undefined {
  const optionsWithValues = new Set(["--color", "--config", "-C", "-Z"]);
  let skipValue = false;
  for (const argument of args) {
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (argument.startsWith("+")) continue;
    const option = argument.split("=", 1)[0] ?? argument;
    if (optionsWithValues.has(option)) {
      skipValue = !argument.includes("=");
      continue;
    }
    if (!argument.startsWith("-")) return argument.toLowerCase();
  }
  return undefined;
}

function nodeScript(args: readonly string[]): string | undefined {
  const optionsWithValues = new Set([
    "-r", "--require", "--loader", "--import", "--conditions", "--input-type",
    "--test-name-pattern", "--test-reporter", "--test-reporter-destination"
  ]);
  let skipValue = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (argument === "--") return args[index + 1];
    const option = argument.split("=", 1)[0] ?? argument;
    if (optionsWithValues.has(option)) {
      skipValue = !argument.includes("=");
      continue;
    }
    if (!argument.startsWith("-")) return argument;
  }
  return undefined;
}

function nodeClassification(args: readonly string[]): Classification | null {
  if (args.some((item) => item === "--test" || item.startsWith("--test="))) {
    return { claimKind: "unit", purpose: "test" };
  }
  if (args.includes("--check")) return { claimKind: "syntax", purpose: "build" };
  const evaluation = args.findIndex((item) => ["-e", "--eval", "-p", "--print"].includes(item));
  if (evaluation >= 0) {
    return args[evaluation + 1]?.trim()
      ? { claimKind: "acceptance", purpose: "custom" } : null;
  }
  const script = nodeScript(args);
  return script ? namedCommand(script) ?? { claimKind: "acceptance", purpose: "custom" } : null;
}

function pythonClassification(args: readonly string[]): Classification | null {
  const moduleIndex = args.findIndex((item) => item === "-m");
  const module = moduleIndex >= 0 ? args[moduleIndex + 1]?.toLowerCase() : undefined;
  if (module && ["pytest", "unittest"].includes(module)) return { claimKind: "unit", purpose: "test" };
  if (module && ["mypy", "pyright"].includes(module)) return { claimKind: "typecheck", purpose: "build" };
  if (module === "ruff") return { claimKind: "lint", purpose: "lint" };
  if (module && ["compileall", "py_compile"].includes(module)) return { claimKind: "syntax", purpose: "build" };
  const evaluation = args.findIndex((item) => item === "-c");
  if (evaluation >= 0) {
    return args[evaluation + 1]?.trim()
      ? { claimKind: "acceptance", purpose: "custom" } : null;
  }
  const script = args.find((item) => !item.startsWith("-"));
  return script ? namedCommand(script) ?? { claimKind: "acceptance", purpose: "custom" } : null;
}

function standardClassification(executable: string, args: readonly string[]): Classification | null {
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) return packageClassification(args);
  if (executable === "node") return nodeClassification(args);
  if (["python", "python3", "py"].includes(executable)) return pythonClassification(args);
  if (["vitest", "jest", "mocha", "pytest", "unittest"].includes(executable)) {
    return { claimKind: "unit", purpose: "test" };
  }
  if (["tsc", "mypy", "pyright"].includes(executable)) return { claimKind: "typecheck", purpose: "build" };
  if (["eslint", "biome", "stylelint", "ruff"].includes(executable)) return { claimKind: "lint", purpose: "lint" };
  return namedCommand(executable);
}

function actionIn(args: readonly string[], actions: readonly string[]): string | undefined {
  return args.map((item) => item.toLowerCase()).find((item) => actions.includes(item));
}

function cargoClassification(executable: string, args: readonly string[]): Classification | null {
  if (executable !== "cargo") return null;
  const action = cargoSubcommand(args);
  if (action === "test") return { claimKind: "unit", purpose: "test" };
  if (action === "clippy" || action === "fmt") return { claimKind: "lint", purpose: "lint" };
  return ["build", "check", "bench"].includes(action ?? "")
    ? { claimKind: "acceptance", purpose: "build" } : null;
}

function goClassification(executable: string, args: readonly string[]): Classification | null {
  if (executable !== "go") return null;
  const action = actionIn(args, ["test", "vet", "fmt", "build", "run"]);
  if (action === "test") return { claimKind: "unit", purpose: "test" };
  if (action === "vet" || action === "fmt") return { claimKind: "lint", purpose: "lint" };
  return ["build", "run"].includes(action ?? "")
    ? { claimKind: "acceptance", purpose: "build" } : null;
}

function dotnetClassification(executable: string, args: readonly string[]): Classification | null {
  if (executable !== "dotnet") return null;
  const action = actionIn(args, ["test", "format", "build", "pack", "publish"]);
  if (action === "test") return { claimKind: "unit", purpose: "test" };
  if (action === "format") return { claimKind: "lint", purpose: "lint" };
  return ["build", "pack", "publish"].includes(action ?? "")
    ? { claimKind: "acceptance", purpose: "build" } : null;
}

function mavenClassification(executable: string, args: readonly string[]): Classification | null {
  if (!["mvn", "mvnw"].includes(executable)) return null;
  const action = actionIn(args, ["test", "verify", "integration-test", "package", "install"]);
  if (action === "test") return { claimKind: "unit", purpose: "test" };
  if (["verify", "integration-test"].includes(action ?? "")) return { claimKind: "integration", purpose: "test" };
  return ["package", "install"].includes(action ?? "")
    ? { claimKind: "acceptance", purpose: "build" } : null;
}

function gradleClassification(executable: string, args: readonly string[]): Classification | null {
  if (!["gradle", "gradlew"].includes(executable)) return null;
  const tasks = args.filter((item) => !item.startsWith("-")).map((item) => item.toLowerCase());
  if (tasks.some((item) => /integration|e2e/u.test(item))) return { claimKind: "integration", purpose: "test" };
  if (tasks.some((item) => /test/u.test(item))) return { claimKind: "unit", purpose: "test" };
  if (tasks.some((item) => /lint|checkstyle/u.test(item))) return { claimKind: "lint", purpose: "lint" };
  return tasks.some((item) => /build|assemble|check/u.test(item))
    ? { claimKind: "acceptance", purpose: "build" } : null;
}

function ecosystemClassification(executable: string, args: readonly string[]): Classification | null {
  return standardClassification(executable, args)
    ?? cargoClassification(executable, args)
    ?? goClassification(executable, args)
    ?? dotnetClassification(executable, args)
    ?? mavenClassification(executable, args)
    ?? gradleClassification(executable, args);
}

function capabilityProbe(args: readonly string[]): boolean {
  if (args.length === 0) return true;
  return args.every((item) => /^(?:--?(?:version|help|usage)|-[vVh])$/u.test(item));
}

export function executionCommandSemantics(input: ExecutionCommandSemanticsInput): ExecutionCommandSemantics {
  const shellWords = input.shellCommand === undefined ? undefined : simpleShellWords(input.shellCommand);
  if (input.shellCommand !== undefined && !shellWords) {
    return {
      executable: input.executable,
      args: [...input.args],
      purpose: "probe",
      claimKind: "probe",
      safelyParsed: false
    };
  }
  const executable = shellWords?.[0] ?? input.executable;
  const args = shellWords?.slice(1) ?? [...input.args];
  const name = executableName(executable);
  const classified = ecosystemClassification(name, args);
  const fallback: Classification = input.validation && !capabilityProbe(args)
    ? { claimKind: "acceptance", purpose: "custom" }
    : { claimKind: "probe", purpose: "probe" };
  return {
    executable,
    args,
    ...(classified ?? fallback),
    safelyParsed: true
  };
}
