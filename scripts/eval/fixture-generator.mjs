import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const REPO_SCALE_GENERATOR_V1 = "repo-scale-v1";

const GROUPS = Object.freeze([
  Object.freeze({ directory: "src/typescript", extension: "ts", count: 140, label: "typescript" }),
  Object.freeze({ directory: "src/javascript", extension: "js", count: 100, label: "javascript" }),
  Object.freeze({ directory: "src/python", extension: "py", count: 80, label: "python" }),
  Object.freeze({ directory: "crates/core/src", extension: "rs", count: 60, label: "rust" }),
  Object.freeze({ directory: "tests/typescript", extension: "ts", count: 30, label: "typescript-test" }),
  Object.freeze({ directory: "tests/javascript", extension: "js", count: 30, label: "javascript-test" }),
  Object.freeze({ directory: "vendor", extension: "js", count: 30, label: "vendor" }),
  Object.freeze({ directory: "generated", extension: "ts", count: 30, label: "generated" })
]);

export const REPO_SCALE_PROFILE_V1 = Object.freeze({
  generatedFiles: 500,
  physicalLines: 90_000,
  includedFiles: 440,
  includedPhysicalLines: 79_200,
  sourceFiles: 380,
  sourcePhysicalLines: 68_400,
  testFiles: 60,
  testPhysicalLines: 10_800,
  byLanguage: Object.freeze({ ts: 170, js: 130, py: 80, rs: 60 })
});

function fileName(group, index) {
  if (group.label === "typescript" && index === 0) return "unicode-统计.ts";
  return `${group.label}-${String(index + 1).padStart(3, "0")}.${group.extension}`;
}

function commentPrefix(extension) {
  return extension === "py" ? "#" : "//";
}

function deterministicFile(group, index, lineCount, seed) {
  const prefix = commentPrefix(group.extension);
  const lines = [`${prefix} deterministic repo-scale fixture: seed=${seed} ${group.label}/${index + 1}`];
  for (let line = 2; line <= lineCount; line += 1) {
    lines.push(`${prefix} line ${String(line).padStart(3, "0")} σ-${group.label}-${index + 1}`);
  }
  // Alternate line endings deterministically so the fixture covers both LF
  // and CRLF without relying on the evaluator host.
  const newline = index % 2 === 0 ? "\n" : "\r\n";
  return `${lines.join(newline)}${newline}`;
}

export function assertRepoScaleGeneratorV1(spec, label = "fixture.generator") {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new TypeError(`${label} must be an object`);
  const allowed = new Set(["kind", "seed", "fileCount", "lineCount"]);
  for (const key of Object.keys(spec)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains unknown field ${JSON.stringify(key)}`);
  }
  if (spec.kind !== REPO_SCALE_GENERATOR_V1) throw new TypeError(`${label}.kind must equal ${REPO_SCALE_GENERATOR_V1}`);
  if (!Number.isSafeInteger(spec.seed) || spec.seed < 0) throw new TypeError(`${label}.seed must be a non-negative integer`);
  if (spec.fileCount !== REPO_SCALE_PROFILE_V1.generatedFiles) {
    throw new TypeError(`${label}.fileCount must equal ${REPO_SCALE_PROFILE_V1.generatedFiles}`);
  }
  if (spec.lineCount !== REPO_SCALE_PROFILE_V1.physicalLines) {
    throw new TypeError(`${label}.lineCount must equal ${REPO_SCALE_PROFILE_V1.physicalLines}`);
  }
  return spec;
}

export async function generateRepoScaleFixtureV1(workspace, rawSpec) {
  const spec = assertRepoScaleGeneratorV1(rawSpec);
  const lineCount = spec.lineCount / spec.fileCount;
  if (!Number.isInteger(lineCount)) throw new Error("repo-scale line count must divide evenly across generated files");
  let generated = 0;
  for (const group of GROUPS) {
    const directory = path.join(workspace, ...group.directory.split("/"));
    await mkdir(directory, { recursive: true });
    for (let index = 0; index < group.count; index += 1) {
      const target = path.join(directory, fileName(group, index));
      await writeFile(target, deterministicFile(group, index, lineCount, spec.seed), "utf8");
      generated += 1;
    }
  }
  if (generated !== spec.fileCount) throw new Error(`repo-scale generator produced ${generated} files; expected ${spec.fileCount}`);
  return { ...REPO_SCALE_PROFILE_V1, seed: spec.seed };
}
