import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyShellCommand,
  createPolicyOnlySandboxAdapter,
  evaluateExecPolicy,
  executeBashTool,
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
    expect(result.metadata?.sandbox).toMatchObject({ sandboxMode: "policy_only" });
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
});
