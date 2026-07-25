import type { ContentAddressedArtifactStore } from "agent-store";
import { ModelReviewer } from "./reviewer.js";
import { ActiveReviewerToolEnvironment } from "./reviewer-tool-environment.js";
import type { RuntimeControlService } from "./runtime-control.js";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import type { RuntimeOptions, RuntimeSession } from "./types.js";

export function runtimeReviewerFactory(
  options: RuntimeOptions,
  control: RuntimeControlService,
  artifacts: ContentAddressedArtifactStore,
  emit: RuntimeEventEmitter
): NonNullable<RuntimeOptions["reviewerForSession"]> {
  if (options.reviewerForSession) return options.reviewerForSession;
  if (options.reviewer) return () => options.reviewer!;
  return (candidate) => {
    const session = candidate as RuntimeSession;
    const assurance = session.services.profile?.profile.assurancePolicy;
    return new ModelReviewer(
      options.gatewayForRole?.("reviewer", session.services.profile)
        ?? session.services.gateway,
      "builtin-active-reviewer",
      new ActiveReviewerToolEnvironment({
        session,
        tools: options.tools,
        control,
        emit,
        createArtifact: async (sessionId, content) =>
          await artifacts.put(sessionId, content),
        networkMode: options.managedNetworkMode ?? "full",
        allowEnclosingContainerRead:
          options.runtimeEnvironment?.writeScope === "enclosing-container"
          && Boolean(options.runtimeEnvironment.enclosingContainerAttestationDigest)
      }),
      {
        maxTurns: assurance?.reviewerMaxTurns ?? 4,
        maxToolCalls: assurance?.reviewerMaxToolCalls ?? 12
      }
    );
  };
}
