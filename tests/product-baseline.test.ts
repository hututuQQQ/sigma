import { readdir, readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runAgentCommand } from "../packages/agent-cli/src/index.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productVersion = "0.1.4";
const sourceExtensions = new Set([".mjs", ".rs", ".ts"]);
const externalVersionedDeclarations = new Set([
  "ACCESS_WRITE_ALLOWED_V1",
  "ACCESS_WRITE_HANDLED_V1",
  "TokenSecurityAttributeV1"
]);
const retiredCompatibilityIdentifiers = [
  "environment_shell",
  "environment_process_spawn",
  "executableSkillResourcesLoaded",
  "modelInputSchema"
];

class MemoryWritable extends Writable {
  readonly chunks: string[] = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(entryPath) : [entryPath];
  }));
  return nested.flat();
}

describe("Sigma Code single baseline", () => {
  it("keeps every product package, crate, manifest, and CLI help at 0.1.4", async () => {
    const manifest = JSON.parse(await readFile(path.join(rootDir, "sigma-manifest.json"), "utf8")) as {
      productVersion?: unknown;
      schemaVersion?: unknown;
    };
    const rootPackage = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8")) as {
      version?: unknown;
    };
    const packageEntries = await readdir(path.join(rootDir, "packages"), { withFileTypes: true });
    const workspaceVersions = await Promise.all(
      packageEntries.filter((entry) => entry.isDirectory()).map(async (entry) => {
        const value = JSON.parse(
          await readFile(path.join(rootDir, "packages", entry.name, "package.json"), "utf8")
        ) as { version?: unknown };
        return [entry.name, value.version] as const;
      })
    );
    const cargoToml = await readFile(path.join(rootDir, "native", "sigma-exec", "Cargo.toml"), "utf8");
    const cargoVersion = cargoToml.match(/^\s*version\s*=\s*"([^"]+)"/mu)?.[1];

    expect(manifest).toMatchObject({ schemaVersion: 1, productVersion });
    expect(rootPackage.version).toBe(productVersion);
    expect(Object.fromEntries(workspaceVersions)).toEqual(
      Object.fromEntries(workspaceVersions.map(([name]) => [name, productVersion]))
    );
    expect(cargoVersion).toBe(productVersion);

    const stdout = new MemoryWritable();
    const previousWrite = process.stdout.write;
    try {
      process.stdout.write = stdout.write.bind(stdout) as typeof process.stdout.write;
      await expect(runAgentCommand([])).resolves.toBe(0);
    } finally {
      process.stdout.write = previousWrite;
    }
    expect(stdout.text()).toContain(`Sigma Code ${productVersion}`);
  });

  it("keeps production names and entry points unversioned", async () => {
    const roots = [
      path.join(rootDir, "packages"),
      path.join(rootDir, "native", "sigma-exec", "src"),
      path.join(rootDir, "scripts")
    ];
    const files = (await Promise.all(roots.map(filesUnder))).flat()
      .filter((file) => sourceExtensions.has(path.extname(file)));
    const violations: string[] = [];
    const declarationPattern =
      /\b(?:export\s+)?(?:class|const|enum|function|interface|struct|type)\s+([A-Za-z_][A-Za-z0-9_]*V[1-9][0-9]*)\b/gu;

    for (const file of files) {
      const relative = path.relative(rootDir, file).replaceAll("\\", "/");
      if (/(?:^|[._-])v[1-9][0-9]*(?:[._-]|$)/iu.test(path.basename(file))) {
        violations.push(`${relative}: versioned filename`);
      }
      const source = await readFile(file, "utf8");
      if (/\bLEGACY_[A-Z0-9_]+\b/u.test(source)) violations.push(`${relative}: LEGACY_ constant`);
      for (const identifier of retiredCompatibilityIdentifiers) {
        if (source.includes(identifier)) {
          violations.push(`${relative}: retired compatibility identifier ${identifier}`);
        }
      }
      if (/\b(?:export\s+)?(?:async\s+)?function\s+migrat[A-Za-z0-9_]*\b/iu.test(source)) {
        violations.push(`${relative}: migration entry point`);
      }
      if (/\bexport\s*\{[^}]*\b[A-Za-z_][A-Za-z0-9_]*V[1-9][0-9]*\b[^}]*\}/su.test(source)) {
        violations.push(`${relative}: version-suffixed re-export`);
      }
      if (/["'](?:agent|sigma)[/_-][^"']*(?:[_-]v[1-9][0-9]*)["']/iu.test(source)) {
        violations.push(`${relative}: versioned Sigma identifier`);
      }
      for (const match of source.matchAll(declarationPattern)) {
        if (!externalVersionedDeclarations.has(match[1]!)) {
          violations.push(`${relative}: ${match[1]}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
