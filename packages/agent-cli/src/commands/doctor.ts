import { access } from "node:fs/promises";
import { createModelClient } from "agent-ai";
import { loadCliConfig, parseArgs } from "../config.js";
import { maskSecret } from "../output.js";

function providerKeyStatus(provider: string): string {
  if (provider === "deepseek") {
    return `DEEPSEEK_API_KEY=${maskSecret(process.env.DEEPSEEK_API_KEY)}`;
  }
  return [
    `GLM_API_KEY=${maskSecret(process.env.GLM_API_KEY)}`,
    `ZAI_API_KEY=${maskSecret(process.env.ZAI_API_KEY)}`,
    `BIGMODEL_API_KEY=${maskSecret(process.env.BIGMODEL_API_KEY)}`
  ].join(" ");
}

export async function runDoctorCommand(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = loadCliConfig(flags);
  const lines: string[] = [];
  let exitCode = 0;

  lines.push(`node=${process.version}`);
  lines.push(`provider=${config.provider}`);
  lines.push(`model=${config.model ?? "(provider default)"}`);
  lines.push(providerKeyStatus(config.provider));

  try {
    await access(config.workspace);
    lines.push(`workspace=${config.workspace}`);
  } catch {
    lines.push(`workspace=${config.workspace} (not accessible)`);
    exitCode = 1;
  }

  if (flags["check-api"] === true) {
    try {
      const client = createModelClient(config.provider, { model: config.model });
      const response = await client.complete({
        messages: [
          { role: "system", content: "Reply with ok." },
          { role: "user", content: "ok?" }
        ],
        toolChoice: "none",
        maxTokens: 8,
        temperature: 0
      });
      lines.push(`api=ok (${response.message.content ?? "no content"})`);
    } catch (error) {
      lines.push(`api=failed (${error instanceof Error ? error.message : String(error)})`);
      exitCode = 1;
    }
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  return exitCode;
}
