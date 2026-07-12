#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, positiveInteger } from "./common.mjs";
import { runEvaluation } from "./runner.mjs";

export async function runAgentEvalCli(argv = process.argv.slice(2), deps = {}) {
  const flags = parseArgs(argv[0] === "--" ? argv.slice(1) : argv);
  const suite = typeof flags.suite === "string" ? flags.suite : "quick";
  const repeat = positiveInteger(flags.repeat, suite === "experience" ? 3 : 1, "--repeat");
  const scenarios = typeof flags.scenario === "string"
    ? flags.scenario.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
  const result = await runEvaluation({
    suite,
    repeat,
    scenarios,
    manifestPath: typeof flags.manifest === "string" ? flags.manifest : undefined,
    runDir: typeof flags["run-dir"] === "string" ? flags["run-dir"] : undefined,
    envPath: typeof flags.env === "string" ? flags.env : undefined,
    subjectKind: typeof flags.subject === "string" ? flags.subject : undefined,
    skipPackage: flags["skip-package"] === true
  }, {
    ...deps,
    onProgress: deps.onProgress ?? ((event) => {
      if (event.type === "attempt.started") {
        process.stdout.write(`RUN ${event.scenarioId} repetition=${event.repetition}\n`);
      } else if (event.type === "attempt.completed") {
        const dimensions = event.attempt.dimensions;
        process.stdout.write(
          `${Object.values(dimensions).every((item) => item.status === "pass") ? "PASS" : "FAIL"} `
          + `${event.attempt.scenarioId} repetition=${event.attempt.repetition} `
          + `correctness=${dimensions.correctness.status} safety=${dimensions.safety.status} `
          + `experience=${dimensions.experience.status} reliability=${dimensions.reliability.status}\n`
        );
      }
    })
  });
  process.stdout.write(`Evaluation run: ${result.runDir}\n`);
  process.stdout.write(`Report: ${result.reportPath}\n`);
  process.stdout.write(`Codex review: ${result.codexReviewPath}\n`);
  return { ...result, exitCode: result.run.status === "stable" ? 0 : 1 };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runAgentEvalCli().then((result) => { process.exitCode = result.exitCode; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
