import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const productRoots = ["packages/agent-core", "packages/agent-cli", "packages/agent-tui"];
const forbidden = [
  /\bHarbor\b/,
  /\bTerminal-Bench\b/,
  /\bBenchmark\b/,
  /\bbenchmark\b/,
  /\bverifier\b/,
  /\breward\b/,
  /\btask[_ -]?id\b/i
];

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }
  await visit(path.join(root, "src"));
  return files;
}

describe("product benchmark boundary", () => {
  it("keeps benchmark-specific terms out of product packages", async () => {
    const files = (await Promise.all(productRoots.map(sourceFiles))).flat();
    const violations: string[] = [];
    for (const file of files) {
      const text = await readFile(path.resolve(file), "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(text)) violations.push(`${file}: ${pattern}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
