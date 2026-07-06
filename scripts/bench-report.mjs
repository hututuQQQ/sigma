#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { benchRootDir, generateBenchReport, parseArgs } from "./bench-common.mjs";

export async function runBenchReportCli(argv) {
  const flags = parseArgs(argv);
  if (flags.all) {
    if (!existsSync(benchRootDir)) {
      throw new Error(`Benchmark root directory does not exist: ${benchRootDir}`);
    }
    const entries = await readdir(benchRootDir, { withFileTypes: true });
    const runDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(benchRootDir, entry.name))
      .sort();
    const reports = [];
    for (const runDir of runDirs) {
      reports.push(await generateBenchReport(runDir));
      process.stdout.write(`Report refreshed: ${path.join(runDir, "report.md")}\n`);
    }
    return reports;
  }

  const runId = typeof flags["run-id"] === "string" ? flags["run-id"] : undefined;
  if (!runId) {
    throw new Error("Usage: pnpm bench:tb:report -- --run-id <run-id> | --all");
  }

  const runDir = path.isAbsolute(runId) ? runId : path.join(benchRootDir, runId);
  if (!existsSync(runDir)) {
    throw new Error(`Benchmark run directory does not exist: ${runDir}`);
  }

  const report = await generateBenchReport(runDir);
  process.stdout.write(`Report refreshed: ${path.join(runDir, "report.md")}\n`);
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await runBenchReportCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
