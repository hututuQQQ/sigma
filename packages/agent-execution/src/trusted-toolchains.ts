import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  BrokerPolicyError,
  BrokerToolchainEnvironmentConflictError,
  BrokerToolchainUnavailableError
} from "./errors.js";
import { createMinimalEnvironment } from "./environment.js";
import type {
  SigmaExecBrokerClientOptions,
  TrustedToolchainManifestEntry
} from "./types.js";
import {
  assertWindowsAppContainerNodeCompatibility,
  inspectWindowsNodeMarkers,
  WINDOWS_APPCONTAINER_NODE_COMPATIBILITY
} from "./windows-node-compatibility.js";

export interface NormalizedTrustedToolchain {
  id: string;
  executable: string;
  aliases: string[];
  executionRoots: string[];
  runtimeRoots: string[];
  pathEntries: string[];
  environment: Record<string, string>;
  nodeRuntime: boolean;
  compatibility: TrustedToolchainManifestEntry["compatibility"];
  /** Connection-bound identity forwarded to the native launcher. */
  executableSha256?: string;
}

export function comparablePath(value: string): string {
  let normalized = value;
  if (process.platform === "win32") {
    if (normalized.toLowerCase().startsWith("\\\\?\\unc\\")) normalized = `\\\\${normalized.slice(8)}`;
    else if (normalized.startsWith("\\\\?\\")) normalized = normalized.slice(4);
  }
  return path.resolve(normalized);
}

