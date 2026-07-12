import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync } from "node:fs";
import { BrokerToolchainUnavailableError } from "./errors.js";
import {
  inspectPeAuthenticodeIdentity,
  type PeCertificateTableIdentity
} from "./pe-authenticode-identity.js";
import type { WindowsAppContainerNodeCompatibilityProof } from "./types.js";

export const WINDOWS_APPCONTAINER_NODE_COMPATIBILITY = Object.freeze({
  kind: "windows_appcontainer_node" as const,
  patchId: "node-v26.4.0-win-x64-libuv-local-pipe-v2",
  nodeVersion: "v26.4.0",
  targetPlatform: "win32" as const,
  targetArch: "x64" as const,
  sourceSha256: "3193d7f751b8a07bd4acc70e81946ae9c6efdee83e07ad1c8d0e4089df7c5cef",
  unsignedPatchedSha256: "b30b9546e4c9fddffbd4054ef4a78cdd76b42a8496bfb6308a7966bae37fea8f",
  normalizedContentSha256: "6345a8101a378aea8f004210fe3924b6bcc77029abd35d9a86fa88e65a65bf35",
  requiredNodeOptions: "--preserve-symlinks-main",
  reason: "Use AppContainer-local libuv pipe names for captured stdio and Node IPC."
});

export const WINDOWS_NODE_GLOBAL_PIPE_MARKER = Buffer.from("\\\\?\\pipe\\uv\\%llu-%lu\0", "ascii");
export const WINDOWS_NODE_LOCAL_PIPE_MARKER = Buffer.from("\\\\?\\pipe\\LOCAL\\%u-%u\0", "ascii");

export interface WindowsNodeExecutableInspection {
  sha256: string;
  normalizedContentSha256: string;
  certificateTable: PeCertificateTableIdentity | null;
  globalPipeMarkerCount: number;
  localPipeMarkerCount: number;
}

export interface WindowsNodeMarkerInspection {
  sha256: string;
  globalPipeMarkerCount: number;
  localPipeMarkerCount: number;
}

function markerCount(buffer: Buffer, marker: Buffer): number {
  let count = 0;
  let offset = 0;
  while (offset <= buffer.length - marker.length) {
    const found = buffer.indexOf(marker, offset);
    if (found < 0) break;
    count += 1;
    offset = found + 1;
  }
  return count;
}

function readExecutableBytes(executable: string): Buffer {
  const descriptor = openSync(executable, "r");
  try {
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function markerInspection(bytes: Buffer): WindowsNodeMarkerInspection {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    globalPipeMarkerCount: markerCount(bytes, WINDOWS_NODE_GLOBAL_PIPE_MARKER),
    localPipeMarkerCount: markerCount(bytes, WINDOWS_NODE_LOCAL_PIPE_MARKER)
  };
}

/** Detect Node/libuv markers without requiring a generic tool to be a PE image. */
export function inspectWindowsNodeMarkers(executable: string): WindowsNodeMarkerInspection {
  return markerInspection(readExecutableBytes(executable));
}

/** Hash, PE-normalize, and marker-scan one call-bound executable byte snapshot. */
export function inspectWindowsNodeExecutable(executable: string): WindowsNodeExecutableInspection {
  const bytes = readExecutableBytes(executable);
  const identity = inspectPeAuthenticodeIdentity(bytes, executable);
  return {
    ...markerInspection(bytes),
    normalizedContentSha256: identity.normalizedContentSha256,
    certificateTable: identity.certificateTable
  };
}

function unavailable(toolchainId: string, reason: string): never {
  throw new BrokerToolchainUnavailableError(toolchainId, reason);
}

function assertKnownInspection(toolchainId: string, inspection: WindowsNodeExecutableInspection): void {
  if (inspection.normalizedContentSha256 !== WINDOWS_APPCONTAINER_NODE_COMPATIBILITY.normalizedContentSha256) {
    unavailable(toolchainId, "the normalized PE content is not the approved patched Node runtime");
  }
  if (inspection.globalPipeMarkerCount !== 0 || inspection.localPipeMarkerCount !== 1) {
    unavailable(toolchainId, "the AppContainer pipe marker layout is absent, ambiguous, or unpatched");
  }
}

export function createWindowsAppContainerNodeCompatibilityProof(
  executable: string,
  toolchainId = "runtime-node"
): WindowsAppContainerNodeCompatibilityProof {
  let inspection: WindowsNodeExecutableInspection;
  try {
    inspection = inspectWindowsNodeExecutable(executable);
  } catch (error) {
    unavailable(toolchainId, error instanceof Error ? error.message : "the executable could not be inspected");
  }
  assertKnownInspection(toolchainId, inspection);
  return {
    kind: WINDOWS_APPCONTAINER_NODE_COMPATIBILITY.kind,
    patchId: WINDOWS_APPCONTAINER_NODE_COMPATIBILITY.patchId,
    sourceSha256: WINDOWS_APPCONTAINER_NODE_COMPATIBILITY.sourceSha256,
    normalizedContentSha256: inspection.normalizedContentSha256,
    executableSha256: inspection.sha256
  };
}

export function assertWindowsAppContainerNodeCompatibility(
  executable: string,
  proof: WindowsAppContainerNodeCompatibilityProof | undefined,
  toolchainId: string
): void {
  if (!proof
    || proof.kind !== WINDOWS_APPCONTAINER_NODE_COMPATIBILITY.kind
    || proof.patchId !== WINDOWS_APPCONTAINER_NODE_COMPATIBILITY.patchId
    || proof.sourceSha256 !== WINDOWS_APPCONTAINER_NODE_COMPATIBILITY.sourceSha256
    || proof.normalizedContentSha256 !== WINDOWS_APPCONTAINER_NODE_COMPATIBILITY.normalizedContentSha256
    || !/^[a-f0-9]{64}$/u.test(proof.executableSha256)) {
    unavailable(toolchainId, "a recognized Windows AppContainer Node compatibility proof is required");
  }
  let inspection: WindowsNodeExecutableInspection;
  try {
    inspection = inspectWindowsNodeExecutable(executable);
  } catch (error) {
    unavailable(toolchainId, error instanceof Error ? error.message : "the executable could not be inspected");
  }
  assertKnownInspection(toolchainId, inspection);
  if (inspection.sha256 !== proof.executableSha256) {
    unavailable(toolchainId, "the executable no longer matches its compatibility proof");
  }
}
