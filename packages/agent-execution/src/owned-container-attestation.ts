import { createHash } from "node:crypto";
import path from "node:path";
import { ContainerAttestationInvalidError } from "./errors.js";
import type {
  OwnedOciContainerInspection,
  OwnedOciCreateSpec,
  OwnedOciImageIdentity
} from "./owned-oci-engine.js";
import type { BrokerDoctorReport, NetworkPolicy, ResolvedContainerEngine } from "./types.js";

export interface OwnedPinnedIdentity {
  engine: ResolvedContainerEngine;
  targetId: string;
  targetStartedAt: string;
  imageId: string;
  imageDigest: string;
  labelsDigest: string;
}

export function ownedNetworkEnvelope(network: NetworkPolicy): NetworkPolicy[] {
  if (network === "none") return ["none"];
  if (network === "loopback") return ["none", "loopback"];
  return ["none", "loopback", "full"];
}

function stableDigest(value: Record<string, string>): string {
  const stable = Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
  return `sha256:${createHash("sha256").update(JSON.stringify(stable)).digest("hex")}`;
}

function pathMount(
  inspection: OwnedOciContainerInspection,
  source: string,
  target: string,
  readOnly: boolean
): boolean {
  return inspection.mounts.some((mount) =>
    path.resolve(mount.source) === path.resolve(source)
    && path.resolve(mount.target) === path.resolve(target)
    && mount.readOnly === readOnly);
}

function networkMatches(network: NetworkPolicy, inspection: OwnedOciContainerInspection): boolean {
  if (network === "full") {
    return (inspection.networkMode === "bridge" || inspection.networkMode === "default")
      && inspection.networkNames.length > 0;
  }
  return inspection.networkMode === "none"
    && inspection.networkNames.every((name) => name === "none");
}

function nestedSandboxMatches(inspection: OwnedOciContainerInspection): boolean {
  return inspection.capAdd.some((capability) => capability === "SYS_ADMIN" || capability === "CAP_SYS_ADMIN")
    && inspection.securityOpt.includes("seccomp=unconfined");
}

export function attestOwnedContainer(
  engine: ResolvedContainerEngine,
  targetId: string,
  proofLabels: Record<string, string>,
  inspection: OwnedOciContainerInspection,
  image: OwnedOciImageIdentity,
  spec: OwnedOciCreateSpec
): OwnedPinnedIdentity {
  const labelsMatch = Object.entries(proofLabels).every(([key, value]) => inspection.labels[key] === value);
  const mountsMatch = pathMount(inspection, spec.workspace, spec.workspace, false)
    && pathMount(inspection, spec.helperPath, spec.helperTarget, true)
    && pathMount(inspection, spec.sandboxHelperPath, spec.sandboxHelperTarget, true)
    && pathMount(inspection, spec.artifactParent, spec.artifactParent, false);
  if (!inspection.running || inspection.targetId !== targetId
    || inspection.imageId.toLowerCase() !== image.imageId.toLowerCase()
    || !inspection.targetStartedAt || inspection.targetStartedAt.startsWith("0001-")
    || !labelsMatch || !mountsMatch || !networkMatches(spec.network, inspection)
    || !nestedSandboxMatches(inspection)) {
    throw new ContainerAttestationInvalidError("Owned OCI target failed identity or containment attestation.", {
      targetId: inspection.targetId,
      expectedTargetId: targetId
    });
  }
  return {
    engine,
    targetId: inspection.targetId,
    targetStartedAt: inspection.targetStartedAt,
    imageId: inspection.imageId,
    imageDigest: image.imageDigest,
    labelsDigest: stableDigest(inspection.labels)
  };
}

export function patchOwnedContainerReport(
  report: BrokerDoctorReport,
  pinned: OwnedPinnedIdentity,
  network: NetworkPolicy
): BrokerDoctorReport {
  const allowed = new Set(ownedNetworkEnvelope(network));
  return {
    ...report,
    sandbox: { ...report.sandbox, backend: "oci" },
    capabilities: {
      ...report.capabilities,
      networkModes: report.capabilities.networkModes.filter((mode) => allowed.has(mode))
    },
    container: {
      available: true,
      backend: "oci",
      engine: pinned.engine,
      target: "owned",
      targetId: pinned.targetId,
      targetStartedAt: pinned.targetStartedAt,
      imageId: pinned.imageId,
      imageDigest: pinned.imageDigest
    }
  };
}
