import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyShellCommand,
  createDefaultSandboxAdapter,
  createPolicyOnlySandboxAdapter,
  evaluateExecPolicy,
  executeBashTool,
  normalizeSandboxConfig,
  type ToolExecutionContext
} from "../packages/agent-core/src/index.js";

async function context(): Promise<ToolExecutionContext> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sigma-policy-"));
  return {
    workspacePath: dir,
    permissionMode: "ask",
    commandTimeoutSec: 2,
    maxToolOutputChars: 1000,
    runState: { todos: [], nextTodoId: 1, changedFiles: new Set<string>() },
    alwaysAllowTools: new Set<string>()
  };
}

describe("exec policy", () => {
  it("classifies read-only, workspace-changing, code, network, and git-state commands", () => {
    expect(classifyShellCommand("git status --short")).toMatchObject({ risk: "read", mutatesWorkspace: false });
    expect(classifyShellCommand("node script.js")).toMatchObject({ risk: "execute", executesCode: true });
    expect(classifyShellCommand("git reset --hard")).toMatchObject({ changesGitState: true, mutatesWorkspace: true });
    expect(classifyShellCommand("curl https://example.com")).toMatchObject({ risk: "network", usesNetwork: true });
    expect(classifyShellCommand("echo hi > out.txt")).toMatchObject({ mutatesWorkspace: true });
  });

  it("applies explicit allow, prompt, and deny rules before defaults", () => {
    expect(evaluateExecPolicy("git status", { rules: [{ match: "git status", action: "allow" }] })).toMatchObject({
      action: "allow",
      matchedRule: "git status"
    });
    expect(evaluateExecPolicy("node test.js")).toMatchObject({ action: "prompt" });
    expect(evaluateExecPolicy("rm -rf dist", { rules: [{ match: "rm", action: "deny", reason: "no remove" }] })).toMatchObject({
      action: "deny",
      reason: "no remove"
    });
  });

  it("records permission and sandbox decisions for bash commands", async () => {
    const ctx = await context();
    let decisions = 0;
    ctx.permissionDecider = {
      decide: async (request) => {
        decisions += 1;
        expect(request.reason).toContain("executes code");
        return "allow";
      }
    };
    ctx.sandbox = { mode: "policy_only", filesystem: "workspace_write", network: "default" };
    ctx.sandboxAdapter = createPolicyOnlySandboxAdapter();
    const result = await executeBashTool({ command: "node -e \"console.log(42)\"" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.metadata?.execPolicy).toMatchObject({ action: "prompt", executesCode: true });
    expect(result.metadata?.sandbox).toMatchObject({ mode: "workspace-write", backend: "policy-only" });
    expect(decisions).toBe(1);
  });

  it("blocks network-like commands when policy-only sandbox restricts network", async () => {
    const ctx = await context();
    ctx.permissionMode = "yolo";
    ctx.sandbox = { mode: "policy_only", network: "restricted" };
    const result = await executeBashTool({ command: "curl https://example.com" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("network");
  });

  it("normalizes modern sandbox defaults and legacy names", async () => {
    const ctx = await context();
    expect(normalizeSandboxConfig(ctx.workspacePath)).toMatchObject({
      mode: "workspace-write",
      backend: "auto",
      required: false,
      network: { mode: "restricted", allowLocalhost: true },
      filesystem: {
        readRoots: [ctx.workspacePath],
        writeRoots: [ctx.workspacePath]
      }
    });
    expect(normalizeSandboxConfig(ctx.workspacePath, { mode: "policy_only", filesystem: "read_only" })).toMatchObject({
      mode: "read-only",
      backend: "policy-only",
      filesystem: {
        readRoots: [ctx.workspacePath],
        writeRoots: []
      }
    });
  });

  it("warns when an unavailable optional OS backend falls back to policy-only", async () => {
    const ctx = await context();
    ctx.permissionMode = "yolo";
    ctx.sandbox = { mode: "workspace-write", backend: "external", required: false };
    ctx.sandboxAdapter = createDefaultSandboxAdapter();
    const result = await executeBashTool({ command: "echo fallback" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.metadata?.sandbox).toMatchObject({
      enforcement: "policy-only",
      backendAvailable: false,
      fallbackAllowed: true,
      osSandbox: false
    });
    expect(String((result.metadata?.sandbox as Record<string, unknown> | undefined)?.warning ?? "")).toContain("policy-only");
  });

  it("fails closed for explicitly required Windows sandbox backend", async () => {
    const ctx = await context();
    ctx.permissionMode = "yolo";
    ctx.sandbox = { mode: "workspace-write", backend: "windows", required: true };
    ctx.sandboxAdapter = createDefaultSandboxAdapter();
    const result = await executeBashTool({ command: "echo hi" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/Windows native sandbox v1 does not implement WFP network isolation|Windows sandbox backend is only available on Windows/);
  });

  it("enforces Windows native filesystem sandbox when network is default", async () => {
    if (process.platform !== "win32") return;
    const ctx = await context();
    ctx.permissionMode = "yolo";
    ctx.commandTimeoutSec = 10;
    ctx.sandbox = { mode: "workspace-write", backend: "windows", required: true, network: { mode: "default" } };
    ctx.sandboxAdapter = createDefaultSandboxAdapter();
    const escapePath = path.join(path.dirname(ctx.workspacePath), "escape.txt");
    await rm(escapePath, { force: true });
    try {
      const inside = await executeBashTool({ command: "echo ok>inside.txt" }, ctx);
      expect(inside.ok).toBe(true);
      expect(existsSync(path.join(ctx.workspacePath, "inside.txt"))).toBe(true);
      expect(inside.metadata?.sandbox).toMatchObject({ backend: "windows", enforcement: "windows-restricted-token" });

      const escape = await executeBashTool({ command: "echo bad>..\\escape.txt" }, ctx);
      expect(escape.ok).toBe(false);
      expect(existsSync(escapePath)).toBe(false);
    } finally {
      await rm(escapePath, { force: true });
    }
  });

  it("enforces Windows native read-only filesystem sandbox", async () => {
    if (process.platform !== "win32") return;
    const ctx = await context();
    ctx.permissionMode = "yolo";
    ctx.commandTimeoutSec = 10;
    ctx.sandbox = { mode: "read-only", backend: "windows", required: true, network: { mode: "default" } };
    ctx.sandboxAdapter = createDefaultSandboxAdapter();
    const result = await executeBashTool({ command: "echo bad>readonly.txt" }, ctx);
    expect(result.ok).toBe(false);
    expect(existsSync(path.join(ctx.workspacePath, "readonly.txt"))).toBe(false);
  });
});
