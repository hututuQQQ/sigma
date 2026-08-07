#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentEvalCli } from "./agent-eval.mjs";
import { parseArgs } from "./common.mjs";

export const HARNESS_DEVELOPMENT_BINDING = Object.freeze({
  suite: "harness-development",
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "max",
  repeat: 3,
  scenarios: Object.freeze([
    "line-count-readonly",
    "fix-failing-test",
    "ambiguity-one-question",
    "multi-file-change",
    "already-satisfied-noop",
    "tool-failure-recovery",
    "dirty-worktree-preservation",
    "nested-instructions-unicode",
    "large-context-lookup",
    "validation-failure-honesty",
    "repo-aggregate-total"
  ])
});

const ALLOWED_FLAGS = new Set([
  "run-dir", "eval-root", "env", "subject-workspace", "subject", "skip-package"
]);

function assertCallerOptions(argv) {
  const flags = parseArgs(argv[0] === "--" ? argv.slice(1) : argv);
  const unsupported = [
    ...flags._,
    ...Object.keys(flags).filter((key) => key !== "_" && !ALLOWED_FLAGS.has(key))
  ];
  if (unsupported.length > 0) {
    throw new Error(
      `Harness development controls are frozen; unsupported arguments: ${unsupported.join(", ")}.`
    );
  }
}

export async function runHarnessDevelopmentCli(
  argv = process.argv.slice(2),
  deps = {}
) {
  assertCallerOptions(argv);
  const { runAgentEvalCli: injectedRunner, ...evaluationDeps } = deps;
  const binding = HARNESS_DEVELOPMENT_BINDING;
  return await (injectedRunner ?? runAgentEvalCli)([
    ...(argv[0] === "--" ? argv.slice(1) : argv),
    "--suite", binding.suite,
    "--provider", binding.provider,
    "--model", binding.model,
    "--reasoning-effort", binding.reasoningEffort,
    "--repeat", String(binding.repeat),
    "--scenario", binding.scenarios.join(",")
  ], evaluationDeps);
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runHarnessDevelopmentCli().then((result) => {
    process.exitCode = result.exitCode;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
