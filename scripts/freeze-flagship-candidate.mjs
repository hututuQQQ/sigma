#!/usr/bin/env node
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseArgs, rootDir } from "./bench-common.mjs";
import { formalAbSha256 } from "./bench-terminal-bench-formal-ab-preregistration.mjs";
import { validateSafetyValidationReport } from "./bench-terminal-bench-formal-ab.mjs";

const execFileAsync = promisify(execFile);
const ALLOWED_FLAGS = new Set(["archive", "inspection", "safety-report", "output"]);

function required(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function options(argv) {
  const flags = parseArgs(argv);
  const unknown = Object.keys(flags).filter((key) => key !== "_" && !ALLOWED_FLAGS.has(key));
  if (unknown.length > 0 || flags._.length > 0) {
    throw new Error(`Unsupported candidate freeze arguments: ${[...unknown, ...flags._].join(", ")}.`);
  }
  return {
    archive: path.resolve(required(flags.archive, "--archive")),
    inspection: path.resolve(required(flags.inspection, "--inspection")),
    safetyReport: path.resolve(required(flags["safety-report"], "--safety-report")),
    output: path.resolve(required(flags.output, "--output"))
  };
}

async function git(args) {
  const result = await execFileAsync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  return String(result.stdout).trim();
}

function assertInspection(inspection) {
  const tokens = inspection?.tokens;
  if (inspection?.subject?.provider !== "openai-codex"
    || inspection.subject.model !== "gpt-5.6-sol"
    || inspection.subject.reasoningEffort !== "max"
    || inspection.subject.modelRole !== "orchestrator"
    || inspection.subject.runMode !== "change"
    || inspection.subject.profileId !== "standard"
    || typeof inspection.compilerVersion !== "string"
    || typeof inspection.digest !== "string" || !/^[a-f0-9]{64}$/u.test(inspection.digest)
    || !inspection.policyPackIds?.includes("sigma.flagship.v1")
    || !tokens || tokens.countMethod !== "gateway.countTokens") {
    throw new Error("Candidate inspection is not the required flagship change-mode build.");
  }
  return inspection;
}

async function writeExclusive(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    await handle.writeFile(content, "utf8");
    await handle.sync();
    return formalAbSha256(content);
  } finally {
    await handle.close();
  }
}

export async function freezeFlagshipCandidate(argv) {
  const input = options(argv);
  const [revision, tree, statusText] = await Promise.all([
    git(["rev-parse", "HEAD"]),
    git(["rev-parse", "HEAD^{tree}"]),
    git(["status", "--porcelain=v1", "--untracked-files=all"])
  ]);
  if (statusText.length > 0) {
    throw new Error("Candidate freezing requires a clean committed source tree.");
  }
  const [archiveBytes, inspectionBytes, safetyBytes, lockBytes, archiveInfo] = await Promise.all([
    readFile(input.archive),
    readFile(input.inspection),
    readFile(input.safetyReport),
    readFile(path.join(rootDir, "pnpm-lock.yaml")),
    stat(input.archive)
  ]);
  const archiveSha256 = formalAbSha256(archiveBytes);
  const inspection = assertInspection(JSON.parse(inspectionBytes.toString("utf8")));
  const safety = validateSafetyValidationReport(
    JSON.parse(safetyBytes.toString("utf8")),
    {
      arms: {
        candidate: {
          source_revision: revision,
          archive_sha256: archiveSha256,
          compiler_digest: inspection.digest
        }
      }
    }
  );
  const manifest = {
    schemaVersion: 1,
    kind: "SigmaFlagshipCandidateFreeze",
    createdAt: new Date().toISOString(),
    source: {
      revision,
      tree,
      clean: true,
      pnpmLockSha256: formalAbSha256(lockBytes)
    },
    subject: {
      provider: inspection.subject.provider,
      model: inspection.subject.model,
      reasoningEffort: inspection.subject.reasoningEffort,
      profile: inspection.subject.profileId,
      runMode: inspection.subject.runMode
    },
    artifact: {
      name: path.basename(input.archive),
      bytes: archiveInfo.size,
      sha256: archiveSha256
    },
    harness: {
      compilerVersion: inspection.compilerVersion,
      digest: inspection.digest,
      inspectionSha256: formalAbSha256(inspectionBytes),
      tokens: inspection.tokens
    },
    safety: { reportSha256: formalAbSha256(safetyBytes) }
  };
  // The safety validator above guarantees that this report is itself bound to
  // the same source, archive, and Harness digest recorded in the manifest.
  void safety;
  return { manifest, sha256: await writeExclusive(input.output, manifest), output: input.output };
}

async function main(argv) {
  const result = await freezeFlagshipCandidate(argv);
  process.stdout.write(`${result.sha256}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
