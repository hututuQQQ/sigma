import { deriveRepositoryValidationCapabilities } from "agent-context";
import type { RuntimeSession } from "./types.js";

function verifiedRuntimeCommands(session: RuntimeSession): string[] {
  const environment = session.services.runtimeEnvironment;
  return environment?.executionCapabilitiesVerified ? environment.availableRuntimeCommands : [];
}

function runtimeCommandSnapshotComplete(session: RuntimeSession): boolean {
  const environment = session.services.runtimeEnvironment;
  return environment?.executionCapabilitiesVerified === true
    && environment.runtimeCommandSnapshotComplete === true;
}

/** Refresh the non-durable profile whenever the workspace state changes.
 * Restore deliberately starts without a cache and therefore re-derives it. */
export async function refreshValidationCapabilityProfile(
  session: RuntimeSession,
  signal: AbortSignal
): Promise<void> {
  // Capability information cannot affect a frontier that has no mutations.
  // Deferring the bounded repository scan keeps first-turn reads and approval
  // scheduling responsive; the first post-mutation turn derives it.
  if (session.durable.state.mutationFrontier.changedPaths.length === 0) return;
  const stateDigest = session.durable.state.mutationFrontier.currentStateDigest;
  if (session.interaction.validationCapabilities?.stateDigest === stateDigest) return;
  try {
    session.interaction.validationCapabilities = await deriveRepositoryValidationCapabilities(
      session.identity.workspacePath,
      signal,
      {
        stateDigest,
        availableCommands: verifiedRuntimeCommands(session),
        availableCommandsComplete: runtimeCommandSnapshotComplete(session)
      }
    );
  } catch {
    signal.throwIfAborted();
    // An incomplete profile may never authorize an assurance downgrade.
    session.interaction.validationCapabilities = {
      stateDigest,
      complete: false,
      availableCommands: verifiedRuntimeCommands(session),
      availableCommandsComplete: false,
      projects: []
    };
  }
}
