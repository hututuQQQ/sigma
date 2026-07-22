import path from "node:path";
import type { ValidationClaimKindV1 } from "agent-protocol";

export interface SemanticValidationCommand {
  executable: string;
  kind: ValidationClaimKindV1;
  inlineExactPathCandidates: string[];
}

function executableName(value: string): string {
  return path.basename(value).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/u, "");
}

function scriptName(executable: string, args: string[]): string | undefined {
  if (!["pnpm", "npm", "yarn", "bun"].includes(executable)) return undefined;
  const candidate = args[0] === "run" ? args[1] : args[0];
  return candidate?.toLowerCase();
}

function cargoSubcommand(args: string[]): string | undefined {
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
    if (argument.startsWith("-")) continue;
    return argument.toLowerCase();
  }
  return undefined;
}

function cargoClaimKind(args: string[]): ValidationClaimKindV1 | undefined {
  const subcommand = cargoSubcommand(args);
  if (subcommand === "test") return "unit";
  if (subcommand === "clippy" || subcommand === "fmt") return "lint";
  if (["build", "check", "bench"].includes(subcommand ?? "")) return "acceptance";
  return undefined;
}

function nodeScriptClaimKind(value: string): ValidationClaimKindV1 | undefined {
  const name = path.basename(value).toLowerCase();
  if (/(?:^|[._-])(?:integration|e2e)(?:[._-]|$)/u.test(name)) return "integration";
  if (/(?:^|[._-])(?:test|tests|spec)(?:[._-]|$)/u.test(name)) return "unit";
  if (/(?:^|[._-])(?:check|verify|validate)(?:[._-]|$)/u.test(name)) return "acceptance";
  return undefined;
}

function inlineNodeScript(args: string[]): string | undefined {
  const index = args.findIndex((item) => item === "-e" || item === "--eval");
  return index >= 0 ? args[index + 1] : undefined;
}

function assertedInlineScript(script: string): boolean {
  const assertion = /\bassert(?:\.[A-Za-z_$][\w$]*)?\s*\(/u.test(script);
  const thrownFailure = /\bthrow\s+(?:new\s+)?(?:Error|[A-Za-z_$][\w$]*)\b/u.test(script);
  const failedExit = /\bprocess\.exitCode\s*=\s*1\b/u.test(script)
    || /\bprocess\.exit\s*\(\s*1\s*\)/u.test(script)
    || /\bprocess\.exit\s*\([^)]*[?:]\s*1\b[^)]*\)/u.test(script);
  return assertion || thrownFailure || failedExit;
}

function decodeLiteralPath(value: string, quote: string): string | undefined {
  if (quote === "`" && value.includes("${")) return undefined;
  if (/\\(?:x|u|[0-7])/u.test(value)) return undefined;
  return value.replace(/\\([\\/'"`])/gu, "$1");
}

function inlinePathLiterals(script: string): Array<{ value: string; module: boolean }> {
  const values: Array<{ value: string; module: boolean }> = [];
  const literal = String.raw`(["'\x60])((?:\\.|(?!\1)[^\\])*?)\1`;
  const patterns = [
    { module: true, pattern: new RegExp(String.raw`\b(?:import|require)\s*\(\s*${literal}\s*\)`, "gu") },
    {
      module: false,
      pattern: new RegExp(
        String.raw`\b(?:readFile|readFileSync|access|accessSync|stat|statSync|lstat|lstatSync)\s*\(\s*${literal}`,
        "gu"
      )
    }
  ];
  for (const { module, pattern } of patterns) {
    for (const match of script.matchAll(pattern)) {
      const quote = match[1];
      const raw = match[2];
      if (!quote || raw === undefined) continue;
      const value = decodeLiteralPath(raw, quote);
      if (value !== undefined) values.push({ value, module });
    }
  }
  return values;
}

function inlineExactPathCandidates(args: string[]): string[] {
  const script = inlineNodeScript(args);
  if (!script || !assertedInlineScript(script)) return [];
  return [...new Set(inlinePathLiterals(script).flatMap(({ value, module }) => {
    if (module && !value.startsWith(".") && !path.isAbsolute(value)) return [];
    return value;
  }))].sort();
}

function nodeClaimKind(args: string[]): ValidationClaimKindV1 | undefined {
  if (args.some((item) => item === "--test" || item.startsWith("--test="))) return "unit";
  if (args[0] === "--check") return "syntax";
  if (inlineNodeScript(args) !== undefined) return undefined;
  const script = args.find((item) => !item.startsWith("-"));
  return script ? nodeScriptClaimKind(script) : undefined;
}

function claimKind(executable: string, args: string[]): ValidationClaimKindV1 {
  if (executable === "node") return nodeClaimKind(args) ?? "probe";
  if (executable === "tsc" || args.some((item) => executableName(item) === "tsc")) return "typecheck";
  if (["eslint", "biome", "stylelint", "ruff"].includes(executable)) return "lint";
  if (["vitest", "jest", "mocha", "pytest", "cargo-test"].includes(executable)) return "unit";
  if (executable === "cargo") return cargoClaimKind(args) ?? "probe";
  const script = scriptName(executable, args);
  if (!script) return "probe";
  if (/integration|e2e/u.test(script)) return "integration";
  if (/test|spec/u.test(script)) return "unit";
  if (/typecheck|check-types|tsc/u.test(script)) return "typecheck";
  if (/lint|format-check/u.test(script)) return "lint";
  if (/build|verify|validate|check/u.test(script)) return "acceptance";
  return "probe";
}

export function semanticValidationCommand(
  executableValue: string,
  args: string[]
): SemanticValidationCommand {
  const executable = executableName(executableValue);
  return {
    executable,
    kind: claimKind(executable, args),
    inlineExactPathCandidates: executable === "node" ? inlineExactPathCandidates(args) : []
  };
}
