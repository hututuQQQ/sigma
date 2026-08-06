import type { ContentAddressedArtifactStore } from "agent-store";
import { beginNextRun } from "./run-transitions.js";
import {
  compileRuntimeHarness,
  installRuntimeHarnessContext,
  stageRuntimeHarnessArtifact
} from "./runtime-harness.js";
import type { RuntimeEventLog } from "./runtime-event-log.js";
import type { RuntimeOptions, RuntimeSession } from "./types.js";

interface HarnessTransitionServices {
  runtime: RuntimeOptions;
  artifacts: ContentAddressedArtifactStore;
  events: RuntimeEventLog;
  runDeadlineMs: number | undefined;
}

function transitionSnapshot(session: RuntimeSession) {
  return {
    runId: session.durable.runId,
    modelTurn: session.durable.modelTurn,
    mode: session.durable.mode,
    frozenHarness: session.durable.frozenHarness,
    state: session.durable.state,
    lastOutcome: session.recovery.lastOutcome,
    contextItems: session.interaction.contextItems,
    loadedContextIds: new Set(session.interaction.loadedContextIds)
  };
}

function rollBackTransition(
  session: RuntimeSession,
  previous: ReturnType<typeof transitionSnapshot>
): void {
  session.durable.runId = previous.runId;
  session.durable.modelTurn = previous.modelTurn;
  session.durable.mode = previous.mode;
  session.durable.frozenHarness = previous.frozenHarness;
  session.durable.state = previous.state;
  session.recovery.lastOutcome = previous.lastOutcome;
  session.interaction.contextItems = previous.contextItems;
  session.interaction.loadedContextIds = previous.loadedContextIds;
}

async function beginUnchangedHarnessRun(
  session: RuntimeSession,
  mode: RuntimeSession["durable"]["mode"],
  services: HarnessTransitionServices
): Promise<void> {
  beginNextRun(session, mode, services.runDeadlineMs);
  await services.events.emit(session, "run.started", "runtime", {
    mode: session.durable.mode,
    ...(session.durable.state.deadlineAt
      ? { deadlineAt: session.durable.state.deadlineAt }
      : {})
  });
}

export async function beginRuntimeHarnessRun(
  session: RuntimeSession,
  requestedMode: RuntimeSession["durable"]["mode"],
  services: HarnessTransitionServices
): Promise<void> {
  const mode = session.durable.legacyHarnessReadOnly ? "analyze" : requestedMode;
  const current = session.durable.frozenHarness;
  if (!current && session.durable.state.harnessRequired) {
    throw Object.assign(new Error("A schema 1 session cannot begin without its frozen Harness."), {
      code: "compiled_harness_missing"
    });
  }
  if (!current || current.subject.runMode === mode) {
    await beginUnchangedHarnessRun(session, mode, services);
    return;
  }

  const harness = compileRuntimeHarness(
    services.runtime,
    session.services.gateway,
    session.services.modelRole,
    mode,
    session.services.profile
  );
  const harnessPayload = await stageRuntimeHarnessArtifact(
    session.identity.sessionId,
    harness,
    async (sessionId, content) => await services.artifacts.put(sessionId, content)
  );
  const previous = transitionSnapshot(session);
  try {
    beginNextRun(session, mode, services.runDeadlineMs, harness);
    installRuntimeHarnessContext(session, services.runtime.runtimeEnvironment, harness);
    await services.events.emitBatch(session, [{
      type: "run.started",
      authority: "runtime",
      payload: {
        mode: session.durable.mode,
        ...(session.durable.state.deadlineAt
          ? { deadlineAt: session.durable.state.deadlineAt }
          : {}),
        harness: harnessPayload
      }
    }, {
      type: "harness.compiled",
      authority: "runtime",
      payload: harnessPayload
    }]);
  } catch (error) {
    rollBackTransition(session, previous);
    throw error;
  }
}
