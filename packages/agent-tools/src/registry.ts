import type {
  RunMode,
  ToolDescriptor,
  ToolEffect,
  ToolExecutionContext,
  ToolExecutor,
  ToolReceipt,
  ToolRequest
} from "agent-protocol";

export interface RegisteredEffectTool {
  descriptor: ToolDescriptor;
  execute(request: ToolRequest, context: ToolExecutionContext): Promise<ToolReceipt>;
}

export function isToolAllowed(descriptor: ToolDescriptor, mode: RunMode): boolean {
  if (descriptor.approval === "deny") return false;
  if (mode === "change") return true;
  const denied: ToolEffect[] = ["filesystem.write", "process.spawn", "destructive"];
  return !descriptor.possibleEffects.some((effect) => denied.includes(effect));
}

export class EffectToolRegistry implements ToolExecutor {
  private readonly tools = new Map<string, RegisteredEffectTool>();

  register(tool: RegisteredEffectTool): void {
    if (this.tools.has(tool.descriptor.name)) throw new Error(`Duplicate tool '${tool.descriptor.name}'.`);
    this.tools.set(tool.descriptor.name, tool);
  }

  descriptors(): readonly ToolDescriptor[] {
    return [...this.tools.values()].map((tool) => tool.descriptor).sort((left, right) => left.name.localeCompare(right.name));
  }

  descriptor(name: string): ToolDescriptor | undefined {
    return this.tools.get(name)?.descriptor;
  }

  async execute(request: ToolRequest, context: ToolExecutionContext): Promise<ToolReceipt> {
    const tool = this.tools.get(request.name);
    if (!tool) throw new Error(`Unknown tool '${request.name}'.`);
    if (context.signal.aborted) throw context.signal.reason ?? new Error("Tool cancelled.");
    return await tool.execute(request, context);
  }
}
