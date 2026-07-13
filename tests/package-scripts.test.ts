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
      "tui:deepseek": "pnpm build && node scripts/run-tui-deepseek.mjs",
      "eval:agent": "pnpm build && node scripts/eval/agent-eval.mjs",
      "eval:session": "node scripts/eval/session-audit.mjs",
      "eval:compare": "node scripts/eval/compare.mjs"
    });
    expect(packageJson.scripts["bench:deepseek"]).not.toBe(packageJson.scripts["bench:tb:deepseek"]);
    expect(JSON.stringify(packageJson.scripts)).not.toContain("DEEPSEEK_API_KEY");
  });

  it("keeps the product readiness gate complete and benchmark-free", async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));

    expect(packageJson.scripts).toMatchObject({
      "verify:product": "pnpm lint && pnpm test:coverage && pnpm smoke:product && pnpm smoke:tui-product && pnpm verify:package:agent-cli && pnpm product:readiness -- --target-platform linux --target-arch x64",
      "verify:release:linux": "pnpm lint && pnpm test:coverage && pnpm test:coverage:native-protocol && pnpm perf:migration-v2-100k && pnpm smoke:product && pnpm smoke:tui-product && pnpm verify:package:agent-cli:linux && python3 scripts/ci/linux-sandbox-smoke.py --broker .artifacts/agent-cli-linux-x64/bin/sigma-exec --output .artifacts/sandbox-smoke-linux-x64.json && node scripts/ci/lsp-sandbox-smoke.mjs --bundle .artifacts/agent-cli-linux-x64 --broker .artifacts/agent-cli-linux-x64/bin/sigma-exec --target-platform linux --output .artifacts/lsp-sandbox-smoke-linux-x64.json && pnpm smoke:provider -- --provider deepseek && node scripts/product-readiness-report.mjs --target-platform linux --target-arch x64 --require-release-ready --require-provider-smoke",
      "verify:release:windows": "pnpm lint && pnpm test:coverage && pnpm test:coverage:native-protocol && pnpm perf:migration-v2-100k && pnpm smoke:product && pnpm smoke:tui-product && pnpm verify:package:agent-cli:windows && python scripts/ci/windows-sandbox-smoke.py --broker .artifacts/agent-cli-win32-x64/bin/sigma-exec.exe --node .artifacts/agent-cli-win32-x64/bin/node.exe --output .artifacts/sandbox-smoke-win32-x64.json && node scripts/ci/lsp-sandbox-smoke.mjs --bundle .artifacts/agent-cli-win32-x64 --broker .artifacts/agent-cli-win32-x64/bin/sigma-exec.exe --target-platform win32 --output .artifacts/lsp-sandbox-smoke-win32-x64.json && pnpm smoke:provider -- --provider deepseek && node scripts/product-readiness-report.mjs --target-platform win32 --target-arch x64 --require-release-ready --require-provider-smoke",
      "smoke:product": "pnpm build && node --experimental-ffi --disable-warning=ExperimentalWarning scripts/smoke-product.mjs",
      "smoke:tui-product": "pnpm build && node --experimental-ffi --disable-warning=ExperimentalWarning scripts/smoke-tui-product.mjs",
      "smoke:provider": "pnpm build && node scripts/smoke-provider.mjs",
      "verify:containment": "cargo build --locked --manifest-path native/sigma-exec/Cargo.toml && node scripts/verify-containment.mjs",
      "product:readiness": "node scripts/product-readiness-report.mjs",
      "package:agent-cli:linux": "pnpm build && pnpm build:native:sigma-exec && node scripts/package-agent-cli.mjs --target-platform linux --target-arch x64",
      "package:agent-cli:windows": "pnpm build && pnpm build:native:sigma-exec && node scripts/package-agent-cli.mjs --target-platform win32 --target-arch x64",
      "verify:package:agent-cli": "pnpm verify:package:agent-cli:linux",
      "verify:package:agent-cli:linux": "pnpm package:agent-cli:linux && node scripts/verify-agent-cli-package.mjs --target-platform linux --target-arch x64 --require-target-wrapper",
      "verify:package:agent-cli:windows:structure": "pnpm package:agent-cli:windows && node scripts/verify-agent-cli-package.mjs --target-platform win32 --target-arch x64",
      "verify:package:agent-cli:windows": "pnpm package:agent-cli:windows && node scripts/verify-agent-cli-package.mjs --target-platform win32 --target-arch x64 --require-target-wrapper"
    });
    const verifyProduct = packageJson.scripts["verify:product"];
    const verifyReleaseWindows = packageJson.scripts["verify:release:windows"];
    const verifyWindowsStructure = packageJson.scripts["verify:package:agent-cli:windows:structure"];
    const verifyWindowsRelease = packageJson.scripts["verify:package:agent-cli:windows"];

    expect(verifyProduct).toContain("verify:package:agent-cli");
    expect(verifyProduct).not.toContain("bench:");
    expect(verifyProduct).not.toContain("harbor");
    expect(verifyProduct).not.toContain("smoke:provider");
    expect(verifyProduct).not.toContain("--require-target-wrapper");
    expect(verifyWindowsStructure).not.toContain("--require-target-wrapper");
    expect(verifyWindowsRelease).toContain("--require-target-wrapper");
    expect(verifyReleaseWindows).toContain("verify:package:agent-cli:windows");
    expect(verifyReleaseWindows).toContain("windows-sandbox-smoke.py");
    expect(packageJson.scripts["verify:release:linux"]).toContain("linux-sandbox-smoke.py");
    expect(verifyReleaseWindows).toContain("lsp-sandbox-smoke.mjs");
    expect(packageJson.scripts["verify:release:linux"]).toContain("lsp-sandbox-smoke.mjs");
    expect(verifyReleaseWindows).toContain("smoke:provider -- --provider deepseek");
    expect(verifyReleaseWindows).toContain("--require-release-ready");
    expect(verifyReleaseWindows).toContain("--require-provider-smoke");
  });
});
