import { afterEach, describe, expect, it, vi } from "vitest";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

function restorePlatform(): void {
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
}

function allowedPolicy(command = "echo hi") {
  return {
    command,
    risk: "read" as const,
    mutatesWorkspace: false,
    usesNetwork: false,
    changesGitState: false,
    executesCode: false,
    action: "allow" as const,
    reason: "test"
  };
}

async function importSandboxWithSpawn(spawnSync: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  vi.doMock("node:child_process", () => ({ spawnSync }));
  return await import("../packages/agent-core/src/sandbox.js");
}

afterEach(() => {
  restorePlatform();
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:fs");
  vi.resetModules();
});

describe("sandbox backend availability", () => {
  it("does not report bubblewrap available when bwrap exists but user namespace probes fail", async () => {
    setPlatform("linux");
    const spawnSync = vi.fn((command: string, args: string[] = []) => {
      if (command === "bwrap" && args[0] === "--version") return { status: 0, error: undefined };
      if (command === "unshare" && args.join(" ") === "-Ur true") return { status: 1, error: undefined };
      if (command === "bwrap" && args.includes("--ro-bind")) return { status: 1, error: undefined };
      return { status: 127, error: undefined };
    });
    const { createDefaultSandboxAdapter } = await importSandboxWithSpawn(spawnSync);

    const availability = await createDefaultSandboxAdapter().checkAvailability?.(
      { mode: "workspace-write", backend: "bubblewrap" },
      process.cwd()
    );

    expect(availability).toMatchObject({ available: false, backend: "bubblewrap" });
    expect(availability?.reason).toContain("Linux user namespaces are unavailable");
    expect(availability?.reason).toContain("Enable unprivileged user namespaces");
  });

  it("reports bubblewrap available when bwrap exists and unshare user namespace probe succeeds", async () => {
    setPlatform("linux");
    const spawnSync = vi.fn((command: string, args: string[] = []) => {
      if (command === "bwrap" && args[0] === "--version") return { status: 0, error: undefined };
      if (command === "unshare" && args.join(" ") === "-Ur true") return { status: 0, error: undefined };
      return { status: 127, error: undefined };
    });
    const { createDefaultSandboxAdapter } = await importSandboxWithSpawn(spawnSync);

    const availability = await createDefaultSandboxAdapter().checkAvailability?.(
      { mode: "workspace-write", backend: "bubblewrap" },
      process.cwd()
    );

    expect(availability).toMatchObject({ available: true, backend: "bubblewrap" });
    expect(spawnSync).not.toHaveBeenCalledWith("bwrap", ["--ro-bind", "/", "/", "true"], expect.anything());
  });

  it("does not report detected macOS seatbelt available while execution is unimplemented", async () => {
    setPlatform("darwin");
    const spawnSync = vi.fn();
    vi.resetModules();
    vi.doMock("node:child_process", () => ({ spawnSync }));
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        existsSync: (target: string) => target === "/usr/bin/sandbox-exec" || actual.existsSync(target)
      };
    });
    const { createDefaultSandboxAdapter } = await import("../packages/agent-core/src/sandbox.js");

    const availability = await createDefaultSandboxAdapter().checkAvailability?.(
      { mode: "workspace-write", backend: "seatbelt" },
      process.cwd()
    );

    expect(availability).toMatchObject({ available: false, backend: "seatbelt" });
    expect(availability?.reason).toContain("command execution is not implemented yet");
  });

  it("fails closed for required auto sandbox on macOS while seatbelt execution is unimplemented", async () => {
    setPlatform("darwin");
    const spawnSync = vi.fn();
    vi.resetModules();
    vi.doMock("node:child_process", () => ({ spawnSync }));
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        existsSync: (target: string) => target === "/usr/bin/sandbox-exec" || actual.existsSync(target)
      };
    });
    const { createDefaultSandboxAdapter } = await import("../packages/agent-core/src/sandbox.js");

    const decision = await createDefaultSandboxAdapter().prepareExec({
      toolName: "bash",
      command: "echo hi",
      cwd: process.cwd(),
      workspacePath: process.cwd(),
      policy: allowedPolicy(),
      sandbox: { mode: "workspace-write", backend: "auto", required: true }
    });

    expect(decision).toMatchObject({ allowed: false });
    expect(decision.reason).toContain("command execution is not implemented yet");
    expect(decision.metadata).toMatchObject({ backendAvailable: false, fallbackAllowed: false, osSandbox: false });
  });

  it("falls back to policy-only with warning for optional auto sandbox on macOS while seatbelt execution is unimplemented", async () => {
    setPlatform("darwin");
    const spawnSync = vi.fn();
    vi.resetModules();
    vi.doMock("node:child_process", () => ({ spawnSync }));
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        existsSync: (target: string) => target === "/usr/bin/sandbox-exec" || actual.existsSync(target)
      };
    });
    const { createDefaultSandboxAdapter } = await import("../packages/agent-core/src/sandbox.js");

    const decision = await createDefaultSandboxAdapter().prepareExec({
      toolName: "bash",
      command: "echo hi",
      cwd: process.cwd(),
      workspacePath: process.cwd(),
      policy: allowedPolicy(),
      sandbox: { mode: "workspace-write", backend: "auto", required: false }
    });

    expect(decision).toMatchObject({ allowed: true, cwd: process.cwd() });
    expect(decision.metadata).toMatchObject({
      backend: "policy-only",
      enforcement: "policy-only",
      backendAvailable: false,
      fallbackAllowed: true,
      fallbackFrom: "seatbelt",
      osSandbox: false
    });
    expect(String(decision.metadata?.warning ?? "")).toContain("policy-only");
    expect(String(decision.metadata?.fallbackReason ?? "")).toContain("command execution is not implemented yet");
  });
});
