import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { AgentMessage } from "agent-ai";
import { createModelClient } from "agent-ai";
import { loadCliConfig, parseArgs } from "../config.js";

export async function runChatCommand(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = loadCliConfig(flags);
  const client = createModelClient(config.provider, { model: config.model });
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const messages: AgentMessage[] = [{ role: "system", content: "You are a concise coding assistant." }];

  try {
    while (true) {
      const input = await rl.question("> ");
      if (input.trim() === "/exit" || input.trim() === "/quit") break;
      messages.push({ role: "user", content: input });
      const response = await client.complete({ messages, toolChoice: "none" });
      messages.push(response.message);
      stdout.write(`${response.message.content ?? ""}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    rl.close();
  }
}
