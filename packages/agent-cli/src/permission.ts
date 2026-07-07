import { createInterface } from "node:readline/promises";
import { redactSecretText, type PermissionDecider, type PermissionDecision, type PermissionRequest } from "agent-core";

export class InteractivePermissionDecider implements PermissionDecider {
  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream
  ) {}

  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    this.output.write(
      [
        `Tool: ${request.toolName}`,
        `Risk: ${request.risk}`,
        `Summary: ${redactSecretText(request.reason)}`,
        "Allow? [y]es / [n]o / [a]lways for this tool "
      ].join("\n")
    );
    const readline = createInterface({ input: this.input, output: this.output });
    try {
      const answer = (await readline.question("")).trim().toLowerCase();
      if (answer === "a" || answer === "always") return "always_allow";
      if (answer === "y" || answer === "yes") return "allow";
      return "deny";
    } finally {
      readline.close();
    }
  }
}

export function createInteractivePermissionDecider(options: {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream;
}): PermissionDecider | undefined {
  if (!options.stdin.isTTY || !options.stdout.isTTY) return undefined;
  return new InteractivePermissionDecider(options.stdin, options.stderr);
}
