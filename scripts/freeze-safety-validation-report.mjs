#!/usr/bin/env node
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formalAbSha256 } from "./bench-terminal-bench-formal-ab-preregistration.mjs";
import { validateSafetyValidationReport } from "./bench-terminal-bench-formal-ab.mjs";

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function exact(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} has an invalid field set.`);
  }
}

export async function freezeSafetyValidationReport(draft, options = {}) {
  const input = object(draft, "safety validation draft");
  exact(input, [
    "source_revision", "candidate_archive_sha256", "compiler_digest", "checks"
  ], "safety validation draft");
  if (!Array.isArray(input.checks)) throw new Error("safety validation draft checks must be an array.");
  const baseDir = path.resolve(options.baseDir ?? process.cwd());
  const checks = await Promise.all(input.checks.map(async (value, index) => {
    const check = object(value, `checks[${index}]`);
    exact(check, ["id", "command", "exit_code", "evidence_file"], `checks[${index}]`);
    if (check.exit_code !== 0 || typeof check.id !== "string"
      || typeof check.command !== "string" || check.command.trim().length === 0
      || typeof check.evidence_file !== "string" || check.evidence_file.trim().length === 0) {
      throw new Error(`checks[${index}] must have exit_code 0 and concrete command/evidence.`);
    }
    const evidence = await readFile(path.resolve(baseDir, check.evidence_file));
    if (evidence.length === 0) throw new Error(`checks[${index}] evidence is empty.`);
    return {
      id: check.id,
      command: check.command.trim(),
      status: "passed",
      evidence_sha256: formalAbSha256(evidence)
    };
  }));
  const report = {
    schemaVersion: 1,
    kind: "SigmaSafetyValidationReport",
    source_revision: input.source_revision,
    candidate_archive_sha256: input.candidate_archive_sha256,
    compiler_digest: input.compiler_digest,
    checks
  };
  return validateSafetyValidationReport(report, {
    arms: {
      candidate: {
        source_revision: input.source_revision,
        archive_sha256: input.candidate_archive_sha256,
        compiler_digest: input.compiler_digest
      }
    }
  });
}

async function main(argv) {
  const [draftPath, outputPath] = argv;
  if (!draftPath || !outputPath) {
    throw new Error(
      "Usage: node scripts/freeze-safety-validation-report.mjs <draft.json> <output.json>"
    );
  }
  const resolvedDraft = path.resolve(draftPath);
  const report = await freezeSafetyValidationReport(
    JSON.parse(await readFile(resolvedDraft, "utf8")),
    { baseDir: path.dirname(resolvedDraft) }
  );
  const content = `${JSON.stringify(report, null, 2)}\n`;
  const handle = await open(
    path.resolve(outputPath),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  process.stdout.write(`${formalAbSha256(content)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
