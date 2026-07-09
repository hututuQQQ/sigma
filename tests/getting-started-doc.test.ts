import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("getting started documentation", () => {
  it("keeps the first-run product guide readable and Windows-release-aware", async () => {
    const text = await readFile(path.join(process.cwd(), "docs", "GETTING_STARTED.md"), "utf8");

    expect(text).toContain("# Sigma Code 快速开始");
    expect(text).toContain("agent init --workspace .");
    expect(text).toContain("agent doctor --workspace . --json --strict");
    expect(text).toContain("Composer：空闲时 `>`，运行中 `queue >`，审批时 `approval >`。");
    expect(text).toContain("pnpm smoke:tui-product");
    expect(text).toContain("pnpm verify:package:agent-cli:windows");
    expect(text).toContain("pnpm product:readiness");
    expect(text).toContain(".artifacts/product-readiness.json");
    expect(text).toContain(".artifacts/agent-cli-win32-x64.zip");
    expect(text).toContain(".\\bin\\agent.cmd version --json");
    expect(text).toContain("pnpm verify:release:windows");
    expect(text).toContain("pnpm smoke:provider -- --provider deepseek");
    expect(text).toContain(".artifacts/smoke-provider/provider-smoke.json");
    expect(text).toContain("alternate screen、cursor/raw mode 生命周期");
    expect(text).toContain("Windows Terminal 下运行解压后的 `.\\bin\\agent.cmd tui`");
    expect(text).toContain("不使用 benchmark task identity、verifier output 或 hidden test 信息");
    expect(text).not.toContain("韫囶偊鈧喎绱戞慨");
    expect(text).not.toContain("娴溠冩惂");
  });
});
