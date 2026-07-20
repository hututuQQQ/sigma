import type { ToolDescriptor, ToolEffect } from "agent-protocol";

const TERMINAL_TOOL_EFFECTS: ReadonlySet<ToolEffect> = new Set([
  "outcome.propose",
  "outcome.report_blocked",
  "outcome.request_input"
]);

export function terminalOnlyToolEffects(effects: readonly ToolEffect[]): boolean {
  return effects.length > 0 && effects.every((effect) => TERMINAL_TOOL_EFFECTS.has(effect));
}

export function terminalOnlyToolDescriptor(
  descriptor: Pick<ToolDescriptor, "possibleEffects" | "maximumEffects">
): boolean {
  return terminalOnlyToolEffects(descriptor.possibleEffects)
    && terminalOnlyToolEffects(descriptor.maximumEffects ?? descriptor.possibleEffects);
}
