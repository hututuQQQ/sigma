import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderConfigToml } from "agent-config";
import { loadCliConfig, parseArgs } from "../config.js";

interface InitDeps {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export async function runInitCommand(argv: string[], deps: InitDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout.write("agent init [--workspace <path>] [--profile local|team|ci] [--provider deepseek|glm] [--model <name>] [--permission-mode ask|auto|deny] [--force] [--json]\n");
    return 0;
  }
  try {
    const { flags } = parseArgs(argv);
    const config = loadCliConfig(flags);
    const profile = typeof flags.profile === "string" ? flags.profile : "local";
    const permissionMode = flags["permission-mode"] === undefined && profile === "ci" ? "auto" : config.permissionMode;
    const directory = path.join(config.workspace, ".agent");
    const configPath = path.join(directory, "config.toml");
    await mkdir(directory, { recursive: true });
    if (flags.force !== true) {
      const exists = await readFile(configPath, "utf8").then(() => true, () => false);
      if (exists) throw new Error(`${configPath} already exists. Pass --force to overwrite it.`);
    }
    await writeFile(configPath, renderConfigToml({
      provider: config.provider,
      model: config.model,
      workspace: ".",
      permissionMode
    }, `Sigma Code 2.0 workspace configuration (profile: ${profile})`), "utf8");
    if (flags.json === true) stdout.write(`${JSON.stringify({ ok: true, configPath, profile })}\n`);
    else stdout.write(`initialized ${configPath}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
