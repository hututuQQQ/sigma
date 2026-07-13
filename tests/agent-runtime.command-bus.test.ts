import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SessionCommandBus,
  activeSessionOwner,
  sendSessionCommand,
  type ExternalSessionCommand
} from "../packages/agent-runtime/src/testing.js";
import { acquireProcessOwnerLease } from "../packages/agent-platform/src/index.js";
import { sessionDirectory } from "../packages/agent-store/src/index.js";

const fixtures: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-runtime-owner-"));
  fixtures.push(root);
  return root;
}

function runtimeOwnerPath(root: string, sessionId: string): string {
  return path.join(sessionDirectory(root, sessionId), "runtime-owner.json");
}

async function writeOwner(root: string, sessionId: string, contents: string, old = false): Promise<string> {
  const file = runtimeOwnerPath(root, sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, "utf8");
  if (old) {
    const timestamp = new Date(Date.now() - 60_000);
    await utimes(file, timestamp, timestamp);
  }
  return file;
}

afterEach(async () => {
  for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("SessionCommandBus runtime ownership", () => {
  it("delivers typed user recovery and budget control commands to the active owner", async () => {
    const root = await fixture();
    const sessionId = "checkpoint-recovery-command";
    const dispatched: ExternalSessionCommand[] = [];
    const bus = new SessionCommandBus(root, async (command) => { dispatched.push(command); }, {
      claimTimeoutMs: 100,
      retryIntervalMs: 5
    });
    await bus.claim(sessionId);
    await sendSessionCommand(root, {
      type: "checkpoint_recovery",
      sessionId,
      checkpointId: "checkpoint-one",
      decision: "restore"
    });
    const firstDeadline = Date.now() + 1_000;
    while (dispatched.length < 1 && Date.now() < firstDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await sendSessionCommand(root, {
      type: "budget_increase",
      sessionId,
      increase: { inputTokens: 2_000, maxDepth: 1 }
    });
    await sendSessionCommand(root, {
      type: "reviewer_waiver",
      sessionId,
      checkpointId: "checkpoint-two",
      reason: "Operator accepted this exact change once."
    });
    const deadline = Date.now() + 1_000;
    while (dispatched.length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(dispatched).toEqual([
      {
        type: "checkpoint_recovery",
        sessionId,
        checkpointId: "checkpoint-one",
        decision: "restore"
      },
      { type: "budget_increase", sessionId, increase: { inputTokens: 2_000, maxDepth: 1 } },
      {
        type: "reviewer_waiver",
        sessionId,
        checkpointId: "checkpoint-two",
        reason: "Operator accepted this exact change once."
      }
    ]);
    await bus.release(sessionId);
  });

  it("keeps ownership until an in-flight dispatch finishes during release", async () => {
    const root = await fixture();
    const sessionId = "release-during-dispatch";
    let entered!: () => void;
    let unblock!: () => void;
    const dispatchEntered = new Promise<void>((resolve) => { entered = resolve; });
    const dispatchGate = new Promise<void>((resolve) => { unblock = resolve; });
    let dispatches = 0;
    const first = new SessionCommandBus(root, async () => {
      dispatches += 1;
      entered();
      await dispatchGate;
    }, { claimTimeoutMs: 100, retryIntervalMs: 5 });
    await first.claim(sessionId);
    await sendSessionCommand(root, { type: "cancel", sessionId, reason: "once" });
    await dispatchEntered;

    let released = false;
    const releasing = first.release(sessionId).then(() => { released = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(released).toBe(false);
    await expect(activeSessionOwner(root, sessionId)).resolves.not.toBeNull();
    const contender = new SessionCommandBus(root, async () => undefined, { claimTimeoutMs: 25, retryIntervalMs: 5 });
    await expect(contender.claim(sessionId)).rejects.toThrow("is active");

    unblock();
    await releasing;
    expect(dispatches).toBe(1);
    await expect(activeSessionOwner(root, sessionId)).resolves.toBeNull();
    await contender.claim(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(dispatches).toBe(1);
    await contender.release(sessionId);
  });

  it.each([
    ["empty", ""],
    ["truncated", '{"pid":'],
    ["malformed", '{"pid":"bad","instanceId":7,"startedAt":null}']
  ])("recovers an old %s runtime owner", async (_kind, contents) => {
    const root = await fixture();
    const sessionId = `recover-${_kind}`;
    const file = await writeOwner(root, sessionId, contents, true);
    const bus = new SessionCommandBus(root, async () => undefined, {
      claimTimeoutMs: 250,
      malformedOwnerStaleMs: 10,
      retryIntervalMs: 5
    });

    await bus.claim(sessionId);
    const owner = JSON.parse(await readFile(file, "utf8")) as { pid: number; instanceId: string; startedAt: string };
    expect(owner.pid).toBe(process.pid);
    expect(owner.instanceId).not.toHaveLength(0);
    expect(Number.isFinite(Date.parse(owner.startedAt))).toBe(true);
    await expect(activeSessionOwner(root, sessionId)).resolves.toEqual(owner);
    await bus.release(sessionId);
    expect(existsSync(file)).toBe(false);
  });

  it("bounds the wait for a fresh malformed runtime owner and reports why it is blocked", async () => {
    const root = await fixture();
    const sessionId = "fresh-malformed";
    await writeOwner(root, sessionId, '{"pid":');
    const bus = new SessionCommandBus(root, async () => undefined, {
      claimTimeoutMs: 40,
      malformedOwnerStaleMs: 60_000,
      retryIntervalMs: 5
    });

    await expect(bus.claim(sessionId))
      .rejects.toThrow(/Timed out waiting for Session 'fresh-malformed' runtime owner.*truncated malformed owner/u);
    await expect(activeSessionOwner(root, sessionId)).resolves.toBeNull();
  });

  it("does not mistake a reused current PID with a different process marker for the owner", async () => {
    const root = await fixture();
    const sessionId = "reused-pid";
    await writeOwner(root, sessionId, JSON.stringify({
      pid: process.pid,
      instanceId: "previous-process",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      processMarker: "node:previous-process"
    }));
    const bus = new SessionCommandBus(root, async () => undefined, { claimTimeoutMs: 250 });

    await bus.claim(sessionId);
    const owner = await activeSessionOwner(root, sessionId);
    expect(owner).toMatchObject({ pid: process.pid });
    expect(owner?.processMarker).not.toBe("node:previous-process");
    await bus.release(sessionId);
  });

  it("retires an old unverified owner even when its PID has been reused by a live process", async () => {
    const root = await fixture();
    const sessionId = "reused-live-pid";
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true });
    try {
      if (!unrelated.pid) throw new Error("Failed to start PID-reuse fixture process.");
      await writeOwner(root, sessionId, JSON.stringify({
        pid: unrelated.pid,
        instanceId: "owner-from-dead-process",
        startedAt: new Date(Date.now() - 60_000).toISOString()
      }), true);
      const bus = new SessionCommandBus(root, async () => undefined, {
        claimTimeoutMs: 500,
        retryIntervalMs: 5
      });

      await bus.claim(sessionId);
      await expect(activeSessionOwner(root, sessionId)).resolves.toMatchObject({ pid: process.pid });
      await bus.release(sessionId);
    } finally {
      unrelated.kill();
    }
  });

  it("serializes stale-owner retirement without deleting a successor lease", async () => {
    const root = await fixture();
    const sessionId = "stale-owner-race";
    const file = await writeOwner(root, sessionId, JSON.stringify({
      pid: process.pid,
      instanceId: "stale-owner",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      processMarker: "node:stale-process-instance"
    }));
    let start!: () => void;
    const starting = new Promise<void>((resolve) => { start = resolve; });
    const observed: string[] = [];
    const contenders = Array.from({ length: 8 }, (_, index) => (async () => {
      await starting;
      const instanceId = `contender-${index}`;
      const lease = await acquireProcessOwnerLease(file, {
        pid: process.pid,
        instanceId,
        startedAt: new Date().toISOString()
      }, {
        label: "stale owner race",
        timeoutMs: 10_000,
        malformedStaleMs: 10,
        retryIntervalMs: 1
      });
      try {
        const first = JSON.parse(await readFile(file, "utf8")) as { instanceId: string };
        expect(first.instanceId).toBe(instanceId);
        await new Promise((resolve) => setTimeout(resolve, 3));
        const second = JSON.parse(await readFile(file, "utf8")) as { instanceId: string };
        expect(second.instanceId).toBe(instanceId);
        observed.push(instanceId);
      } finally {
        await lease.release();
      }
    })());

    start();
    await Promise.all(contenders);
    expect(new Set(observed).size).toBe(contenders.length);
    expect(existsSync(file)).toBe(false);
  });

  it("recovers crashed immutable chooser and ticket entries", async () => {
    const root = await fixture();
    const sessionId = "crashed-owner-ticket";
    const file = runtimeOwnerPath(root, sessionId);
    const queue = `${file}.lease-queue`;
    await mkdir(queue, { recursive: true });
    const crashed = `${JSON.stringify({
      pid: process.pid,
      instanceId: "crashed-contender",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      processMarker: "node:crashed-process-instance"
    })}\n`;
    await writeFile(path.join(queue, "crashed.choosing"), crashed, "utf8");
    await writeFile(path.join(queue, "00000000000000000001-crashed.ticket"), crashed, "utf8");
    await writeFile(file, crashed, "utf8");
    const bus = new SessionCommandBus(root, async () => undefined, {
      claimTimeoutMs: 1_000,
      retryIntervalMs: 1
    });

    await bus.claim(sessionId);
    const entries = await readdir(queue);
    expect(entries).not.toContain("crashed.choosing");
    expect(entries).not.toContain("00000000000000000001-crashed.ticket");
    await bus.release(sessionId);
  });

  it("retries transient ticket deletion and allows a failed owner release to be retried", async () => {
    const root = await fixture();
    const file = await writeOwner(root, "release-retry", JSON.stringify({
      pid: process.pid,
      instanceId: "stale",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      processMarker: "node:stale-release-owner"
    }));
    let ticketFailures = 0;
    let ownerFailure = true;
    const lease = await acquireProcessOwnerLease(file, {
      pid: process.pid,
      instanceId: "replacement",
      startedAt: new Date().toISOString()
    }, {
      label: "release retry",
      timeoutMs: 2_000,
      retryIntervalMs: 1,
      unlinkFile: async (target) => {
        if (target.endsWith(".ticket") && ticketFailures < 2) {
          ticketFailures += 1;
          throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
        }
        if (target === file && ownerFailure && ticketFailures === 2) {
          ownerFailure = false;
          throw Object.assign(new Error("injected owner cleanup failure"), { code: "EIO" });
        }
        await unlink(target);
      }
    });
    expect(ticketFailures).toBe(2);
    await expect(lease.release()).rejects.toThrow("injected owner cleanup failure");
    expect(existsSync(file)).toBe(true);
    await lease.release();
    expect(existsSync(file)).toBe(false);
  });

  it("retains a command-bus lease when release fails so cleanup can be retried", async () => {
    const root = await fixture();
    const bus = new SessionCommandBus(root, async () => undefined);
    const internal = bus as unknown as {
      timers: Map<string, ReturnType<typeof setInterval>>;
      leases: Map<string, { release(): Promise<void> }>;
    };
    let attempts = 0;
    const timer = setInterval(() => undefined, 10_000);
    timer.unref();
    internal.timers.set("retry", timer);
    internal.leases.set("retry", {
      release: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("cleanup failed");
      }
    });

    await expect(bus.release("retry")).rejects.toThrow("cleanup failed");
    expect(internal.leases.has("retry")).toBe(true);
    await bus.release("retry");
    expect(attempts).toBe(2);
    expect(internal.leases.has("retry")).toBe(false);
  });

  it("drops forged approval commands without dispatching them", async () => {
    const root = await fixture();
    const sessionId = "forged-approval";
    const dispatched: unknown[] = [];
    const bus = new SessionCommandBus(root, async (command) => { dispatched.push(command); });
    await bus.claim(sessionId);
    const commands = path.join(sessionDirectory(root, sessionId), "commands");
    await mkdir(commands, { recursive: true });
    await writeFile(path.join(commands, "forged.json"), JSON.stringify({
      type: "approve", sessionId, requestId: "pending-write", decision: "always_allow"
    }), "utf8");

    await (bus as unknown as { poll(session: string): Promise<void> }).poll(sessionId);

    expect(dispatched).toEqual([]);
    expect(await readdir(commands)).toEqual([]);
    await bus.release(sessionId);
  });
});
