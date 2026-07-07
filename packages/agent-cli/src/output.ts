import { redactSecretText, type AgentRunResult } from "agent-core";

export function printRunResult(result: AgentRunResult, stdout: NodeJS.WritableStream = process.stdout): void {
  const lines = [
    `status=${result.status}`,
    `finish_reason=${result.finishReason}`,
    `turns=${result.turns}`,
    `tool_calls=${result.toolCalls}`,
    `commands_executed=${result.commandsExecuted}`,
    `input_tokens=${result.usage.inputTokens}`,
    `output_tokens=${result.usage.outputTokens}`
  ];
  if (result.lastError) {
    lines.push(`last_error=${redactSecretText(result.lastError)}`);
  }
  if (result.finalMessage) {
    lines.push("");
    lines.push(redactSecretText(result.finalMessage));
  }
  stdout.write(`${lines.join("\n")}\n`);
}

export function maskSecret(value: string | undefined): string {
  if (!value) return "missing";
  if (value.length <= 8) return "set";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
