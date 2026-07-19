import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  ContainerAttestationInvalidError,
  ContainerUnavailableError
} from "./errors.js";
import {
  assertContainerExecutionConfig,
  managedContainerAttestationDigest
} from "./container-execution-broker.js";
import { SigmaExecBrokerClient } from "./broker-client.js";
import type {
  TrustedContainerLauncherV1,
  TrustedManagedContainerAttestationV1
} from "./types.js";

export const FIXED_OCI_BOUNDARY_ROOT = "/run/sigma-oci";
export const FIXED_OCI_BROKER_SOCKET = `${FIXED_OCI_BOUNDARY_ROOT}/broker.sock`;
export const FIXED_OCI_ATTESTATION_PATH = `${FIXED_OCI_BOUNDARY_ROOT}/attestation.json`;
export const FIXED_OCI_ARTIFACT_ROOT = `${FIXED_OCI_BOUNDARY_ROOT}/artifacts`;
const MAX_ATTESTATION_BYTES = 64 * 1024;
const ATTESTATION_KEYS = new Set([
  "protocolVersion", "engine", "selector", "targetId", "targetStartedAt",
  "imageId", "imageDigest", "labelsDigest", "helperDigest", "attestationDigest", "workspace"
]);

interface FixedAttestationDocument extends TrustedManagedContainerAttestationV1 {
  workspace?: string;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContainerAttestationInvalidError("Fixed OCI attestation must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.includes("\0") || value.length > 4_096) {
    throw new ContainerAttestationInvalidError(`Fixed OCI attestation '${field}' is invalid.`, { field });
  }
  return value;
}

export function parseFixedContainerAttestation(source: string): FixedAttestationDocument {
  let decoded: unknown;
  try {
    decoded = JSON.parse(source) as unknown;
  } catch (error) {
    throw new ContainerAttestationInvalidError("Fixed OCI attestation is not valid JSON.", undefined, {
      cause: error
    });
  }
  const value = record(decoded);
  const unknown = Object.keys(value).find((key) => !ATTESTATION_KEYS.has(key));
  if (unknown) {
    throw new ContainerAttestationInvalidError(`Unknown fixed OCI attestation field '${unknown}'.`);
  }
  if (value.protocolVersion !== 1 || (value.engine !== "docker" && value.engine !== "podman")) {
    throw new ContainerAttestationInvalidError("Fixed OCI attestation protocol or engine is unsupported.");
  }
  const imageDigest = value.imageDigest === undefined || value.imageDigest === null
    ? undefined : requiredString(value.imageDigest, "imageDigest");
  const workspace = value.workspace === undefined
    ? undefined : requiredString(value.workspace, "workspace");
  const result: FixedAttestationDocument = {
    protocolVersion: 1,
    engine: value.engine,
    selector: requiredString(value.selector, "selector"),
    targetId: requiredString(value.targetId, "targetId"),
    targetStartedAt: requiredString(value.targetStartedAt, "targetStartedAt"),
    imageId: requiredString(value.imageId, "imageId"),
    ...(imageDigest ? { imageDigest } : {}),
    labelsDigest: requiredString(value.labelsDigest, "labelsDigest"),
    helperDigest: requiredString(value.helperDigest, "helperDigest"),
    attestationDigest: requiredString(value.attestationDigest, "attestationDigest"),
    ...(workspace ? { workspace } : {})
  };
  assertContainerExecutionConfig({ engine: result.engine, target: "managed" }, result);
  return result;
}

async function assertBoundaryPath(
  target: string,
  expected: "directory" | "file" | "socket"
): Promise<void> {
  const info = await lstat(target).catch(() => undefined);
  const expectedType = expected === "directory" ? info?.isDirectory()
    : expected === "file" ? info?.isFile() : info?.isSocket();
  if (!info || info.isSymbolicLink() || !expectedType) {
    throw new ContainerUnavailableError(`Fixed OCI ${expected} boundary is unavailable.`, { target });
  }
  if (typeof info.uid === "number" && info.uid !== 0) {
    throw new ContainerAttestationInvalidError(`Fixed OCI ${expected} boundary is not root-owned.`, { target });
  }
  const forbidden = expected === "socket" ? 0o002 : expected === "file" ? 0o222 : 0o022;
  if ((info.mode & forbidden) !== 0) {
    throw new ContainerAttestationInvalidError(`Fixed OCI ${expected} boundary permissions are unsafe.`, {
      target, mode: info.mode & 0o777
    });
  }
}

async function readPinnedAttestation(): Promise<string> {
  await assertBoundaryPath(FIXED_OCI_ATTESTATION_PATH, "file");
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(FIXED_OCI_ATTESTATION_PATH, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > MAX_ATTESTATION_BYTES) {
      throw new ContainerAttestationInvalidError("Fixed OCI attestation file size is invalid.");
    }
    const source = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new ContainerAttestationInvalidError("Fixed OCI attestation changed while it was read.");
    }
    return source;
  } finally {
    await handle.close();
  }
}

/** Discovers only Sigma's fixed product boundary. No environment variable,
 * CLI flag, workspace file, or evaluator input may change these paths. */
export async function loadFixedContainerLauncher(
  workspace: string,
  platform: NodeJS.Platform = process.platform
): Promise<TrustedContainerLauncherV1 | undefined> {
  if (platform !== "linux") return undefined;
  await assertBoundaryPath(FIXED_OCI_BOUNDARY_ROOT, "directory");
  await assertBoundaryPath(FIXED_OCI_BROKER_SOCKET, "socket");
  const attestation = parseFixedContainerAttestation(await readPinnedAttestation());
  const canonicalWorkspace = await realpath(workspace);
  if (attestation.workspace && path.resolve(attestation.workspace) !== canonicalWorkspace) {
    throw new ContainerAttestationInvalidError("Fixed OCI attestation is bound to another workspace.");
  }
  const { workspace: _workspace, ...managedAttestation } = attestation;
  return {
    protocolVersion: 1,
    managedAttestation,
    createBroker: (request) => {
      if (request.config.target !== "managed") {
        throw new ContainerUnavailableError(
          "The fixed OCI boundary supports managed targets only; no owned-container launcher is installed."
        );
      }
      if (path.resolve(request.workspace) !== canonicalWorkspace) {
        throw new ContainerAttestationInvalidError("OCI broker request escaped its attested workspace.");
      }
      return new SigmaExecBrokerClient({
        socketPath: FIXED_OCI_BROKER_SOCKET,
        sandboxMode: "required",
        executionBackend: "oci",
        artifactRootParent: FIXED_OCI_ARTIFACT_ROOT,
        trustedToolchains: []
      });
    }
  };
}

/** Exported for sidecar implementations and protocol fixtures. */
export const fixedContainerAttestationDigest = managedContainerAttestationDigest;
