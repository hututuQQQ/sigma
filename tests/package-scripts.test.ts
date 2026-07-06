import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("package scripts", () => {
  it("keeps DeepSeek Terminal-Bench scripts valid and key-free", async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));

    expect(packageJson.scripts).toMatchObject({
      "bench:tb:deepseek": "node scripts/bench-terminal-bench.mjs --mode k --provider deepseek --model deepseek-v4-pro",
      "bench:tb:deepseek:k5": "node scripts/bench-terminal-bench.mjs --mode k --provider deepseek --model deepseek-v4-pro --k 5",
      "bench:tb:deepseek:k10": "node scripts/bench-terminal-bench.mjs --mode k --provider deepseek --model deepseek-v4-pro --k 10",
      "bench:tb:deepseek:task": "node scripts/bench-terminal-bench.mjs --mode task --provider deepseek --model deepseek-v4-pro",
      "package:harbor-runtime": "node scripts/package-harbor-runtime.mjs",
      "bench:tb:config:portable": "node scripts/package-harbor-runtime.mjs"
    });
    expect(JSON.stringify(packageJson.scripts)).not.toContain("DEEPSEEK_API_KEY");
  });
});
