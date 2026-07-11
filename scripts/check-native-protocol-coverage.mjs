#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

const input = process.argv[2] ?? ".artifacts/sigma-exec-branch-coverage.json";
const minimum = Number(process.argv[3] ?? 95);
if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100) {
  throw new Error("Native protocol coverage minimum must be between 0 and 100.");
}

const report = JSON.parse(await readFile(path.resolve(input), "utf8"));
const files = Array.isArray(report?.data)
  ? report.data.flatMap((entry) => Array.isArray(entry?.files) ? entry.files : [])
  : [];
const normalizedSuffix = "/native/sigma-exec/src/protocol.rs";
const protocol = files.find((file) => String(file?.filename ?? "").replaceAll("\\", "/")
  .endsWith(normalizedSuffix));
if (!protocol) throw new Error("Native coverage report does not contain sigma-exec/src/protocol.rs.");

const branches = protocol.summary?.branches;
const lines = protocol.summary?.lines;
if (!branches || Number(branches.count) <= 0) {
  throw new Error("Native protocol branch coverage is absent; run cargo llvm-cov with --branch on the pinned nightly toolchain.");
}
for (const [name, metric] of [["branches", branches], ["lines", lines]]) {
  const percent = Number(metric?.percent);
  if (!Number.isFinite(percent) || percent < minimum) {
    throw new Error(`sigma-exec protocol ${name} coverage ${String(percent)}% is below ${minimum}%.`);
  }
}
process.stdout.write(`${JSON.stringify({
  file: protocol.filename,
  minimum,
  branches: branches.percent,
  lines: lines.percent
})}\n`);
