#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linuxCompatibilityImages } from "../linux-portable-runtime-config.mjs";
import { linuxPackageFakeModelSmokeScript } from "./linux-package-fake-model-smoke.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function dockerMount(source, target, readonly = false) {
  return `type=bind,source=${path.resolve(source)},target=${target}${readonly ? ",readonly" : ""}`;
}

function requireDocker() {
  const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    cwd: rootDir,
    encoding: "utf8"
  });
  if (result.error || result.status !== 0) {
    throw new Error("Docker is required for the Linux package compatibility matrix.");
  }
  return result.stdout.trim();
}

function runImage(image, archivePath) {
  const started = Date.now();
  const command = [
    "set -eu",
    "mkdir -p /opt/sigma /usr/local/bin /sigma-work/workspace /sigma-work/state",
    "chmod 0700 /sigma-work/state",
    "tar -xzf /tmp/agent-cli.tgz -C /opt/sigma --strip-components=1",
    "chmod 0755 /opt/sigma/bin/agent /opt/sigma/bin/node /opt/sigma/bin/sigma-exec /opt/sigma/bin/bwrap",
    "ln -sf /opt/sigma/bin/bwrap /usr/local/bin/bwrap",
    "/opt/sigma/bin/agent --help >/sigma-work/help.txt",
    "/opt/sigma/bin/agent doctor --workspace /sigma-work/workspace --json --strict >/sigma-work/doctor.json",
    "/opt/sigma/bin/agent sandbox setup --json >/sigma-work/sandbox.json",
    `/opt/sigma/bin/node /sigma-tests/ci/${path.basename(linuxPackageFakeModelSmokeScript)}`
  ].join(" && ");
  const result = spawnSync("docker", [
    "run", "--rm", "--cap-add", "SYS_ADMIN", "--security-opt", "seccomp=unconfined",
    "--platform", "linux/amd64",
    "--mount", dockerMount(archivePath, "/tmp/agent-cli.tgz", true),
    "--mount", dockerMount(path.join(rootDir, "scripts"), "/sigma-tests", true),
    "--tmpfs", "/sigma-work:rw,exec",
    "-e", "DEEPSEEK_API_KEY=placeholder",
    "-e", "SIGMA_PACKAGE_ROOT=/opt/sigma",
    "-e", "SIGMA_SMOKE_WORKSPACE=/sigma-work/workspace",
    "-e", "SIGMA_SMOKE_STATE_ROOT=/sigma-work/state",
    image.image, "sh", "-c", command
  ], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  return {
    name: image.name,
    image: image.image,
    passed: !result.error && result.status === 0,
    exitCode: result.status,
    durationMs: Date.now() - started,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? ""
  };
}

async function main() {
  const archivePath = path.resolve(argumentValue(
    "--archive",
    path.join(rootDir, ".artifacts", "agent-cli-linux-x64.tgz")
  ));
  const outputPath = path.resolve(argumentValue(
    "--output",
    path.join(rootDir, ".artifacts", "linux-package-compatibility-matrix.json")
  ));
  const dockerVersion = requireDocker();
  const results = linuxCompatibilityImages.map((image) => runImage(image, archivePath));
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    archivePath,
    dockerVersion,
    support: { platform: "linux-x64", libc: "glibc", minimumGlibc: "2.28", alpine: false },
    passed: results.every((result) => result.passed),
    results
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  for (const result of results) {
    process.stdout.write(`${result.passed ? "PASS" : "FAIL"} ${result.name} (${result.durationMs}ms)\n`);
    if (!result.passed) process.stderr.write(`${result.stderr || result.stdout}\n`);
  }
  if (!report.passed) process.exitCode = 1;
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
