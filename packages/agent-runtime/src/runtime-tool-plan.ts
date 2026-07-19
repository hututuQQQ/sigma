import type {
  ModelToolCall,
  ToolCallPlan,
  ToolDescriptor,
  ToolExecutor,
  ToolPreparationContext
} from "agent-protocol";
import { prepareToolCallPlan } from "agent-tools";

export async function prepareRuntimeToolPlan(
  tools: ToolExecutor,
  descriptor: ToolDescriptor,
  call: ModelToolCall,
  context: ToolPreparationContext
): Promise<ToolCallPlan> {
  return tools.prepare
    ? await tools.prepare({ callId: call.id, name: call.name, arguments: call.arguments }, context)
    : await prepareToolCallPlan(descriptor, call.arguments, context);
}
