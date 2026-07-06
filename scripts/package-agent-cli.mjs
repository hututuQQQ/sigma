import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDir = path.join(rootDir, ".artifacts");
const bundleName = "agent-cli-linux";
const bundleDir = path.join(artifactsDir, bundleName);
const outputPath = path.join(artifactsDir, `${bundleName}.tgz`);

const packages = ["agent-ai", "agent-core", "agent-cli"];

function assertBuiltPackage(packageName) {
  const distDir = path.join(rootDir, "packages", packageName, "dist");
  if (!existsSync(distDir)) {
    throw new Error(`packages/${packageName}/dist is missing. Run pnpm build first.`);
  }
}

async function copyRuntimePackage(packageName, targetRoot) {
  const sourceRoot = path.join(rootDir, "packages", packageName);
  const targetDir = path.join(targetRoot, packageName);
  await mkdir(targetDir, { recursive: true });
  await cp(path.join(sourceRoot, "dist"), path.join(targetDir, "dist"), { recursive: true });
  await cp(path.join(sourceRoot, "package.json"), path.join(targetDir, "package.json"));
}

function runTar() {
  const result = spawnSync("tar", ["-czf", outputPath, "-C", artifactsDir, bundleName], {
    cwd: rootDir,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    throw new Error("failed to create agent-cli Linux tarball with tar");
  }
}

for (const packageName of packages) {
  assertBuiltPackage(packageName);
}

await rm(bundleDir, { recursive: true, force: true });
await rm(outputPath, { force: true });
await mkdir(path.join(bundleDir, "bin"), { recursive: true });
await mkdir(path.join(bundleDir, "packages"), { recursive: true });
await mkdir(path.join(bundleDir, "node_modules"), { recursive: true });

for (const packageName of packages) {
  await copyRuntimePackage(packageName, path.join(bundleDir, "packages"));
}

await copyRuntimePackage("agent-ai", path.join(bundleDir, "node_modules"));
await copyRuntimePackage("agent-core", path.join(bundleDir, "node_modules"));

await writeFile(
  path.join(bundleDir, "package.json"),
  `${JSON.stringify(
    {
      name: "sigma-agent-cli-linux",
      version: "0.1.0",
      private: true,
      type: "module",
      bin: {
        agent: "./bin/agent"
      }
    },
    null,
    2
  )}\n`,
  "utf8"
);

const agentBin = path.join(bundleDir, "bin", "agent");
await writeFile(
  agentBin,
  `#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/../packages/agent-cli/dist/index.js" "$@"
`,
  "utf8"
);
await chmod(agentBin, 0o755).catch(() => undefined);

await writeFile(
  path.join(bundleDir, "README.md"),
  "Bundled Sigma agent CLI artifact for Linux Harbor task containers. Extract it and run bin/agent.\n",
  "utf8"
);

runTar();
console.log(`Created ${path.relative(rootDir, outputPath)}`);
