import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function productRoots(): Promise<string[]> {
  const entries = await readdir("packages", { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join("packages", entry.name));
}
const allowedProductExceptions = new Set([path.normalize("packages/agent-protocol/src/events.ts")]);
const forbidden = [/\bHarbor\b/, /\bTerminal-Bench\b/, /\bBenchmark\b/, /\bbenchmark\b/, /\bverifier\b/, /\breward\b/, /\btask[_ -]?id\b/i];

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) files.push(fullPath);
    }
  }
  await visit(path.join(root, "src"));
  return files;
}

describe("product evaluation boundary", () => {
  it("keeps evaluation-specific control flow out of every production package", async () => {
    const files = (await Promise.all((await productRoots()).map(sourceFiles))).flat();
    const violations: string[] = [];
    for (const file of files) {
      if (allowedProductExceptions.has(path.normalize(file))) continue;
      const text = await readFile(path.resolve(file), "utf8");
      for (const pattern of forbidden) if (pattern.test(text)) violations.push(`${file}: ${pattern}`);
    }
    expect(violations).toEqual([]);
  });

  it("ships no legacy solver packages", async () => {
    await expect(access(path.resolve("packages/agent-core"))).rejects.toThrow();
    await expect(access(path.resolve("packages/agent-ai"))).rejects.toThrow();
  });
});
