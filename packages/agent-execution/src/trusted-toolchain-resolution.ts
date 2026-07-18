import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { NormalizedTrustedToolchain } from "./trusted-toolchains.js";

function aliasKey(alias: string): string {
  return process.platform === "win32" ? alias.replace(/[. ]+$/u, "").toLowerCase() : alias;
}

function environmentKey(environment: Record<string, string>, requested: string): string | undefined {
  if (process.platform !== "win32") return Object.hasOwn(environment, requested) ? requested : undefined;
  return Object.keys(environment).find((key) => key.toLowerCase() === requested.toLowerCase());
}

function existingCanonicalFile(candidate: string): string | undefined {
  try {
    if (!statSync(candidate).isFile()) return undefined;
    return realpathSync.native(candidate);
  } catch {
    return undefined;
  }
}

function executableNames(executable: string, toolchains: NormalizedTrustedToolchain[]): string[] {
  if (process.platform !== "win32" || path.extname(executable) !== "") return [executable];
  const pathExt = toolchains.flatMap((toolchain) => {
    const key = environmentKey(toolchain.environment, "PATHEXT");
    return key === undefined ? [] : [toolchain.environment[key]!];
  })[0] ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return pathExt.split(";").filter(Boolean).map((extension) => `${executable}${extension}`);
}

function resolveToolchainPathExecutable(
  executable: string,
  cwd: string | undefined,
  toolchains: NormalizedTrustedToolchain[]
): string | undefined {
  if (cwd !== undefined && path.parse(executable).dir !== "") {
    return existingCanonicalFile(path.resolve(cwd, executable));
  }
  const names = executableNames(executable, toolchains);
  for (const directory of toolchains.flatMap((toolchain) => toolchain.pathEntries)) {
    for (const name of names) {
      const candidate = existingCanonicalFile(path.join(directory, name));
      if (candidate !== undefined) return candidate;
    }
  }
  return undefined;
}

export function resolveTrustedExecutable(
  executable: string,
  toolchains: NormalizedTrustedToolchain[],
  cwd?: string
): string {
  if (path.isAbsolute(executable)) return executable;
  const key = aliasKey(executable);
  const match = toolchains.find((toolchain) => toolchain.aliases.some((alias) => aliasKey(alias) === key));
  return match?.executable ?? resolveToolchainPathExecutable(executable, cwd, toolchains) ?? executable;
}

export function resolveTrustedInvocation(
  executable: string,
  args: readonly string[],
  toolchains: NormalizedTrustedToolchain[],
  cwd: string
): { executable: string; args: string[] } {
  const key = aliasKey(executable);
  const toolchain = toolchains.find((candidate) =>
    candidate.aliases.some((alias) => aliasKey(alias) === key));
  if (!toolchain) return {
    executable: resolveTrustedExecutable(executable, toolchains, cwd),
    args: [...args]
  };
  return {
    executable: toolchain.executable,
    args: [...(toolchain.aliasArguments[key] ?? []), ...args]
  };
}
