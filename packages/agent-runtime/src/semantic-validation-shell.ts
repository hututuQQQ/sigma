import path from "node:path";
import type { ValidationClaimKindV1 } from "agent-protocol";

type ShellQuote = "'" | "\"" | null;

function executableName(value: string): string {
  return path.basename(value).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/u, "");
}

function quotedShellCharacter(
  script: string,
  index: number,
  quote: Exclude<ShellQuote, null>
): { text: string; nextIndex: number; quote: ShellQuote } {
  const character = script[index]!;
  if (character === quote) return { text: character, nextIndex: index, quote: null };
  if (character === "\\" && quote === "\"" && index + 1 < script.length) {
    return {
      text: character + script[index + 1]!,
      nextIndex: index + 1,
      quote
    };
  }
  return { text: character, nextIndex: index, quote };
}

function unsafeUnquotedShellCharacter(script: string, index: number): boolean {
  const character = script[index]!;
  return character === "\r" || character === "\n" || character === ";"
    || character === "|" || character === "(" || character === ")"
    || character === "`" || script.startsWith("$(", index);
}

function escapedShellCharacter(
  script: string,
  index: number
): { text: string; nextIndex: number } | null {
  const next = script[index + 1];
  if (next === "\r" || next === "\n") return null;
  return {
    text: next === undefined ? "\\" : `\\${next}`,
    nextIndex: next === undefined ? index : index + 1
  };
}

function shellAmpersandKind(
  script: string,
  index: number,
  hasCurrentSegment: boolean
): "literal" | "separator" | "invalid" {
  const previous = script[index - 1];
  const next = script[index + 1];
  if (previous === ">" || previous === "<" || next === ">") return "literal";
  return next === "&" && hasCurrentSegment ? "separator" : "invalid";
}

/** Return commands joined only by unmasked `&&`. Other shell control forms can
 * replace a failing command's status, so they are never semantic validation. */
function strictAndShellSegments(script: string): string[] | null {
  const segments: string[] = [];
  let current = "";
  let quote: ShellQuote = null;
  for (let index = 0; index < script.length; index += 1) {
    const character = script[index]!;
    if (quote) {
      const scanned = quotedShellCharacter(script, index, quote);
      current += scanned.text;
      quote = scanned.quote;
      index = scanned.nextIndex;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      current += character;
      continue;
    }
    if (unsafeUnquotedShellCharacter(script, index)) return null;
    if (character === "\\") {
      const scanned = escapedShellCharacter(script, index);
      if (!scanned) return null;
      current += scanned.text;
      index = scanned.nextIndex;
      continue;
    }
    if (character === "&") {
      const kind = shellAmpersandKind(script, index, Boolean(current.trim()));
      if (kind === "literal") {
        current += character;
        continue;
      }
      if (kind === "invalid") return null;
      segments.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    current += character;
  }
  if (quote || !current.trim()) return null;
  segments.push(current.trim());
  return segments;
}

function shellSegmentWords(command: string): string[] {
  const words: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/gu;
  for (const match of command.matchAll(pattern)) words.push(match[1] ?? match[2] ?? match[3] ?? "");
  return words.filter(Boolean);
}

function shellSegmentExecutableIndex(words: readonly string[]): number {
  let executableIndex = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[executableIndex] ?? "")) executableIndex += 1;
  if (executableName(words[executableIndex] ?? "") === "env") {
    executableIndex += 1;
    while ((words[executableIndex] ?? "").startsWith("-")
      || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[executableIndex] ?? "")) executableIndex += 1;
  } else if ((words[executableIndex] ?? "") === "command") {
    executableIndex += 1;
    while ((words[executableIndex] ?? "").startsWith("-")) executableIndex += 1;
  }
  return executableIndex;
}

function shellSegmentInvocation(segment: string): { executable: string; args: string[] } {
  const words = shellSegmentWords(segment);
  const executableIndex = shellSegmentExecutableIndex(words);
  return {
    executable: executableName(words[executableIndex] ?? ""),
    args: words.slice(executableIndex + 1)
  };
}

function updatedShellWorkingDirectory(
  directory: string | undefined,
  args: readonly string[]
): string | undefined {
  const requested = args.find((item) => item && !item.startsWith("-"));
  if (!requested) return directory;
  return directory && !path.isAbsolute(requested)
    ? path.join(directory, requested) : requested;
}

function shellInvocationSourceCandidates(
  invocation: { executable: string; args: string[] }
): string[] {
  if (!/^(?:python(?:\d+(?:\.\d+)*)?|node|ruby|perl|php)$/u.test(invocation.executable)) return [];
  if (invocation.args.some((item) => ["-c", "-e", "--eval", "-m"].includes(item))) return [];
  const candidates: string[] = [];
  for (const candidate of invocation.args) {
    if (/^(?:\d*[<>]|[<>])/u.test(candidate)) break;
    if (candidate.startsWith("-")
      || !/\.(?:py|pyw|[cm]?js|mjs|cjs|rb|pl|php)$/iu.test(candidate)) continue;
    candidates.push(candidate);
  }
  return candidates;
}

function shellExecutedSourceCandidates(segments: readonly string[]): string[] {
  let directory: string | undefined;
  const candidates: string[] = [];
  for (const segment of segments) {
    const invocation = shellSegmentInvocation(segment);
    if (invocation.executable === "cd") {
      directory = updatedShellWorkingDirectory(directory, invocation.args);
      continue;
    }
    for (const candidate of shellInvocationSourceCandidates(invocation)) {
      candidates.push(directory && !path.isAbsolute(candidate)
        ? path.join(directory, candidate) : candidate);
    }
  }
  return [...new Set(candidates)].sort();
}

function shellRunsUnitFramework(segments: readonly string[]): boolean {
  return segments.some((segment) => {
    const { executable, args } = shellSegmentInvocation(segment);
    if (["pytest", "vitest", "jest", "mocha"].includes(executable)) return true;
    if (/^python(?:\d+(?:\.\d+)*)?$/u.test(executable)) {
      const moduleIndex = args.indexOf("-m");
      return moduleIndex >= 0 && ["pytest", "unittest"].includes(
        (args[moduleIndex + 1] ?? "").toLowerCase()
      );
    }
    return executable === "node"
      && args.some((item) => item === "--test" || item.startsWith("--test="));
  });
}

function strictShellComparison(segments: readonly string[]): boolean {
  return segments.length > 1 && segments.some((segment) =>
    ["diff", "cmp"].includes(shellSegmentInvocation(segment).executable));
}

export function shellSemanticValidation(script: string): {
  kind?: ValidationClaimKindV1;
  exactPathCandidates: string[];
} {
  const segments = strictAndShellSegments(script);
  if (!segments) return { kind: "probe", exactPathCandidates: [] };
  const exactPathCandidates = shellExecutedSourceCandidates(segments);
  if (shellRunsUnitFramework(segments)) return { kind: "unit", exactPathCandidates };
  if (exactPathCandidates.length > 0 && strictShellComparison(segments)) {
    return { kind: "unit", exactPathCandidates };
  }
  return { exactPathCandidates: [] };
}
