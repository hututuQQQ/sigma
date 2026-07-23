import path from "node:path";
import type { ValidationClaimKindV1 } from "agent-protocol";
import { shellSemanticValidation } from "./semantic-validation-shell.js";

export interface SemanticValidationCommand {
  executable: string;
  kind: ValidationClaimKindV1;
  exactPathCandidates: string[];
}

function executableName(value: string): string {
  return path.basename(value).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/u, "");
}

const DIRECT_COMPILER_INPUTS: Readonly<Record<string, RegExp>> = {
  coqc: /\.v$/iu,
  cobc: /\.(?:cbl|cob|cpy)$/iu,
  cc: /\.(?:c|cc|cpp|cxx|m|mm|s|asm)$/iu,
  "c++": /\.(?:c|cc|cpp|cxx|m|mm|s|asm)$/iu,
  gcc: /\.(?:c|cc|cpp|cxx|m|mm|s|asm)$/iu,
  "g++": /\.(?:c|cc|cpp|cxx|m|mm|s|asm)$/iu,
  clang: /\.(?:c|cc|cpp|cxx|m|mm|s|asm)$/iu,
  "clang++": /\.(?:c|cc|cpp|cxx|m|mm|s|asm)$/iu,
  rustc: /\.rs$/iu,
  javac: /\.java$/iu,
  kotlinc: /\.(?:kt|kts)$/iu,
  swiftc: /\.swift$/iu,
  scalac: /\.scala$/iu,
  ghc: /\.(?:hs|lhs)$/iu,
  ocamlc: /\.(?:ml|mli)$/iu,
  ocamlopt: /\.(?:ml|mli)$/iu,
  csc: /\.cs$/iu,
  mcs: /\.cs$/iu,
  fpc: /\.(?:pas|pp)$/iu,
  gfortran: /\.(?:f|for|f77|f90|f95|f03|f08)$/iu,
  flang: /\.(?:f|for|f77|f90|f95|f03|f08)$/iu,
  erlc: /\.erl$/iu
};

const TRANSITIVE_COMPILER_INPUTS: Readonly<Record<string, RegExp>> = {
  latex: /\.(?:tex|dtx|ins)$/iu,
  pdflatex: /\.(?:tex|dtx|ins)$/iu,
  xelatex: /\.(?:tex|dtx|ins)$/iu,
  lualatex: /\.(?:tex|dtx|ins)$/iu,
  latexmk: /\.(?:tex|dtx|ins)$/iu,
  tectonic: /\.(?:tex|dtx|ins)$/iu
};

function sourcePathCandidates(args: string[], pattern: RegExp | undefined): string[] {
  if (!pattern) return [];
  return [...new Set(args.flatMap((argument) => {
    if (!argument || argument.startsWith("-")) return [];
    const candidate = argument.replace(/[;|]+$/u, "");
    return pattern.test(candidate) ? [candidate] : [];
  }))].sort();
}

function explicitOutputPathCandidates(args: string[]): string[] {
  const candidates: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "-o" || argument === "--output") {
      const value = args[index + 1];
      if (value && !value.startsWith("-")) candidates.push(value);
      index += 1;
      continue;
    }
    const long = argument.match(/^--output=(.+)$/u);
    if (long?.[1]) {
      candidates.push(long[1]);
      continue;
    }
    const short = argument.match(/^-o(.+)$/u);
    if (short?.[1]) {
      candidates.push(short[1]);
      continue;
    }
    const colon = argument.match(/^(?:\/out:|-out:)(.+)$/iu);
    if (colon?.[1]) candidates.push(colon[1]);
  }
  return candidates;
}

function replaceExtension(value: string, extension: string): string {
  const parsed = path.parse(value);
  return path.join(parsed.dir, `${parsed.name}${extension}`);
}

function conventionalCompilerOutputPathCandidates(
  executable: string,
  sources: readonly string[]
): string[] {
  if (executable !== "coqc") return [];
  return sources.flatMap((source) => [
    replaceExtension(source, ".vo"),
    replaceExtension(source, ".vok"),
    replaceExtension(source, ".vos"),
    replaceExtension(source, ".glob"),
    path.join(path.dirname(source), `.${path.parse(source).name}.aux`)
  ]);
}

