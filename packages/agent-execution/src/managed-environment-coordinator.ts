import {
  ContainerAttestationInvalidError,
  ContainerUnavailableError
} from "./errors.js";
import { protocolRecord } from "./protocol.js";
import { stableSha256 } from "./container-attestation.js";
import type {
  BrokerRuntimeClosureV1,
  ManagedEnvironmentPrepareRequestV1,
  ManagedEnvironmentPrepareResultV1,
  ManagedSessionBindingV1
} from "./types.js";

const PACKAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9+._-]{0,127}$/u;
const EXECUTABLE_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PACKAGE_MANAGERS = new Set(["apt-get", "apk", "dnf", "microdnf", "yum"]);

function stringField(value: unknown, name: string, maximum = 4_096): string {
  if (typeof value !== "string" || !value || value.includes("\0") || value.length > maximum) {
    throw new ContainerAttestationInvalidError(`Managed environment '${name}' is invalid.`);
  }
  return value;
}

function digestField(value: unknown, name: string): string {
  const digest = stringField(value, name, 80);
  if (!SHA256_PATTERN.test(digest)) {
    throw new ContainerAttestationInvalidError(`Managed environment '${name}' is not a SHA-256 digest.`);
  }
  return digest;
}

export function canonicalManagedEnvironmentRequest(
  request: ManagedEnvironmentPrepareRequestV1
): ManagedEnvironmentPrepareRequestV1 {
  const executable = request.requestedExecutable;
  const validExecutable = EXECUTABLE_ALIAS_PATTERN.test(executable)
    || (/^\/(?:[^/\0]+\/)*[^/\0]+$/u.test(executable) && !executable.split("/").includes(".."));
  const packages = [...new Set(request.packages)].sort();
  if (request.protocolVersion !== 1
    || !/^[A-Za-z0-9_.-]{1,128}$/u.test(request.sessionId)
    || !validExecutable || packages.length === 0 || packages.length > 32
    || packages.some((item) => !PACKAGE_PATTERN.test(item))) {
    throw new ContainerAttestationInvalidError(
      "Managed environment preparation request is invalid."
    );
  }
  return { ...request, packages };
}

function runtimeClosure(value: unknown): BrokerRuntimeClosureV1 {
  const closure = protocolRecord(value, "managed environment runtime closure");
  if (closure.protocolVersion !== 1 || typeof closure.complete !== "boolean") {
    throw new ContainerAttestationInvalidError("Managed environment runtime closure is invalid.");
  }
  const runtimeDataDigest = closure.runtimeDataDigest === undefined
    ? undefined : digestField(closure.runtimeDataDigest, "runtimeClosure.runtimeDataDigest");
  return {
    protocolVersion: 1,
    digest: digestField(closure.digest, "runtimeClosure.digest"),
    complete: closure.complete,
    platform: stringField(closure.platform, "runtimeClosure.platform", 128),
    architecture: stringField(closure.architecture, "runtimeClosure.architecture", 128),
    executableSearchPathsDigest: digestField(
      closure.executableSearchPathsDigest, "runtimeClosure.executableSearchPathsDigest"
    ),
    runtimeCommandsDigest: digestField(
      closure.runtimeCommandsDigest, "runtimeClosure.runtimeCommandsDigest"
    ),
    ...(runtimeDataDigest ? { runtimeDataDigest } : {}),
    targetAttestationDigest: digestField(
      closure.targetAttestationDigest, "runtimeClosure.targetAttestationDigest"
    )
  };
}

