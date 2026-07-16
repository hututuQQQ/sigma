import path from "node:path";
import {
  BrokerExecutableUnavailableError,
  BrokerPolicyError
} from "./errors.js";
import { createMinimalEnvironment } from "./environment.js";
import type {
  CommandSpec,
  ExecutionPolicy,
  ExecutionRequest,
  ProcessSpawnRequest,
  SigmaExecBrokerClientOptions
} from "./types.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "./types.js";
import {
  applyTrustedToolchains,
  assertTrustedExecutableAvailable,
  comparablePath,
  pathWithin,
  resolveTrustedExecutable,
  samePath,
  trustedExecutableSha256,
  uniquePaths,
  type NormalizedTrustedToolchain
} from "./trusted-toolchains.js";

export function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new BrokerPolicyError(`${label} must be a positive integer.`);
  return result;
}

function ptyDimension(value: number | undefined, fallback: number, label: string): number {
  const result = positiveInteger(value, fallback, label);
  if (result > 65_535) throw new BrokerPolicyError(`${label} must not exceed 65535.`);
  return result;
}

function assertAbsoluteRoots(roots: string[], label: string): void {
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string" || !path.isAbsolute(root))) {
    throw new BrokerPolicyError(`${label} must contain only absolute paths.`);
  }
}

function defaultProtectedPaths(policy: ExecutionPolicy): string[] {
  const explicit = policy.protectedPaths ?? [];
  const resolved = [...new Set(policy.readRoots.map((root) => path.resolve(root)))];
  const roots = resolved.filter((root) => !resolved.some((candidate) =>
    candidate !== root && pathWithin(root, candidate)
  ));
  return [...new Set([
    ...explicit,
    ...roots.flatMap((root) => [path.join(root, ".git"), path.join(root, ".agent")])
  ])];
}

function executionRoots(
  command: CommandSpec,
  policy: ExecutionPolicy,
  toolchains: NormalizedTrustedToolchain[],
  verifiedExecutables: string[]
): string[] {
  const explicit = policy.executionRoots ?? [];
  assertAbsoluteRoots(explicit, "executionRoots");
  assertAbsoluteRoots(verifiedExecutables, "verifiedExecutables");
  const roots = uniquePaths([
    ...explicit.map(comparablePath),
    ...toolchains.flatMap((toolchain) => toolchain.executionRoots)
  ]);
  if (path.isAbsolute(command.executable)
    && !explicit.some((root) => pathWithin(command.executable, root))
    && !toolchains.some((toolchain) => samePath(toolchain.executable, command.executable))
    && !verifiedExecutables.some((candidate) => samePath(candidate, command.executable))) {
    throw new BrokerExecutableUnavailableError(
      "The absolute executable is not an exact toolchain entry point, verified shell, or explicitly trusted primary."
    );
  }
  return roots;
}

function wireCommand(command: CommandSpec, toolchains: NormalizedTrustedToolchain[]): Record<string, unknown> {
  if (!command.executable || typeof command.executable !== "string") throw new BrokerPolicyError("Command executable is required.");
  if (!path.isAbsolute(command.cwd)) throw new BrokerPolicyError("Command cwd must be absolute.");
  if (command.args?.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
    throw new BrokerPolicyError("Command arguments must be NUL-free strings.");
  }
  if (command.executable.includes("\0") || command.cwd.includes("\0") || command.stdin?.includes("\0")) {
    throw new BrokerPolicyError("Command values cannot contain NUL bytes.");
  }
  return {
    executable: command.executable,
    args: command.args ?? [],
    cwd: path.resolve(command.cwd),
    env: applyTrustedToolchains(createMinimalEnvironment(command.environment), toolchains),
    ...(command.stdin === undefined ? {} : { stdin: command.stdin })
  };
}

