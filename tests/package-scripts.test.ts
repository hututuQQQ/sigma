import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { releaseStageGraph } from "../scripts/release/stage-graph.ts";
import { releaseStageEnvironment } from "../scripts/release/run-stage-graph.ts";

interface RootPackage { scripts: Record<string, string>; }

async function rootPackage(): Promise<RootPackage> {
  return JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as RootPackage;
}

function stageIds(graph: string): string[] {
  return releaseStageGraph(graph).map((stage) => stage.id);
}

describe("package script semantics", () => {
  it("keeps convenience entry points key-free and delegates to shared runners", async () => {
    const { scripts } = await rootPackage();
    expect(scripts["bench:deepseek"]).toBe("pnpm bench:tb:deepseek");
    for (const name of ["bench:tb:deepseek", "bench:tb:deepseek:k5", "bench:tb:deepseek:k10", "bench:tb:deepseek:task"]) {
      expect(scripts[name]).toContain("scripts/bench-terminal-bench.mjs");
    }
    expect(scripts["package:harbor-runtime"]).toBe(scripts["bench:tb:config:portable"]);
    expect(scripts["eval:agent"]).toContain("scripts/eval/agent-eval.mjs");
    expect(scripts["eval:report"]).toBe("node scripts/eval/report.mjs");
    expect(JSON.stringify(scripts)).not.toContain("DEEPSEEK_API_KEY=");
  });

  it("keeps product verification platform-neutral", async () => {
    const { scripts } = await rootPackage();
    expect(scripts["verify:product"]).toBe("node scripts/release/run-stage-graph.ts product");
    const product = releaseStageGraph("product");
    expect(product.map((stage) => [stage.command, ...stage.args].join(" "))).toEqual([
      "pnpm lint", "pnpm test:coverage", "pnpm smoke:product", "pnpm smoke:tui-product",
      "pnpm product:readiness -- --internal-only"
    ]);
    expect(scripts).not.toHaveProperty("verify:package:agent-cli");
    expect(JSON.stringify(product)).not.toMatch(/package:agent-cli|sandbox-smoke|smoke:provider|bench:|harbor/u);
  });

  it("keeps target release stages explicit, ordered, and isolated from secrets", async () => {
    expect(stageIds("release-linux")).toEqual([
      "lint", "coverage", "native-coverage", "v4-replay", "product-smoke", "tui-smoke",
      "package", "sandbox", "lsp-sandbox", "provider-smoke", "readiness"
    ]);
    expect(stageIds("release-windows")).toEqual(stageIds("release-linux"));
    const linux = releaseStageGraph("release-linux");
    const windows = releaseStageGraph("release-windows");
    expect(linux.find((stage) => stage.id === "package")?.args).toContain("verify:package:agent-cli:linux");
    expect(windows.find((stage) => stage.id === "package")?.args).toContain("verify:package:agent-cli:windows");
    expect(linux.find((stage) => stage.id === "readiness")?.args).toContain("--require-release-ready");
    expect(linux.find((stage) => stage.id === "readiness")?.args).not.toContain("--require-preview-ready");
    expect(windows.find((stage) => stage.id === "readiness")?.args).toContain("--require-preview-ready");
    expect(windows.find((stage) => stage.id === "readiness")?.args).not.toContain("--require-release-ready");
    expect(releaseStageGraph("verify-package-linux").at(-1)?.args).toContain("--require-target-wrapper");
    expect(releaseStageGraph("verify-package-windows").at(-1)?.args).toContain("--require-target-wrapper");
    expect(releaseStageGraph("verify-package-windows-structure").at(-1)?.args)
      .not.toContain("--require-target-wrapper");
    for (const stage of [...linux, ...windows]) {
      if (stage.id === "provider-smoke") expect(stage.secretEnvironment.length).toBeGreaterThan(0);
      else expect(stage.secretEnvironment).toEqual([]);
    }
    const source = {
      PATH: "safe",
      DEEPSEEK_API_KEY: "deepseek-secret",
      GLM_API_KEY: "glm-secret",
    };
    expect(releaseStageEnvironment(linux[0], source)).toEqual({ PATH: "safe" });
    expect(releaseStageEnvironment(
      linux.find((stage) => stage.id === "provider-smoke")!, source,
    )).toEqual(source);
  });
});