export function parseManagedEnvironmentResult(input: unknown): ManagedEnvironmentPrepareResultV1 {
  const value = protocolRecord(input, "managed environment preparation result");
  if (value.protocolVersion !== 1 || value.status !== "prepared"
    || !Array.isArray(value.packages) || value.packages.length === 0 || value.packages.length > 32
    || value.packages.some((item) => typeof item !== "string" || !PACKAGE_PATTERN.test(item))
    || !Array.isArray(value.installedPackages) || value.installedPackages.length === 0
    || value.installedPackages.length > 256) {
    throw new ContainerAttestationInvalidError("Managed environment preparation result is invalid.");
  }
  const installedPackages = value.installedPackages.map((raw, index) => {
    const item = protocolRecord(raw, `managed environment installedPackages[${index}]`);
    return {
      name: stringField(item.name, `installedPackages[${index}].name`, 128),
      version: stringField(item.version, `installedPackages[${index}].version`, 256),
      source: stringField(item.source, `installedPackages[${index}].source`, 1_024),
      digest: digestField(item.digest, `installedPackages[${index}].digest`)
    };
  });
  const packageManager = stringField(value.packageManager, "packageManager", 32);
  if (!PACKAGE_MANAGERS.has(packageManager)) {
    throw new ContainerAttestationInvalidError("Managed environment package manager is invalid.");
  }
  if (value.signaturePolicy !== "trusted-system-package-manager-defaults") {
    throw new ContainerAttestationInvalidError("Managed environment signature policy is invalid.");
  }
  return {
    protocolVersion: 1,
    status: "prepared",
    sessionId: stringField(value.sessionId, "sessionId", 128),
    requestedExecutable: stringField(value.requestedExecutable, "requestedExecutable", 256),
    packages: [...new Set(value.packages as string[])].sort(),
    installedPackages,
    packageManager: packageManager as ManagedEnvironmentPrepareResultV1["packageManager"],
    signaturePolicy: "trusted-system-package-manager-defaults",
    attemptDigest: digestField(value.attemptDigest, "attemptDigest"),
    installedEvidenceDigest: digestField(value.installedEvidenceDigest, "installedEvidenceDigest"),
    previousRuntimeClosureDigest: digestField(
      value.previousRuntimeClosureDigest, "previousRuntimeClosureDigest"
    ),
    runtimeClosure: runtimeClosure(value.runtimeClosure),
    receiptDigest: digestField(value.receiptDigest, "receiptDigest")
  };
}

/** One-shot control-plane guard. Package-manager execution remains entirely
 * behind the authenticated managed broker method; this class never grants a
 * generic process write root. */
export class ManagedEnvironmentCoordinator {
  private readonly attempts = new Map<string, Set<string>>();

  release(sessionId: string): void {
    this.attempts.delete(sessionId);
  }

  clear(): void {
    this.attempts.clear();
  }

  authorize(
    binding: ManagedSessionBindingV1,
    request: ManagedEnvironmentPrepareRequestV1
  ): ManagedEnvironmentPrepareRequestV1 {
    const canonical = canonicalManagedEnvironmentRequest(request);
    if (canonical.sessionId !== binding.sessionId || binding.network !== "full") {
      throw new ContainerUnavailableError(
        "Managed environment preparation requires its full-network managed session binding."
      );
    }
    const opportunity = stableSha256({
      sessionId: canonical.sessionId,
      requestedExecutable: canonical.requestedExecutable
    });
    const attempts = this.attempts.get(canonical.sessionId) ?? new Set<string>();
    if (attempts.has(opportunity)) {
      throw Object.assign(new Error(
        "The recovery opportunity for this executable has already been consumed."
      ), { code: "managed_environment_prepare_repeated" });
    }
    attempts.add(opportunity);
    this.attempts.set(canonical.sessionId, attempts);
    return canonical;
  }

  accept(
    request: ManagedEnvironmentPrepareRequestV1,
    previousRuntimeClosureDigest: string,
    rawResult: ManagedEnvironmentPrepareResultV1,
    currentRuntimeClosure: BrokerRuntimeClosureV1
  ): ManagedEnvironmentPrepareResultV1 {
    const result = parseManagedEnvironmentResult(rawResult);
    const opportunity = stableSha256({
      sessionId: request.sessionId,
      requestedExecutable: request.requestedExecutable
    });
    const expectedAttemptDigest = stableSha256({ opportunity, packages: request.packages });
    const expectedInstalledDigest = stableSha256(result.installedPackages);
    if (result.sessionId !== request.sessionId
      || result.requestedExecutable !== request.requestedExecutable
      || stableSha256(result.packages) !== stableSha256(request.packages)
      || result.previousRuntimeClosureDigest !== previousRuntimeClosureDigest
      || result.attemptDigest !== expectedAttemptDigest
      || result.installedEvidenceDigest !== expectedInstalledDigest
      || result.runtimeClosure.digest !== currentRuntimeClosure.digest
      || result.runtimeClosure.complete !== true
      || currentRuntimeClosure.complete !== true
      || currentRuntimeClosure.digest === previousRuntimeClosureDigest) {
      throw Object.assign(new ContainerUnavailableError(
        "Managed broker preparation evidence does not match the bound request and refreshed runtime closure."
      ), { code: "managed_environment_prepare_ineffective" });
    }
    const { receiptDigest: _receiptDigest, ...payload } = result;
    const receiptDigest = stableSha256(payload);
    if (receiptDigest !== result.receiptDigest) {
      throw new ContainerAttestationInvalidError(
        "Managed environment preparation receipt digest is invalid."
      );
    }
    return result;
  }
}
