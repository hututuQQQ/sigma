import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  acquireProcessOwnerLease,
  inspectProcessOwner,
  isProcessOwnerActive,
  type ProcessOwnerLease,
  type ProcessOwnerRecord
} from "agent-platform";
import type { RunCommand } from "agent-protocol";
import { sessionDirectory } from "agent-store";

export type OwnerRecord = ProcessOwnerRecord;

export interface SessionCommandBusOptions {
  claimTimeoutMs?: number;
  malformedOwnerStaleMs?: number;
  retryIntervalMs?: number;
}

function ownerPath(rootDir: string, sessionId: string): string {
  return path.join(sessionDirectory(rootDir, sessionId), "runtime-owner.json");
}

function commandDirectory(rootDir: string, sessionId: string): string {
  return path.join(sessionDirectory(rootDir, sessionId), "commands");
}

export async function activeSessionOwner(rootDir: string, sessionId: string): Promise<OwnerRecord | null> {
  const observation = await inspectProcessOwner(ownerPath(rootDir, sessionId));
  return observation.kind === "valid" && isProcessOwnerActive(observation) ? observation.owner : null;
}

export async function sendSessionCommand(rootDir: string, command: RunCommand): Promise<void> {
  if (!await activeSessionOwner(rootDir, command.sessionId)) throw new Error(`Session '${command.sessionId}' has no active runtime owner.`);
  const directory = commandDirectory(rootDir, command.sessionId);
  await mkdir(directory, { recursive: true });
  const id = `${Date.now()}-${randomUUID()}`;
  const temporary = path.join(directory, `${id}.tmp`);
  const target = path.join(directory, `${id}.json`);
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(command)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}

export class SessionCommandBus {
  private readonly instanceId = randomUUID();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly leases = new Map<string, ProcessOwnerLease>();
  private readonly polling = new Set<string>();

  constructor(
    private readonly rootDir: string,
    private readonly dispatch: (command: RunCommand) => Promise<void>,
    private readonly options: SessionCommandBusOptions = {}
  ) {}

  async claim(sessionId: string): Promise<void> {
    if (this.timers.has(sessionId)) return;
    const directory = sessionDirectory(this.rootDir, sessionId);
    await mkdir(directory, { recursive: true });
    const file = ownerPath(this.rootDir, sessionId);
    const lease = await acquireProcessOwnerLease(file, {
      pid: process.pid,
      instanceId: this.instanceId,
      startedAt: new Date().toISOString()
    }, {
      label: `Session '${sessionId}' runtime owner`,
      timeoutMs: this.options.claimTimeoutMs,
      malformedStaleMs: this.options.malformedOwnerStaleMs,
      retryIntervalMs: this.options.retryIntervalMs,
      activeOwner: "reject"
    });
    this.leases.set(sessionId, lease);
    const timer = setInterval(() => { void this.poll(sessionId).catch(() => undefined); }, 100);
    timer.unref();
    this.timers.set(sessionId, timer);
  }

  async release(sessionId: string): Promise<void> {
    const timer = this.timers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(sessionId);
    }
    const lease = this.leases.get(sessionId);
    if (!lease) return;
    await lease.release();
    this.leases.delete(sessionId);
  }

  private async poll(sessionId: string): Promise<void> {
    if (this.polling.has(sessionId) || !this.timers.has(sessionId)) return;
    this.polling.add(sessionId);
    try {
      const directory = commandDirectory(this.rootDir, sessionId);
      await this.restoreInterruptedCommands(directory);
      const files = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
      for (const file of files) {
        const source = path.join(directory, file);
        const processing = `${source}.${this.instanceId}.processing`;
        try { await rename(source, processing); } catch { continue; }
        let dispatched = false;
        try {
          const command = JSON.parse(await readFile(processing, "utf8")) as RunCommand;
          if (command.sessionId !== sessionId) throw new Error("Session command inbox mismatch.");
          await this.dispatch(command);
          dispatched = true;
        } finally {
          if (dispatched) await unlink(processing).catch(() => undefined);
          else await rename(processing, source).catch(() => undefined);
        }
      }
    } finally {
      this.polling.delete(sessionId);
    }
  }

  private async restoreInterruptedCommands(directory: string): Promise<void> {
    const entries = await readdir(directory).catch(() => []);
    for (const name of entries) {
      const marker = name.indexOf(".json.");
      if (marker < 0 || !name.endsWith(".processing")) continue;
      const source = path.join(directory, name);
      const target = path.join(directory, name.slice(0, marker + 5));
      await rename(source, target).catch(() => undefined);
    }
  }
}
