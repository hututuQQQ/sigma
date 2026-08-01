import type { ExecutionBroker } from "agent-execution";
import { AgentSupervisor, WorkspaceIsolationManager } from "agent-supervisor";
import { createChildAgentFactory } from "./composition-supervision.js";
import type { RuntimeCompositionConfig } from "./configured-runtime.js";
import type { InProcessRuntimeClient } from "./runtime-client.js";

export function createConfiguredSupervisor(
  config: RuntimeCompositionConfig,
  execution: ExecutionBroker,
  runtimeReference: { current?: InProcessRuntimeClient }
): AgentSupervisor {
  return new AgentSupervisor(
    createChildAgentFactory(() => runtimeReference.current as InProcessRuntimeClient),
    config.maxParallelAgents,
    new WorkspaceIsolationManager(undefined, { execution }),
    async (event) => {
      const runtime = runtimeReference.current;
      if (!runtime) throw new Error("Runtime is not ready to record child events.");
      await runtime.recordChildEvent(event.parentId, event.runId, event.type, {
        childId: event.childId,
        payload: event.payload
      });
    }
  );
}
