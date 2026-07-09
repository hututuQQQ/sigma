import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("productization TUI plan documentation", () => {
  it("keeps the Chinese productization plan readable and aligned with the Windows MVP implementation", async () => {
    const text = await readFile(path.join(process.cwd(), "docs", "PRODUCTIZATION_TUI_PLAN.md"), "utf8");

    expect(text).toContain("# Sigma Code 产品化与 TUI 方案");
    expect(text).toContain("本地优先、可私有部署、带验证闭环");
    expect(text).toContain("Pi Agent/Harness/TUI");
    expect(text).toContain("CodeWhale runtime/tool/subagent/profile");
    expect(text).toContain("一个工作台，而不是原始事件日志");
    expect(text).toContain("TUI Phase 2 run-state 基线");
    expect(text).toContain("pnpm smoke:tui-product");
    expect(text).toContain("pnpm verify:package:agent-cli:windows");
    expect(text).toContain(".artifacts/agent-cli-win32-x64.zip");
    expect(text).toContain("pnpm product:readiness");
    expect(text).toContain("pnpm smoke:provider");
    expect(text).toContain("internalReady");
    expect(text).toContain("releaseReady");
    expect(text).toContain("live-provider 稳定性证据");
    expect(text).toContain("Windows Public MVP");
    expect(text).toContain("benchmark identity");
    expect(text).not.toContain("娴溠冩惂");
  });
});
