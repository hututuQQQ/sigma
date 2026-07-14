#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(rootDir, "packages", "agent-cli", "dist", "index.js");
const envPath = path.join(rootDir, ".env");

export function standardRuntimeNodePath(
  workspace = rootDir,
  platform = process.platform,
  architecture = process.arch
) {
  const executable = path.join(
    workspace,
    ".artifacts",
    `agent-cli-${platform}-${architecture}`,
    "bin",
    platform === "win32" ? "node.exe" : "node"
  );
  return existsSync(executable) ? path.resolve(executable) : undefined;
}

function parseEnvLine(line) {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
  if (!match) return null;
  let value = match[2] ?? "";
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { name: match[1], value };
}

async function loadDeepSeekApiKey() {
  if (!existsSync(envPath)) {
    throw new Error(`Missing .env at ${envPath}`);
  }
  const text = (await readFile(envPath, "utf8")).replace(/^\uFEFF/, "");
  for (const rawLine of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(rawLine);
    if (parsed?.name === "DEEPSEEK_API_KEY" && parsed.value.trim().length > 0) {
      return parsed.value.trim();
    }
  }
  throw new Error("Missing DEEPSEEK_API_KEY in .env");
}

function assertBuiltCli() {
  if (!existsSync(cliEntry)) {
    throw new Error(`Built CLI is missing. Run pnpm build first.\nMissing: ${cliEntry}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  assertBuiltCli();
  const apiKey = await loadDeepSeekApiKey();
  const runtimeNodePath = standardRuntimeNodePath();
  const passthrough = argv[0] === "--" ? argv.slice(1) : argv;
  const args = [
    "--experimental-ffi",
    "--disable-warning=ExperimentalWarning",
    cliEntry,
    "tui",
    "--workspace",
    rootDir,
    ...passthrough,
    "--provider",
    "deepseek"
  ];
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: apiKey,
      ...(runtimeNodePath ? { SIGMA_RUNTIME_NODE_PATH: runtimeNodePath } : {})
    },
    stdio: "inherit"
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
  child.on("error", (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
