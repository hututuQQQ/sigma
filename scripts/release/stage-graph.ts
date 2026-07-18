import { sigmaManifest } from "../lib/sigma-manifest.ts";

export interface ReleaseStage {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly secretEnvironment: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

export type ReleaseGraphName = keyof typeof releaseStageGraphs;

const noSecrets = [] as const;
const providerSecrets = ["DEEPSEEK_API_KEY", "GLM_API_KEY", "ZAI_API_KEY", "BIGMODEL_API_KEY"] as const;
export const releaseSecretEnvironment: readonly string[] = providerSecrets;

function stage(id: string, command: string, ...args: string[]): ReleaseStage {
  return { id, command, args, secretEnvironment: noSecrets, environment: {} };
}

function providerStage(sigmaExecPath: string): ReleaseStage {
  return {
    id: "provider-smoke",
    command: "pnpm",
    args: ["smoke:provider", "--", "--provider", sigmaManifest.evaluation.provider],
    secretEnvironment: providerSecrets,
    environment: { SIGMA_EXEC_PATH: sigmaExecPath }
  };
}

const neutral = [
  stage("lint", "pnpm", "lint"),
  stage("coverage", "pnpm", "test:coverage"),
  stage("product-smoke", "pnpm", "smoke:product"),
  stage("tui-smoke", "pnpm", "smoke:tui-product")
] as const;

const releaseQuality = [
  stage("build", "pnpm", "build"),
  stage("lint", "pnpm", "lint"),
  stage("coverage", "pnpm", "test:coverage"),
  stage("native-coverage", "pnpm", "test:coverage:native-protocol"),
  stage("v5-replay", "pnpm", "perf:replay-v5-100k"),
  stage("product-smoke", "pnpm", "smoke:product"),
  stage("tui-smoke", "pnpm", "smoke:tui-product")
] as const;

const linuxRelease = [
  ...releaseQuality,
  stage("package", "pnpm", "verify:package:agent-cli:linux"),
  stage("sandbox", "python3", "scripts/ci/linux-sandbox-smoke.py", "--broker",
    ".artifacts/agent-cli-linux-x64/bin/sigma-exec", "--output", ".artifacts/sandbox-smoke-linux-x64.json"),
  stage("lsp-sandbox", "node", "scripts/ci/lsp-sandbox-smoke.mjs", "--bundle",
    ".artifacts/agent-cli-linux-x64", "--broker", ".artifacts/agent-cli-linux-x64/bin/sigma-exec",
    "--target-platform", "linux", "--output", ".artifacts/lsp-sandbox-smoke-linux-x64.json"),
  providerStage(".artifacts/agent-cli-linux-x64/bin/sigma-exec"),
  stage("readiness", "node", "scripts/product-readiness-report.mjs", "--target-platform", "linux",
    "--target-arch", "x64", "--require-release-ready", "--require-provider-smoke")
] as const;

const windowsRelease = [
  ...releaseQuality,
  stage("package", "pnpm", "verify:package:agent-cli:windows"),
  stage("sandbox", "python", "scripts/ci/windows-sandbox-smoke.py", "--broker",
    ".artifacts/agent-cli-win32-x64/bin/sigma-exec.exe", "--node",
    ".artifacts/agent-cli-win32-x64/bin/node.exe", "--output", ".artifacts/sandbox-smoke-win32-x64.json"),
  stage("lsp-sandbox", "node", "scripts/ci/lsp-sandbox-smoke.mjs", "--bundle",
    ".artifacts/agent-cli-win32-x64", "--broker", ".artifacts/agent-cli-win32-x64/bin/sigma-exec.exe",
    "--target-platform", "win32", "--output", ".artifacts/lsp-sandbox-smoke-win32-x64.json"),
  providerStage(".artifacts/agent-cli-win32-x64/bin/sigma-exec.exe"),
  stage("readiness", "node", "scripts/product-readiness-report.mjs", "--target-platform", "win32",
    "--target-arch", "x64", "--require-preview-ready", "--require-provider-smoke")
] as const;

export const releaseStageGraphs = Object.freeze({
  product: [...neutral, stage("internal-readiness", "pnpm", "product:readiness", "--", "--internal-only")],
  "release-linux": linuxRelease,
  "release-windows": windowsRelease,
  "package-linux": [
    stage("build", "pnpm", "build"), stage("native-build", "pnpm", "build:native:sigma-exec:linux"),
    stage("package", "node", "scripts/package-agent-cli.mjs", "--target-platform", "linux", "--target-arch", "x64")
  ],
  "package-windows": [
    stage("build", "pnpm", "build"), stage("native-build", "pnpm", "build:native:sigma-exec"),
    stage("package", "node", "scripts/package-agent-cli.mjs", "--target-platform", "win32", "--target-arch", "x64")
  ],
  "verify-package-linux": [
    stage("package", "pnpm", "package:agent-cli:linux"),
    stage("verify", "node", "scripts/verify-agent-cli-package.mjs", "--target-platform", "linux",
      "--target-arch", "x64", "--require-target-wrapper", "--require-linux-compatibility")
  ],
  "verify-package-windows-structure": [
    stage("package", "pnpm", "package:agent-cli:windows"),
    stage("verify", "node", "scripts/verify-agent-cli-package.mjs", "--target-platform", "win32", "--target-arch", "x64")
  ],
  "verify-package-windows": [
    stage("package", "pnpm", "package:agent-cli:windows"),
    stage("verify", "node", "scripts/verify-agent-cli-package.mjs", "--target-platform", "win32",
      "--target-arch", "x64", "--require-target-wrapper")
  ]
});

export function releaseStageGraph(name: string): readonly ReleaseStage[] {
  if (!Object.hasOwn(releaseStageGraphs, name)) throw new Error(`Unknown release stage graph '${name}'.`);
  return releaseStageGraphs[name as ReleaseGraphName];
}
