import { redactSecrets, redactSecretText, type AgentEvent, type AgentRunResult } from "agent-core";

export function printRunResult(
  result: AgentRunResult,
  stdout: NodeJS.WritableStream = process.stdout,
  options: { quiet?: boolean } = {}
): void {
  if (options.quiet) {
    const message = result.finalMessage?.trim();
    stdout.write(message ? `${redactSecretText(message)}\n` : `status=${result.status} finish_reason=${result.finishReason}\n`);
    return;
  }

  const lines = [
    `status=${result.status}`,
    `finish_reason=${result.finishReason}`,
    ...(result.sessionId ? [`session_id=${result.sessionId}`] : []),
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

export function printJsonRunResult(result: AgentRunResult, stdout: NodeJS.WritableStream = process.stdout): void {
  stdout.write(`${JSON.stringify(redactSecrets(result))}\n`);
}

export function writeJsonLine(value: unknown, stdout: NodeJS.WritableStream = process.stdout): void {
  stdout.write(`${JSON.stringify(redactSecrets(value))}\n`);
}

export function writeStreamJsonEvent(event: AgentEvent, stdout: NodeJS.WritableStream = process.stdout): void {
  writeJsonLine({ type: "event", event }, stdout);
}

export function maskSecret(value: string | undefined): string {
  if (!value) return "missing";
  if (value.length <= 8) return "set";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
