import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../config.js";

interface VersionCommandDeps {
  stdout?: NodeJS.WritableStream;
  buildVersionReport?: () => Promise<VersionReport>;
}

interface PackageJson {
  name?: string;
  version?: string;
}

export interface VersionReport {
  product: "Sigma Code";
  command: "agent";
  package: {
    name: string;
    version: string;
  };
  runtime: {
    node: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  bundle: unknown | null;
}

function stdout(deps: VersionCommandDeps): NodeJS.WritableStream {
  return deps.stdout ?? process.stdout;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

async function packageJson(): Promise<PackageJson> {
  return await readJsonFile<PackageJson>(path.join(packageRoot(), "package.json")) ?? {};
}

async function bundleMetadata(): Promise<unknown | null> {
  return await readJsonFile(path.join(packageRoot(), "..", "..", "package-metadata.json"));
}

export async function buildVersionReport(): Promise<VersionReport> {
  const pkg = await packageJson();
  return {
    product: "Sigma Code",
    command: "agent",
    package: {
      name: pkg.name ?? "agent-cli",
      version: pkg.version ?? "0.0.0"
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    bundle: await bundleMetadata()
  };
}

function bundleValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return String(value);
}

function bundleLabel(bundle: unknown): string {
  if (!bundle || typeof bundle !== "object") return "";

  const metadata = bundle as { targetPlatform?: unknown; targetArch?: unknown };
  const targetArch = bundleValue(metadata.targetArch);
  if (!targetArch) return "";

  const targetPlatform = bundleValue(metadata.targetPlatform);
  return targetPlatform ? ` bundle=${targetPlatform}-${targetArch}` : ` bundle=linux-${targetArch}`;
}

export async function runVersionCommand(argv: string[], deps: VersionCommandDeps = {}): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout(deps).write(`agent version [flags]

Print Sigma Code CLI version and runtime metadata.

Flags:
  --json
`);
    return 0;
  }

  const { flags } = parseArgs(argv);
  const report = deps.buildVersionReport ? await deps.buildVersionReport() : await buildVersionReport();
  if (flags.json) {
    stdout(deps).write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const bundle = bundleLabel(report.bundle);
    stdout(deps).write(
      `${report.product} ${report.package.version} (${report.package.name}) node=${report.runtime.node} platform=${report.runtime.platform}/${report.runtime.arch}${bundle}\n`
    );
  }
  return 0;
}
