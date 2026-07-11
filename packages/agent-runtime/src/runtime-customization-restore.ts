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
  const profileReference = session.state.frozenProfile;
  if (profileReference) {
    const artifact = await artifacts.get(session.sessionId, profileReference.artifactId);
    session.profile = restoreFrozenAgentProfile(artifact.toString("utf8"), profileReference.digest);
    session.profileSource = profileReference.source;
  }
  const customizationReference = session.state.frozenCustomization;
  if (customizationReference) {
    const artifact = await artifacts.get(session.sessionId, customizationReference.artifactId);
    session.frozenCustomization = restoreSessionCustomization(
      artifact.toString("utf8"), customizationReference.digest
    );
    assertFrozenProfileResources(session.profile, session.frozenCustomization);
    addFrozenSkillMetadata(session, session.frozenCustomization);
  } else {
    assertProfileResources(options, session.profile);
  }
  session.gateway = options.gatewayForRole?.(session.modelRole, session.profile) ?? options.gateway;
}
