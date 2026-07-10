import type { ToolExecutor } from "agent-protocol";
import type { EffectToolRegistry } from "./registry.js";

export function registerToolExecutor(registry: EffectToolRegistry, executor: ToolExecutor): EffectToolRegistry {
  for (const descriptor of executor.descriptors()) {
    registry.register({
      descriptor,
      execute: async (request, context) => await executor.execute(request, context)
    });
  }
  return registry;
}
