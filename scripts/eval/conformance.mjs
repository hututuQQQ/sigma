#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const testFiles = [
  "tests/agent-protocol.failure-taxonomy.test.ts",
  "tests/agent-execution.test.ts",
  "tests/agent-tools.output-artifacts.test.ts",
  "tests/agent-kernel.semantic-failure.test.ts",
  "tests/agent-runtime.subject-attestation.test.ts",
  "tests/agent-eval-schema.test.ts",
  "tests/agent-eval-fixture.test.ts",
  "tests/agent-eval-export-status.test.ts",
  "tests/agent-eval-runner.test.ts",
  "tests/agent-eval-verifier.test.ts",
  "tests/agent-eval-metrics.test.ts",
  "tests/agent-eval-report.test.ts",
  "tests/agent-eval-optimizer.test.ts"
];

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed with ${signal ? `signal ${signal}` : `exit ${code}`}.`));
    });
  });
}

function nodeOptions() {
  const current = process.env.NODE_OPTIONS?.trim();
  return [current, "--experimental-ffi"].filter(Boolean).join(" ");
}

export async function runEvalConformance() {
  await run(process.execPath, ["scripts/eval/fairness-scan.mjs"]);
  await run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...testFiles], {
    ...process.env,
    NODE_OPTIONS: nodeOptions()
  });
  await run("cargo", ["test", "--locked", "--manifest-path", "native/sigma-exec/Cargo.toml"]);
}

runEvalConformance().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
