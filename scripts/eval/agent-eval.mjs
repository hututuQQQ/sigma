#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, positiveInteger } from "./common.mjs";
import { runEvaluation } from "./runner.mjs";

function progressReporter(event) {
  if (event.type === "attempt.started") {
    process.stdout.write(`RUN ${event.scenarioId} repetition=${event.repetition}\n`);
    return;
  }
  if (event.type !== "attempt.completed") return;
  const dimensions = event.attempt.dimensions;
  process.stdout.write(
    `${Object.values(dimensions).every((item) => item.status === "pass") ? "PASS" : "FAIL"} `
    + `${event.attempt.scenarioId} repetition=${event.attempt.repetition} `
    + `correctness=${dimensions.correctness.status} safety=${dimensions.safety.status} `
    + `experience=${dimensions.experience.status} reliability=${dimensions.reliability.status}\n`
  );
}

function evaluationOptions(flags) {
  const repeat = flags.repeat === undefined ? undefined : positiveInteger(flags.repeat, 1, "--repeat");
  return {
    suite: typeof flags.suite === "string" ? flags.suite : "quick",
    ...(repeat === undefined ? {} : { repeat }),
    scenarios: typeof flags.scenario === "string"
      ? flags.scenario.split(",").map((item) => item.trim()).filter(Boolean) : [],
    manifestPath: typeof flags.manifest === "string" ? flags.manifest : undefined,
    runDir: typeof flags["run-dir"] === "string" ? flags["run-dir"] : undefined,
    evalRootDir: typeof flags["eval-root"] === "string" ? flags["eval-root"] : undefined,
    envPath: typeof flags.env === "string" ? flags.env : undefined,
    subjectWorkspace: typeof flags["subject-workspace"] === "string" ? flags["subject-workspace"] : undefined,
    subjectKind: typeof flags.subject === "string" ? flags.subject : "package",
    skipPackage: flags["skip-package"] === true
  };
}

export async function runAgentEvalCli(argv = process.argv.slice(2), deps = {}) {
  const flags = parseArgs(argv[0] === "--" ? argv.slice(1) : argv);
  const result = await runEvaluation(evaluationOptions(flags), {
    ...deps,
    onProgress: deps.onProgress ?? progressReporter
  });
  process.stdout.write(`Evaluation run: ${result.runDir}\n`);
  process.stdout.write(`Report: ${result.reportPath}\n`);
  return { ...result, exitCode: result.run.status === "stable" ? 0 : 1 };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runAgentEvalCli().then((result) => { process.exitCode = result.exitCode; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