function wirePolicy(
  command: CommandSpec,
  policy: ExecutionPolicy,
  options: SigmaExecBrokerClientOptions,
  toolchains: NormalizedTrustedToolchain[],
  verifiedExecutables: string[],
  executableSha256: string | undefined
): Record<string, unknown> {
  assertAbsoluteRoots(policy.readRoots, "readRoots");
  assertAbsoluteRoots(policy.writeRoots, "writeRoots");
  assertAbsoluteRoots(policy.protectedPaths ?? [], "protectedPaths");
  const resolvedExecutionRoots = executionRoots(command, policy, toolchains, verifiedExecutables);
  const runtimeRoots = toolchains
    .filter((toolchain) => samePath(toolchain.executable, command.executable))
    .flatMap((toolchain) => toolchain.runtimeRoots);
  const resolvedWriteRoots = policy.writeRoots.map((root) => path.resolve(root));
  if (resolvedExecutionRoots.some((executionRoot) => resolvedWriteRoots.some((writeRoot) =>
    pathWithin(executionRoot, writeRoot) || pathWithin(writeRoot, executionRoot)
  ))) {
    throw new BrokerPolicyError("executionRoots must not overlap writeRoots.");
  }
  if (runtimeRoots.some((runtimeRoot) => resolvedWriteRoots.some((writeRoot) =>
    pathWithin(runtimeRoot, writeRoot) || pathWithin(writeRoot, runtimeRoot)
  ))) {
    throw new BrokerPolicyError("trusted runtimeRoots must not overlap writeRoots.");
  }
  if (policy.network === "full" && policy.networkApproved !== true) {
    throw new BrokerPolicyError("Full network access requires an explicit per-call approval.");
  }
  if (policy.sandbox === "unsafe" && (!options.allowUnsafeHostExec || policy.unsafeHostExecApproved !== true)) {
    throw new BrokerPolicyError("Unsafe host execution requires broker opt-in and explicit per-call approval.");
  }
  return {
    sandbox: policy.sandbox,
    network: policy.network,
    networkApproved: policy.networkApproved === true,
    readRoots: uniquePaths([
      ...policy.readRoots.map((root) => path.resolve(root)),
      ...runtimeRoots
    ]),
    writeRoots: resolvedWriteRoots,
    executionRoots: resolvedExecutionRoots,
    ...(executableSha256 ? { executableSha256 } : {}),
    protectedPaths: defaultProtectedPaths(policy).map((item) => path.resolve(item)),
    unsafeHostExecApproved: policy.unsafeHostExecApproved === true
  };
}

export function requestParams(
  request: ExecutionRequest | ProcessSpawnRequest,
  options: SigmaExecBrokerClientOptions,
  toolchains: NormalizedTrustedToolchain[],
  verifiedExecutables: string[]
): Record<string, unknown> {
  const executable = resolveTrustedExecutable(request.command.executable, toolchains, request.command.cwd);
  assertTrustedExecutableAvailable(executable, toolchains, options.sandboxMode);
  const executableSha256 = trustedExecutableSha256(executable, toolchains, options.sandboxMode);
  const resolvedCommand = {
    ...request.command,
    executable
  };
  if (request.policy.sandbox === "required") {
    const roots = [...request.policy.readRoots, ...request.policy.writeRoots];
    if (!roots.some((root) => pathWithin(request.command.cwd, root))) {
      throw new BrokerPolicyError("A sandboxed command cwd must be inside a declared read or write root.");
    }
  }
  return {
    command: wireCommand(resolvedCommand, toolchains),
    policy: wirePolicy(
      resolvedCommand, request.policy, options, toolchains, verifiedExecutables, executableSha256
    ),
    maxOutputBytes: positiveInteger(request.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes"),
    ...("pty" in request && request.pty === true ? {
      pty: true,
      ptyColumns: ptyDimension(request.ptyColumns, 120, "ptyColumns"),
      ptyRows: ptyDimension(request.ptyRows, 30, "ptyRows")
    } : {})
  };
}

export function redactionSecrets(
  secrets: SigmaExecBrokerClientOptions["secrets"]
): Array<{ name: string; value: string }> {
  const result = Object.entries(secrets ?? {}).flatMap(([name, value]) => {
    if (!value || value.length < 4) return [];
    if (name.length > 128 || name.includes("\0") || value.length > 64 * 1024 || value.includes("\0")) {
      throw new BrokerPolicyError("Artifact redaction secrets exceed native broker limits.");
    }
    return [{ name, value }];
  });
  if (result.length > 128) throw new BrokerPolicyError("At most 128 artifact redaction secrets are allowed.");
  return result;
}
