import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { RunCommand } from "agent-protocol";
import { sessionDirectory } from "agent-store";

interface OwnerRecord {
  pid: number;
  instanceId: string;
  startedAt: string;
}

function ownerPath(rootDir: string, sessionId: string): string {
  return path.join(sessionDirectory(rootDir, sessionId), "runtime-owner.json");
}

function commandDirectory(rootDir: string, sessionId: string): string {
  return path.join(sessionDirectory(rootDir, sessionId), "commands");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readOwner(rootDir: string, sessionId: string): Promise<OwnerRecord | null> {
  try {
    const value = JSON.parse(await readFile(ownerPath(rootDir, sessionId), "utf8")) as OwnerRecord;
    return Number.isInteger(value.pid) && typeof value.instanceId === "string" ? value : null;
  } catch {
    return null;
  }
}

export async function activeSessionOwner(rootDir: string, sessionId: string): Promise<OwnerRecord | null> {
  const owner = await readOwner(rootDir, sessionId);
  return owner && processAlive(owner.pid) ? owner : null;
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
  private readonly polling = new Set<string>();

  constructor(private readonly rootDir: string, private readonly dispatch: (command: RunCommand) => Promise<void>) {}

  async claim(sessionId: string): Promise<void> {
    if (this.timers.has(sessionId)) return;
    const directory = sessionDirectory(this.rootDir, sessionId);
    await mkdir(directory, { recursive: true });
    const file = ownerPath(this.rootDir, sessionId);
    const existing = await readOwner(this.rootDir, sessionId);
    if (existing && processAlive(existing.pid)) throw new Error(`Session '${sessionId}' is active in process ${existing.pid}.`);
    if (existing) await unlink(file).catch(() => undefined);
    const handle = await open(file, "wx").catch(async (error: unknown) => {
      const owner = await activeSessionOwner(this.rootDir, sessionId);
      if (owner) throw new Error(`Session '${sessionId}' is active in process ${owner.pid}.`);
      throw error;
    });
    try {
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, instanceId: this.instanceId, startedAt: new Date().toISOString() } satisfies OwnerRecord)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const timer = setInterval(() => { void this.poll(sessionId).catch(() => undefined); }, 100);
    timer.unref();
    this.timers.set(sessionId, timer);
  }

  async release(sessionId: string): Promise<void> {
    const timer = this.timers.get(sessionId);
    if (!timer) return;
    clearInterval(timer);
    this.timers.delete(sessionId);
    const owner = await readOwner(this.rootDir, sessionId);
    if (owner?.instanceId === this.instanceId) await unlink(ownerPath(this.rootDir, sessionId)).catch(() => undefined);
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
