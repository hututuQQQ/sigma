import type {
  BrokerRuntimeClosureV1,
  ManagedSessionBindingV1,
} from "./types.js";
import { stableSha256 } from "./container-attestation.js";

/** Refresh the one broker-issued session capability in place so every holder
 * observes the authenticated post-prepare runtime closure. */
export function refreshManagedSessionBinding(
  binding: ManagedSessionBindingV1,
  runtimeClosure: BrokerRuntimeClosureV1
): void {
  const payload = {
    protocolVersion: binding.protocolVersion,
    sessionId: binding.sessionId,
    workspace: binding.workspace,
    network: binding.network,
    protectedPaths: binding.protectedPaths,
    lifetime: binding.lifetime,
    targetId: binding.targetId,
    targetStartedAt: binding.targetStartedAt,
    targetAttestationDigest: binding.targetAttestationDigest,
    protectedPathsDigest: binding.protectedPathsDigest,
    runtimeClosure,
    scratchLease: binding.scratchLease
  };
  Object.assign(binding, payload, { bindingId: stableSha256(payload) });
}
