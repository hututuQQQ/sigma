import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProductReadinessReport,
  writeProductReadinessReport
} from "../scripts/product-readiness-report.mjs";

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fixture(targetWrapper: Record<string, unknown>, providerSmoke?: Record<string, unknown>, targetPlatform = "win32") {
  const rootDir = await mkdir(path.join(os.tmpdir(), `sigma-readiness-${Date.now()}-${Math.random().toString(16).slice(2)}`), { recursive: true });
  const artifactsDir = path.join(rootDir, ".artifacts");
  await writeJson(path.join(rootDir, "package.json"), {
    scripts: {
      "verify:product": "pnpm lint && pnpm test && pnpm smoke:product && pnpm smoke:tui-product && pnpm verify:package:agent-cli:windows:structure && pnpm product:readiness"
    }
  });
  await writeJson(path.join(artifactsDir, "smoke-product", "product-smoke.json"), {
    ok: true,
    sessionId: "product-session",
    outcome: { kind: "completed" },
    sessions: 1,
    doctor: { status: "warning" }
  });
  await writeJson(path.join(artifactsDir, "smoke-tui-product", "tui-smoke.json"), {
    ok: true,
    sessionId: "tui-session",
    checks: {
      alternateScreen: true,
      cursorLifecycle: true,
      rawModeLifecycle: true,
      runCompleted: true,
      resize: true
    }
  });
  await writeJson(path.join(artifactsDir, "agent-cli-package-verify.json"), {
    ok: true,
    archive: path.join(artifactsDir, targetPlatform === "win32" ? "agent-cli-win32-x64.zip" : "agent-cli-linux-x64.tgz"),
    tarball: targetPlatform === "linux" ? path.join(artifactsDir, "agent-cli-linux-x64.tgz") : null,
    zip: targetPlatform === "win32" ? path.join(artifactsDir, "agent-cli-win32-x64.zip") : null,
    targetPlatform,
    targetArch: "x64",
    checks: {
      readme: true,
      wrapper: true,
      metadata: true,
      hostCli: true,
      targetWrapper: targetWrapper.ok === true
    },
    targetWrapper
  });
  if (providerSmoke) {
    await writeJson(path.join(artifactsDir, "smoke-provider", "provider-smoke.json"), providerSmoke);
  }
  return { rootDir, artifactsDir };
}

describe("product readiness report", () => {
  it("marks complete local evidence as internal-ready when wrapper is skipped", async () => {
    const { rootDir, artifactsDir } = await fixture({
      ok: false,
      status: "skipped",
      reason: "WSL distro does not provide glibc"
    });

    const report = await buildProductReadinessReport({ rootDir, artifactsDir });

    expect(report).toMatchObject({
      status: "internal-ready",
      internalReady: true,
      releaseReady: false,
      evidence: {
        productSmoke: { sessionId: "product-session" },
        tuiSmoke: { sessionId: "tui-session" }
      }
    });
    expect(report.releaseNotes[0]).toContain("Windows CLI wrapper is not proven");
    expect(report.releaseNotes[1]).toContain("Live provider smoke is not proven");
    expect(report.checks.every((item) => item.ok)).toBe(true);
    expect(report.releaseChecks.some((item) => item.name === "package:targetPlatform" && item.ok)).toBe(true);
    expect(report.releaseChecks.some((item) => item.name === "providerSmoke:present" && !item.ok)).toBe(true);
  });

  it("marks release-ready when the target wrapper passed", async () => {
    const { rootDir, artifactsDir } = await fixture({
      ok: true,
      status: "passed",
      transport: "wsl"
    }, {
      ok: true,
      status: "passed",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      sessionId: "provider-session",
      checks: {
        doctorApi: true,
        runCompleted: true,
        fileContent: true,
        inspect: true
      }
    });

    const report = await buildProductReadinessReport({ rootDir, artifactsDir });

    expect(report).toMatchObject({
      status: "release-ready",
      internalReady: true,
      releaseReady: true,
      evidence: {
        packageVerify: {
          targetPlatform: "win32"
        }
      }
    });
  });

  it("does not mark a Linux package as this Windows MVP release target", async () => {
    const { rootDir, artifactsDir } = await fixture({
      ok: true,
      status: "passed",
      transport: "native"
    }, {
      ok: true,
      status: "passed",
      provider: "deepseek",
      checks: {
        doctorApi: true,
        runCompleted: true,
        fileContent: true,
        inspect: true
      }
    }, "linux");

    const report = await buildProductReadinessReport({ rootDir, artifactsDir });

    expect(report).toMatchObject({
      status: "internal-ready",
      internalReady: true,
      releaseReady: false
    });
    expect(report.releaseChecks).toContainEqual({
      name: "package:targetPlatform",
      ok: false,
      detail: "linux"
    });
  });

  it("writes JSON and Markdown and can require release readiness", async () => {
    const { rootDir, artifactsDir } = await fixture({
      ok: false,
      status: "skipped",
      reason: "no Linux host"
    });

    await expect(writeProductReadinessReport({
      rootDir,
      artifactsDir,
      requireReleaseReady: true
    })).rejects.toThrow("not release-ready");
    await expect(writeProductReadinessReport({
      rootDir,
      artifactsDir,
      requireProviderSmoke: true
    })).rejects.toThrow("live provider smoke");

    const { jsonPath, markdownPath, report } = await writeProductReadinessReport({ rootDir, artifactsDir });
    expect(report.status).toBe("internal-ready");
    expect(JSON.parse(await readFile(jsonPath, "utf8"))).toMatchObject({ status: "internal-ready" });
    const markdown = await readFile(markdownPath, "utf8");
    expect(markdown).toContain("# Sigma Code Product Readiness");
    expect(markdown).toContain("## Release Checks");
  });
});
