import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("package scripts", () => {
  it("keeps DeepSeek convenience and Terminal-Bench scripts valid and key-free", async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));

    expect(packageJson.scripts).toMatchObject({
      "bench:deepseek": "pnpm bench:tb:deepseek",
      "bench:tb:deepseek": "node scripts/bench-terminal-bench.mjs --mode k --provider deepseek --model deepseek-v4-pro",
      "bench:tb:deepseek:k5": "node scripts/bench-terminal-bench.mjs --mode k --provider deepseek --model deepseek-v4-pro --k 5",
      "bench:tb:deepseek:k10": "node scripts/bench-terminal-bench.mjs --mode k --provider deepseek --model deepseek-v4-pro --k 10",
      "bench:tb:deepseek:task": "node scripts/bench-terminal-bench.mjs --mode task --provider deepseek --model deepseek-v4-pro",
      "package:harbor-runtime": "node scripts/package-harbor-runtime.mjs",
      "bench:tb:config:portable": "node scripts/package-harbor-runtime.mjs",
      "tui:deepseek": "pnpm build && node scripts/run-tui-deepseek.mjs"
    });
    expect(packageJson.scripts["bench:deepseek"]).not.toBe(packageJson.scripts["bench:tb:deepseek"]);
    expect(JSON.stringify(packageJson.scripts)).not.toContain("DEEPSEEK_API_KEY");
  });

  it("keeps the product readiness gate complete and benchmark-free", async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));

    expect(packageJson.scripts).toMatchObject({
      "verify:product": "pnpm lint && pnpm test:coverage && pnpm smoke:product && pnpm smoke:tui-product && pnpm verify:package:agent-cli:windows:structure && pnpm product:readiness",
      "verify:release:windows": "pnpm lint && pnpm test:coverage && pnpm smoke:product && pnpm smoke:tui-product && pnpm verify:package:agent-cli:windows && pnpm smoke:provider -- --provider deepseek && node scripts/product-readiness-report.mjs --require-release-ready --require-provider-smoke",
      "smoke:product": "pnpm build && node scripts/smoke-product.mjs",
      "smoke:tui-product": "pnpm build && node scripts/smoke-tui-product.mjs",
      "smoke:provider": "pnpm build && node scripts/smoke-provider.mjs",
      "product:readiness": "node scripts/product-readiness-report.mjs",
      "package:agent-cli:windows": "pnpm build && node scripts/package-agent-cli.mjs --target-platform win32 --target-arch x64",
      "verify:package:agent-cli": "pnpm package:agent-cli && node scripts/verify-agent-cli-package.mjs",
      "verify:package:agent-cli:windows:structure": "pnpm package:agent-cli:windows && node scripts/verify-agent-cli-package.mjs --target-platform win32 --target-arch x64",
      "verify:package:agent-cli:windows": "pnpm package:agent-cli:windows && node scripts/verify-agent-cli-package.mjs --target-platform win32 --target-arch x64 --require-target-wrapper"
    });
    const verifyProduct = packageJson.scripts["verify:product"];
    const verifyReleaseWindows = packageJson.scripts["verify:release:windows"];
    const verifyWindowsStructure = packageJson.scripts["verify:package:agent-cli:windows:structure"];
    const verifyWindowsRelease = packageJson.scripts["verify:package:agent-cli:windows"];

    expect(verifyProduct).toContain("verify:package:agent-cli:windows:structure");
    expect(verifyProduct).not.toContain("bench:");
    expect(verifyProduct).not.toContain("harbor");
    expect(verifyProduct).not.toContain("smoke:provider");
    expect(verifyProduct).not.toContain("--require-target-wrapper");
    expect(verifyWindowsStructure).not.toContain("--require-target-wrapper");
    expect(verifyWindowsRelease).toContain("--require-target-wrapper");
    expect(verifyReleaseWindows).toContain("verify:package:agent-cli:windows");
    expect(verifyReleaseWindows).toContain("smoke:provider -- --provider deepseek");
    expect(verifyReleaseWindows).toContain("--require-release-ready");
    expect(verifyReleaseWindows).toContain("--require-provider-smoke");
  });
});