export function pathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(comparablePath(root), comparablePath(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function pathKey(value: string): string {
  const resolved = comparablePath(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

export function uniquePaths(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = pathKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assertAbsoluteRoots(roots: string[], label: string): void {
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string" || !path.isAbsolute(root))) {
    throw new BrokerPolicyError(`${label} must contain only absolute paths.`);
  }
}

function aliasKey(alias: string): string {
  return process.platform === "win32" ? alias.replace(/[. ]+$/u, "").toLowerCase() : alias;
}

function normalizeToolchainAliases(
  entry: TrustedToolchainManifestEntry,
  aliasIdentifiers: Set<string>
): string[] {
  const aliases = entry.aliases ?? [];
  if (!Array.isArray(aliases)
    || aliases.some((alias) => typeof alias !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(alias))) {
    throw new BrokerPolicyError(`Trusted toolchain '${entry.id}' aliases must be simple command names without path separators.`);
  }
  for (const alias of aliases) {
    const key = aliasKey(alias);
    if (aliasIdentifiers.has(key)) {
      throw new BrokerPolicyError(`Trusted toolchain alias '${alias}' is duplicated.`);
    }
    aliasIdentifiers.add(key);
  }
  return [...aliases];
}

function normalizedAbsolutePaths(values: string[], label: string): string[] {
  assertAbsoluteRoots(values, label);
  return uniquePaths(values.map(comparablePath));
}

function normalizeToolchainRoots(
  entry: TrustedToolchainManifestEntry,
  executable: string,
  nodeRuntime: boolean
): { executionRoots: string[]; pathEntries: string[] } {
  if (nodeRuntime) {
    const declaredRoots = entry.executionRoots === undefined
      ? [executable]
      : normalizedAbsolutePaths(entry.executionRoots, `trustedToolchains.${entry.id}.executionRoots`);
    if (declaredRoots.length !== 1 || pathKey(declaredRoots[0]!) !== pathKey(executable)) {
      throw new BrokerPolicyError(`Trusted Node toolchain '${entry.id}' must trust only its exact executable.`);
    }
    const declaredPath = entry.pathEntries === undefined
      ? []
      : normalizedAbsolutePaths(entry.pathEntries, `trustedToolchains.${entry.id}.pathEntries`);
    if (declaredPath.length !== 0) {
      throw new BrokerPolicyError(`Trusted Node toolchain '${entry.id}' cannot add a directory to PATH.`);
    }
    return { executionRoots: [executable], pathEntries: [] };
  }
  const executionRoots = normalizedAbsolutePaths(
    entry.executionRoots ?? [executable],
    `trustedToolchains.${entry.id}.executionRoots`
  );
  const pathEntries = normalizedAbsolutePaths(
    entry.pathEntries ?? [],
    `trustedToolchains.${entry.id}.pathEntries`
  );
  if (!executionRoots.some((root) => pathWithin(executable, root))) {
    throw new BrokerPolicyError(`Trusted toolchain '${entry.id}' executable is outside its execution roots.`);
  }
  if (pathEntries.some((directory) => !executionRoots.some((root) => pathWithin(directory, root)))) {
    throw new BrokerPolicyError(`Trusted toolchain '${entry.id}' PATH entries must be inside its execution roots.`);
  }
  return { executionRoots, pathEntries };
}

function normalizeTrustedToolchain(
  entry: TrustedToolchainManifestEntry,
  identifiers: Set<string>,
  aliasIdentifiers: Set<string>
): NormalizedTrustedToolchain {
  if (!entry || typeof entry !== "object" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(entry.id)) {
    throw new BrokerPolicyError("Trusted toolchain ids must be stable non-empty identifiers.");
  }
  if (identifiers.has(entry.id)) throw new BrokerPolicyError(`Trusted toolchain id '${entry.id}' is duplicated.`);
  identifiers.add(entry.id);
  if (typeof entry.executable !== "string" || !path.isAbsolute(entry.executable)) {
    throw new BrokerPolicyError(`Trusted toolchain '${entry.id}' executable must be absolute.`);
  }
  if (entry.runtime !== undefined && entry.runtime !== "node" && entry.runtime !== "generic") {
    throw new BrokerPolicyError(`Trusted toolchain '${entry.id}' runtime family is invalid.`);
  }
  const aliases = normalizeToolchainAliases(entry, aliasIdentifiers);
  const executableName = aliasKey(path.basename(entry.executable));
  const nodeRuntime = entry.runtime === "node"
    || aliases.some((alias) => ["node", "node.exe"].includes(aliasKey(alias)))
    || ["node", "node.exe"].includes(executableName);
  const executable = comparablePath(entry.executable);
  const roots = normalizeToolchainRoots(entry, executable, nodeRuntime);
  const runtimeRoots = normalizedAbsolutePaths(
    entry.runtimeRoots ?? [],
    `trustedToolchains.${entry.id}.runtimeRoots`
  );
  return {
    id: entry.id,
    executable,
    aliases,
    ...roots,
    runtimeRoots,
    environment: createMinimalEnvironment({ overrides: entry.environment ?? {} }, {}, process.platform),
    nodeRuntime,
    compatibility: entry.compatibility
  };
}

export function normalizeTrustedToolchains(
  entries: TrustedToolchainManifestEntry[] | undefined
): NormalizedTrustedToolchain[] {
  // Trust is a composition-root decision. In particular, a host Node used to
  // load the portable CLI must not silently become a sandbox toolchain.
  const configured = entries ?? [];
  const identifiers = new Set<string>();
  const aliasIdentifiers = new Set<string>();
  return configured.map((entry) => normalizeTrustedToolchain(entry, identifiers, aliasIdentifiers));
}

/** Returns only model-safe bare aliases. Callers must not present these as
 * available until the broker connection has accepted the same manifest. */
export function trustedToolchainCommandAliases(
  entries: TrustedToolchainManifestEntry[] | undefined
): string[] {
  return normalizeTrustedToolchains(entries)
    .flatMap((toolchain) => toolchain.aliases)
    .sort((left, right) => left.localeCompare(right));
}

export function assertTrustedToolchainsAvailable(
  toolchains: NormalizedTrustedToolchain[],
  sandboxMode: SigmaExecBrokerClientOptions["sandboxMode"]
): void {
  for (const toolchain of toolchains) {
    try {
      if (!statSync(toolchain.executable).isFile()) {
        throw new Error("the configured executable is not a regular file");
      }
      if (process.platform !== "win32") accessSync(toolchain.executable, constants.X_OK);
      for (const runtimeRoot of toolchain.runtimeRoots) {
        if (!statSync(runtimeRoot).isDirectory()) {
          throw new Error(`runtime dependency root is not a directory: ${runtimeRoot}`);
        }
      }
    } catch (error) {
      throw new BrokerToolchainUnavailableError(
        toolchain.id,
        error instanceof Error ? error.message : "the configured executable is unavailable"
      );
    }
    if (process.platform !== "win32" || (sandboxMode ?? "required") !== "required") continue;
    if (!toolchain.nodeRuntime
      && (toolchain.executionRoots.length !== 1
        || !samePath(toolchain.executionRoots[0]!, toolchain.executable)
        || toolchain.pathEntries.length !== 0)) {
      throw new BrokerToolchainUnavailableError(
        toolchain.id,
        "a generic toolchain in a required Windows sandbox must trust only its exact executable and cannot extend PATH"
      );
    }
    assertWindowsToolchainExecutableIdentity(toolchain);
  }
}

function inspectGenericWindowsExecutable(
  executable: string,
  toolchainId: string
): ReturnType<typeof inspectWindowsNodeMarkers> {
  let inspection: ReturnType<typeof inspectWindowsNodeMarkers>;
  try {
    inspection = inspectWindowsNodeMarkers(executable);
  } catch (error) {
    throw new BrokerToolchainUnavailableError(
      toolchainId,
      error instanceof Error ? error.message : "the executable could not be inspected"
    );
  }
  if (inspection.sha256 === WINDOWS_APPCONTAINER_NODE_COMPATIBILITY.sourceSha256
    || inspection.globalPipeMarkerCount > 0
    || inspection.localPipeMarkerCount > 0) {
    throw new BrokerToolchainUnavailableError(
      toolchainId,
      "an undeclared Node/libuv runtime cannot inherit generic Windows toolchain trust"
    );
  }
  return inspection;
}

function assertWindowsToolchainExecutableIdentity(toolchain: NormalizedTrustedToolchain): void {
  if (!toolchain.nodeRuntime) {
    const inspection = inspectGenericWindowsExecutable(toolchain.executable, toolchain.id);
    if (toolchain.executableSha256 && toolchain.executableSha256 !== inspection.sha256) {
      throw new BrokerToolchainUnavailableError(toolchain.id, "the executable changed after broker connection");
    }
    toolchain.executableSha256 = inspection.sha256;
    return;
  }
  assertWindowsAppContainerNodeCompatibility(
    toolchain.executable,
    toolchain.compatibility,
    toolchain.id
  );
  const nodeOptions = environmentKey(toolchain.environment, "NODE_OPTIONS");
  if (nodeOptions === undefined
    || toolchain.environment[nodeOptions] !== WINDOWS_APPCONTAINER_NODE_COMPATIBILITY.requiredNodeOptions) {
    throw new BrokerToolchainUnavailableError(
      toolchain.id,
      `NODE_OPTIONS=${WINDOWS_APPCONTAINER_NODE_COMPATIBILITY.requiredNodeOptions} is required for LPAC startup`
    );
  }
  toolchain.executableSha256 = toolchain.compatibility!.executableSha256;
}

/**
 * Re-check the call-bound executable, rather than treating a containing
 * execution root as the executable's identity. This closes both replacement
 * races and broad-root inheritance by undeclared Node/libuv binaries.
 */
export function assertTrustedExecutableAvailable(
  executable: string,
  toolchains: NormalizedTrustedToolchain[],
  sandboxMode: SigmaExecBrokerClientOptions["sandboxMode"]
): void {
  if (process.platform !== "win32"
    || (sandboxMode ?? "required") !== "required"
    || !path.isAbsolute(executable)) return;
  const exact = toolchains.find((toolchain) => samePath(toolchain.executable, executable));
  if (exact) {
    assertWindowsToolchainExecutableIdentity(exact);
    return;
  }
  const containing = toolchains.find((toolchain) =>
    toolchain.executionRoots.some((root) => pathWithin(executable, root))
  );
  if (containing) inspectGenericWindowsExecutable(executable, containing.id);
}

export function trustedExecutableSha256(
  executable: string,
  toolchains: NormalizedTrustedToolchain[],
  sandboxMode: SigmaExecBrokerClientOptions["sandboxMode"]
): string | undefined {
  if (process.platform !== "win32" || (sandboxMode ?? "required") !== "required") return undefined;
  const toolchain = toolchains.find((candidate) => samePath(candidate.executable, executable));
  if (!toolchain?.executableSha256) return undefined;
  // The per-call check above hashes the same path again. Returning only the
  // connection-bound digest prevents a replacement from becoming the new
  // trusted identity during an individual request.
  assertWindowsToolchainExecutableIdentity(toolchain);
  return toolchain.executableSha256;
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

function environmentKey(environment: Record<string, string>, requested: string): string | undefined {
  if (process.platform !== "win32") return Object.hasOwn(environment, requested) ? requested : undefined;
  return Object.keys(environment).find((key) => key.toLowerCase() === requested.toLowerCase());
}

export function applyTrustedToolchains(
  environment: Record<string, string>,
  toolchains: NormalizedTrustedToolchain[]
): Record<string, string> {
  const result = { ...environment };
  for (const toolchain of toolchains) {
    for (const [name, value] of Object.entries(toolchain.environment)) {
      const existing = environmentKey(result, name);
      if (existing !== undefined && result[existing] !== value) {
        throw new BrokerToolchainEnvironmentConflictError(name, toolchain.id);
      }
      if (existing !== undefined && existing !== name) delete result[existing];
      result[name] = value;
    }
  }
  const pathEntries = uniquePaths(toolchains.flatMap((toolchain) => toolchain.pathEntries));
  if (pathEntries.length > 0) {
    const existing = environmentKey(result, "PATH");
    const inherited = existing === undefined ? [] : (result[existing] ?? "").split(path.delimiter).filter(Boolean);
    if (existing !== undefined && existing !== "PATH") delete result[existing];
    result.PATH = uniquePaths([...pathEntries, ...inherited]).join(path.delimiter);
  }
  return result;
}
