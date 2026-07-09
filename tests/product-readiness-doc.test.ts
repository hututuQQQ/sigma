import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("product readiness documentation", () => {
  it("documents the product gate, Windows package smoke, provider smoke, and fairness boundary", async () => {
    const text = await readFile(path.join(process.cwd(), "docs", "PRODUCT_READINESS_CHECKLIST.md"), "utf8");

    expect(text).toContain("pnpm verify:product");
    expect(text).toContain("pnpm smoke:product");
    expect(text).toContain("pnpm smoke:tui-product");
    expect(text).toContain("pnpm verify:package:agent-cli:windows");
    expect(text).toContain("pnpm product:readiness");
    expect(text).toContain("pnpm verify:release:windows");
    expect(text).toContain("pnpm smoke:provider -- --provider deepseek");
    expect(text).toContain(".artifacts/smoke-provider/provider-smoke.json");
    expect(text).toContain(".artifacts/product-readiness.json");
    expect(text).toContain("internalReady: true");
    expect(text).toContain("releaseReady: true");
    expect(text).toContain("targetPlatform: \"win32\"");
    expect(text).toContain("DeepSeek live provider smoke 已通过");
    expect(text).toContain(".artifacts/smoke-product/product-smoke.json");
    expect(text).toContain(".artifacts/smoke-tui-product/tui-smoke.json");
    expect(text).toContain("checks.rawModeLifecycle: true");
    expect(text).toContain("checks.artifactsPanel: true");
    expect(text).toContain(".artifacts/agent-cli-win32-x64.zip");
    expect(text).toContain(".artifacts/agent-cli-package-verify.json");
    expect(text).toContain("artifacts.json");
    expect(text).toContain("checks.hostCli: true");
    expect(text).toContain("checks.targetWrapper");
    expect(text).toContain("targetWrapper.status");
    expect(text).toContain("packages/agent-cli/dist/index.js version --json");
    expect(text).toContain(".\\bin\\agent.cmd version --json");
    expect(text).toContain("pnpm verify:package:agent-cli");
    expect(text).toContain("benchmark identity");
    expect(text).toContain("verifier feedback");
    expect(text).not.toContain("韫囶偊鈧喎绱戞慨");
    expect(text).not.toContain("娴溠冩惂");
  });
});
