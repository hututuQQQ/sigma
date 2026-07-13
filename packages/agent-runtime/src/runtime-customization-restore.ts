import { restoreFrozenAgentProfile, restoreSessionCustomization } from "agent-extensions";
import type { ContentAddressedArtifactStore } from "agent-store";
import { addFrozenSkillMetadata } from "./runtime-session-initialization.js";
import { assertFrozenProfileResources, assertProfileResources } from "./session-profile.js";
import type { RuntimeOptions, RuntimeSession } from "./types.js";

/** Hydrates only digest-bound session artifacts. Live resources are consulted
 * solely for compatibility with sessions created before customization bundles. */
export async function restoreRuntimeCustomization(
  session: RuntimeSession,
  artifacts: ContentAddressedArtifactStore,
  options: RuntimeOptions
): Promise<void> {
  const profileReference = session.durable.state.frozenProfile;
  if (profileReference) {
    const artifact = await artifacts.get(session.identity.sessionId, profileReference.artifactId);
    session.services.profile = restoreFrozenAgentProfile(artifact.toString("utf8"), profileReference.digest);
    session.services.profileSource = profileReference.source;
  }
  const customizationReference = session.durable.state.frozenCustomization;
  if (customizationReference) {
    const artifact = await artifacts.get(session.identity.sessionId, customizationReference.artifactId);
    session.durable.frozenCustomization = restoreSessionCustomization(
      artifact.toString("utf8"), customizationReference.digest
    );
    assertFrozenProfileResources(session.services.profile, session.durable.frozenCustomization);
    addFrozenSkillMetadata(session, session.durable.frozenCustomization);
  } else {
    assertProfileResources(options, session.services.profile);
  }
  session.services.gateway = options.gatewayForRole?.(session.services.modelRole, session.services.profile) ?? options.gateway;
}
