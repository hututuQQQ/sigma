#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

function bashExecutable() {
  if (process.env.AGENT_BASH_PATH) return process.env.AGENT_BASH_PATH;
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      "C:\\msys64\\usr\\bin\\bash.exe"
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found) return found;
  }
  return "bash";
}

const [script, ...args] = process.argv.slice(2);
if (!script) {
  process.stderr.write("Usage: node scripts/run-bash.mjs <script> [args...]\n");
  process.exit(2);
}

const child = spawn(bashExecutable(), [path.resolve(script), ...args], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  windowsHide: true
});

child.on("error", (error) => {
  process.stderr.write(`Failed to start bash: ${error.message}\n`);
  process.exitCode = 1;
});

child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