function compilerExactPathCandidates(executable: string, args: string[]): string[] {
  const sources = sourcePathCandidates(args, DIRECT_COMPILER_INPUTS[executable]);
  if (sources.length === 0) return [];
  return [...new Set([
    ...sources,
    ...explicitOutputPathCandidates(args),
    ...conventionalCompilerOutputPathCandidates(executable, sources)
  ])].sort();
}

function compilerClaimKind(executable: string, args: string[]): ValidationClaimKindV1 | undefined {
  if (compilerExactPathCandidates(executable, args).length > 0) return "acceptance";
  return sourcePathCandidates(args, TRANSITIVE_COMPILER_INPUTS[executable]).length > 0
    ? "acceptance" : undefined;
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

function inlinePythonScript(args: string[]): string | undefined {
  const index = args.findIndex((item) => item === "-c");
  return index >= 0 ? args[index + 1] : undefined;
}

function pythonClaimKind(args: string[]): ValidationClaimKindV1 | undefined {
  // Inline Python is an open-ended program. A text scan cannot distinguish
  // executable assertions from comments or string literals, nor prove that a
  // caught exception affects the process exit status. Structured module and
  // file invocations remain classifiable below.
  if (inlinePythonScript(args) !== undefined) return undefined;
  const moduleIndex = args.findIndex((item) => item === "-m");
  const moduleName = moduleIndex >= 0 ? args[moduleIndex + 1]?.toLowerCase() : undefined;
  if (moduleName === "pytest" || moduleName === "unittest") return "unit";
  if (moduleName === "py_compile" || moduleName === "compileall") return "syntax";
  const script = args.find((item) => !item.startsWith("-") && /\.(?:py|pyw)$/iu.test(item));
  return script ? nodeScriptClaimKind(script) : undefined;
}

function pythonExactPathCandidates(args: string[]): string[] {
  if (inlinePythonScript(args) !== undefined) return [];
  return args.filter((item) => !item.startsWith("-") && /\.(?:py|pyw)$/iu.test(item));
}

function nodeClaimKind(args: string[]): ValidationClaimKindV1 | undefined {
  if (args.some((item) => item === "--test" || item.startsWith("--test="))) return "unit";
  if (args[0] === "--check") return "syntax";
  if (inlineNodeScript(args) !== undefined) return undefined;
  const script = args.find((item) => !item.startsWith("-"));
  return script ? nodeScriptClaimKind(script) : undefined;
}

function packageScriptClaimKind(executable: string, args: string[]): ValidationClaimKindV1 {
  const script = scriptName(executable, args);
  if (!script) return "probe";
  if (/integration|e2e/u.test(script)) return "integration";
  if (/test|spec/u.test(script)) return "unit";
  if (/typecheck|check-types|tsc/u.test(script)) return "typecheck";
  if (/lint|format-check/u.test(script)) return "lint";
  if (/build|verify|validate|check/u.test(script)) return "acceptance";
  return "probe";
}

function claimKind(executable: string, args: string[]): ValidationClaimKindV1 {
  if (executable === "node") return nodeClaimKind(args) ?? "probe";
  if (/^python(?:\d+(?:\.\d+)*)?$/u.test(executable)) return pythonClaimKind(args) ?? "probe";
  if (executable === "tsc" || args.some((item) => executableName(item) === "tsc")) return "typecheck";
  if (["eslint", "biome", "stylelint", "ruff"].includes(executable)) return "lint";
  if (["vitest", "jest", "mocha", "pytest", "cargo-test"].includes(executable)) return "unit";
  if (executable === "cargo") return cargoClaimKind(args) ?? "probe";
  return compilerClaimKind(executable, args) ?? packageScriptClaimKind(executable, args);
}

export function semanticValidationCommand(
  executableValue: string,
  args: string[],
  shellScript?: string
): SemanticValidationCommand {
  const executable = executableName(executableValue);
  const shell = shellScript ? shellSemanticValidation(shellScript) : undefined;
  const pythonKind = /^python(?:\d+(?:\.\d+)*)?$/u.test(executable)
    ? pythonClaimKind(args) : undefined;
  const pythonCandidates = pythonKind ? pythonExactPathCandidates(args) : [];
  return {
    executable,
    kind: shell?.kind ?? claimKind(executable, args),
    exactPathCandidates: shell?.kind
      ? shell.exactPathCandidates
      : executable === "node"
        ? inlineExactPathCandidates(args)
        : pythonCandidates.length > 0
          ? pythonCandidates
          : compilerExactPathCandidates(executable, args)
  };
}
