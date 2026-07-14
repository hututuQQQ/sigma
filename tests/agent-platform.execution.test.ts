import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BrokerCancelledError,
  type ExecutionRequest,
  type ExecutionResult
} from "../packages/agent-execution/src/index.js";
import {
  ProcessExecutionUnavailableError,
  lockWindowsDirectories,
  lockWindowsPaths,
  normalizeWindowsShellInvocation,
  runProcess,
  shellInvocation,
  type ProcessExecutionPort,
  type ProcessRequest
} from "../packages/agent-platform/src/index.js";

function executionResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    state: "exited",
    exitCode: 0,
    signal: null,
    durationMs: 5,
    stdout: "one\ntwo\nthree\n",
    stderr: "",
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
    outputTruncated: false,
    timedOut: false,
    idleTimedOut: false,
    cancelled: false,
    ...overrides
  };
}

describe("agent-platform execution boundary", () => {
  it("fails closed without an injected execution port", async () => {
    const request = {
      executable: "tool",
      args: [],
      cwd: process.cwd(),
      timeoutMs: 100,
      signal: new AbortController().signal
    } as ProcessRequest;
    await expect(runProcess(request)).rejects.toBeInstanceOf(ProcessExecutionUnavailableError);
  });

  it("maps legacy process requests to a required broker policy", async () => {
    let captured: ExecutionRequest | undefined;
    const execution: ProcessExecutionPort = {
      execute: async (request) => {
        captured = request;
        return executionResult({ idleTimedOut: true });
      }
    };
    const result = await runProcess({
      execution,
      executable: "tool",
      args: ["arg"],
      cwd: process.cwd(),
      env: { SAFE_VALUE: "yes" },
      timeoutMs: 1_000,
      maxStdoutLines: 2,
      signal: new AbortController().signal,
      readRoots: [process.cwd()],
      writeRoots: []
    });
    expect(captured).toMatchObject({
      command: { executable: "tool", args: ["arg"], environment: { overrides: { SAFE_VALUE: "yes" } } },
      policy: { sandbox: "required", network: "none", readRoots: [process.cwd()], writeRoots: [] }
    });
    expect(result).toMatchObject({
      stdout: "one\ntwo\n",
      stdoutLimitReached: true,
      outputTruncated: true,
      timedOut: true
    });
  });

  it("constructs shell invocations without enabling a shell on the broker", () => {
    expect(normalizeWindowsShellInvocation("cmd.exe", ["/d", "/s", "/c", "cd"], "win32"))
      .toEqual({ executable: "cmd.exe", args: ["/d", "/s", "/c", "chcp 65001>nul & cd"] });
    expect(normalizeWindowsShellInvocation("powershell.exe", ["-Command", "Get-Date"], "win32").args[1])
      .toContain("[Console]::OutputEncoding");
    expect(normalizeWindowsShellInvocation("cmd.exe", ["/c", "cd"], "linux"))
      .toEqual({ executable: "cmd.exe", args: ["/c", "cd"] });
    expect(shellInvocation("cmd", "echo ok")).toEqual(process.platform === "win32"
      ? { executable: "cmd.exe", args: ["/d", "/s", "/c", "chcp 65001>nul & echo ok"] }
      : { executable: "cmd.exe", args: ["/d", "/s", "/c", "echo ok"] });
    expect(shellInvocation("bash", "echo ok")).toEqual({ executable: "bash", args: ["-lc", "echo ok"] });
  });

  it("normalizes broker cancellation into the process result contract", async () => {
    const execution: ProcessExecutionPort = {
      execute: async () => { throw new BrokerCancelledError(); }
    };
    await expect(runProcess({
      execution,
      executable: "tool",
      args: [],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      signal: new AbortController().signal
    })).resolves.toMatchObject({
      exitCode: null,
      cancelled: true,
      timedOut: false,
      stdout: "",
      stderr: ""
    });
  });

  it("preserves authenticated sandbox launch failures", async () => {
    const failure = {
      phase: "sandbox_launch" as const,
      code: "sandbox_acl_plan_limit",
      message: "sandbox ACL plan exceeds durable recovery limits"
    };
    const execution: ProcessExecutionPort = {
      execute: async () => executionResult({ exitCode: null, failure })
    };
    await expect(runProcess({
      execution,
      executable: "tool",
      args: [],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      signal: new AbortController().signal
    })).resolves.toMatchObject({ exitCode: null, failure });
  });

  it.skipIf(process.platform !== "win32")(
    "holds Windows directories without delete sharing until the lock is released",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "sigma-windows-directory-lock-"));
      const held = path.join(root, "held");
      const moved = path.join(root, "moved");
      await mkdir(held);
      const lock = await lockWindowsDirectories([held]);
      try {
        await expect(rename(held, moved)).rejects.toMatchObject({
          code: expect.stringMatching(/^(?:EACCES|EBUSY|EPERM)$/u)
        });
      } finally {
        await lock.close();
      }
      await expect(rename(held, moved)).resolves.toBeUndefined();
      await rm(root, { recursive: true, force: true });
    }
  );

  it.skipIf(process.platform !== "win32")(
    "pins Windows files against replacement and writes until release",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "sigma-windows-file-lock-"));
      const held = path.join(root, "script.js");
      const moved = path.join(root, "moved.js");
      await writeFile(held, "console.log('trusted');\n");
      const lock = await lockWindowsPaths([{ path: held, kind: "file" }]);
      try {
        await expect(rename(held, moved)).rejects.toMatchObject({
          code: expect.stringMatching(/^(?:EACCES|EBUSY|EPERM)$/u)
        });
        await expect(writeFile(held, "console.log('replaced');\n")).rejects.toMatchObject({
          code: expect.stringMatching(/^(?:EACCES|EBUSY|EPERM)$/u)
        });
      } finally {
        await lock.close();
      }
      await expect(rename(held, moved)).resolves.toBeUndefined();
      await rm(root, { recursive: true, force: true });
    }
  );

  it.skipIf(process.platform !== "win32")(
    "releases helper-owned directory handles when the locking parent crashes",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "sigma-windows-directory-lock-crash-"));
      const held = path.join(root, "held");
      const moved = path.join(root, "moved");
      await mkdir(held);
      const fixture = path.resolve("tests/fixtures/windows-directory-lock-holder.mjs");
      const environment = { ...process.env };
      delete environment.NODE_OPTIONS;
      const child = spawn(process.execPath, [fixture, held], {
        cwd: path.resolve("."),
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(
            "Windows directory-lock crash fixture did not become ready."
          )), 5_000);
          let output = "";
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            output += chunk;
            if (output !== "ready\n") return;
            clearTimeout(timeout);
            resolve();
          });
          child.once("error", reject);
          child.once("exit", (code) => reject(new Error(
            `Windows directory-lock crash fixture exited before readiness (${code ?? "signal"}).`
          )));
        });
        await expect(rename(held, moved)).rejects.toMatchObject({
          code: expect.stringMatching(/^(?:EACCES|EBUSY|EPERM)$/u)
        });
        child.kill();
        await once(child, "exit");
        let renamed = false;
        for (let attempt = 0; attempt < 100 && !renamed; attempt += 1) {
          renamed = await rename(held, moved).then(() => true, () => false);
          if (!renamed) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(renamed).toBe(true);
      } finally {
        child.kill();
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});
