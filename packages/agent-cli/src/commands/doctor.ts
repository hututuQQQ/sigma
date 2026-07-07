import { access } from "node:fs/promises";
import { createModelClient } from "agent-ai";
import { redactSecrets } from "agent-core";
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

function providerKeyStatusJson(provider: string): Record<string, string> {
  if (provider === "deepseek") {
    return { DEEPSEEK_API_KEY: maskSecret(process.env.DEEPSEEK_API_KEY) };
  }
  return {
    GLM_API_KEY: maskSecret(process.env.GLM_API_KEY),
    ZAI_API_KEY: maskSecret(process.env.ZAI_API_KEY),
    BIGMODEL_API_KEY: maskSecret(process.env.BIGMODEL_API_KEY)
  };
}

export async function runDoctorCommand(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = loadCliConfig(flags);
  const json = flags.json !== undefined;
  const lines: string[] = [];
  let exitCode = 0;
  const report = {
    node: process.version,
    workspace: {
      path: config.workspace,
      accessible: true
    },
    provider: config.provider,
    model: config.model ?? null,
    providerKeys: providerKeyStatusJson(config.provider),
    apiCheck: {
      requested: flags["check-api"] === true,
      status: "skipped" as "skipped" | "ok" | "failed",
      message: null as string | null
    }
  };

  lines.push(`node=${process.version}`);
  lines.push(`provider=${config.provider}`);
  lines.push(`model=${config.model ?? "(provider default)"}`);
  lines.push(providerKeyStatus(config.provider));

  try {
    await access(config.workspace);
    lines.push(`workspace=${config.workspace}`);
  } catch {
    report.workspace.accessible = false;
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
      report.apiCheck.status = "ok";
      report.apiCheck.message = response.message.content ?? "no content";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`api=failed (${message})`);
      report.apiCheck.status = "failed";
      report.apiCheck.message = message;
      exitCode = 1;
    }
  }

  process.stdout.write(json ? `${JSON.stringify(redactSecrets(report))}\n` : `${lines.join("\n")}\n`);
  return exitCode;
}
