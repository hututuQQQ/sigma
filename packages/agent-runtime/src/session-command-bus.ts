import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
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
export type ExternalSessionCommand = Extract<RunCommand, {
  type: "cancel" | "checkpoint_recovery" | "budget_increase" | "reviewer_waiver";
}>;

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

export async function sendSessionCommand(rootDir: string, command: ExternalSessionCommand): Promise<void> {
  if (!await activeSessionOwner(rootDir, command.sessionId)) throw new Error(`Session '${command.sessionId}' has no active runtime owner.`);
  const directory = commandDirectory(rootDir, command.sessionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = `${Date.now()}-${randomUUID()}`;
  const temporary = path.join(directory, `${id}.tmp`);
  const target = path.join(directory, `${id}.json`);
  const handle = await open(temporary, "wx", 0o600);
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
  private readonly polling = new Map<string, Promise<void>>();
  private readonly dispatchContext = new AsyncLocalStorage<string>();
  private readonly deferredReleases = new Set<string>();

  constructor(
    private readonly rootDir: string,
    private readonly dispatch: (command: ExternalSessionCommand) => Promise<void>,
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
    const polling = this.polling.get(sessionId);
    if (polling && this.dispatchContext.getStore() === sessionId) {
      this.deferredReleases.add(sessionId);
      return;
    }
    await polling;
    await this.releaseLease(sessionId);
  }

  private async releaseLease(sessionId: string): Promise<void> {
    const lease = this.leases.get(sessionId);
    if (!lease) return;
    await lease.release();
    this.leases.delete(sessionId);
  }

  private async poll(sessionId: string): Promise<void> {
    if (this.polling.has(sessionId) || !this.timers.has(sessionId)) return;
    const task = this.pollOwned(sessionId);
    this.polling.set(sessionId, task);
    try {
      await task;
    } finally {
      if (this.polling.get(sessionId) === task) this.polling.delete(sessionId);
      if (this.deferredReleases.delete(sessionId)) await this.releaseLease(sessionId);
    }
  }

  private async pollOwned(sessionId: string): Promise<void> {
    const directory = commandDirectory(this.rootDir, sessionId);
    await this.restoreInterruptedCommands(directory);
    const files = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
    for (const file of files) {
      const source = path.join(directory, file);
      const processing = `${source}.${this.instanceId}.processing`;
      try { await rename(source, processing); } catch { continue; }
      try {
        const command = this.parseExternalCommand(await readFile(processing, "utf8"), sessionId);
        await this.dispatchContext.run(sessionId, async () => await this.dispatch(command));
        await unlink(processing).catch(() => undefined);
      } catch (error) {
        if ((error as { code?: unknown }).code === "invalid_external_command") {
          await unlink(processing).catch(() => undefined);
        } else {
          await rename(processing, source).catch(() => undefined);
        }
      }
    }
  }

  private parseExternalCommand(source: string, sessionId: string): ExternalSessionCommand {
    let value: unknown;
    try { value = JSON.parse(source); } catch { throw this.invalidExternalCommand(); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw this.invalidExternalCommand();
    const command = value as Partial<ExternalSessionCommand> & Record<string, unknown>;
    if (command.sessionId !== sessionId) throw this.invalidExternalCommand();
    if (command.type === "cancel") return this.parseCancellation(command, sessionId);
    if (command.type === "budget_increase") return this.parseBudgetIncrease(command, sessionId);
    if (command.type === "checkpoint_recovery") return this.parseCheckpointRecovery(command, sessionId);
    if (command.type === "reviewer_waiver") return this.parseReviewerWaiver(command, sessionId);
    throw this.invalidExternalCommand();
  }

  private parseCancellation(command: Record<string, unknown>, sessionId: string): ExternalSessionCommand {
    if (command.reason !== undefined && typeof command.reason !== "string") throw this.invalidExternalCommand();
    return { type: "cancel", sessionId, ...(typeof command.reason === "string" ? { reason: command.reason } : {}) };
  }

  private parseBudgetIncrease(command: Record<string, unknown>, sessionId: string): ExternalSessionCommand {
    const increase = command.increase;
    if (!increase || typeof increase !== "object" || Array.isArray(increase)) throw this.invalidExternalCommand();
    const allowed = new Set(["inputTokens", "outputTokens", "costMicroUsd", "modelTurns", "toolCalls", "children", "maxDepth"]);
    const entries = Object.entries(increase);
    if (entries.length === 0 || entries.some(([key, value]) =>
      !allowed.has(key) || !Number.isSafeInteger(value) || Number(value) < 0)
      || !entries.some(([, value]) => Number(value) > 0)) throw this.invalidExternalCommand();
    return { type: "budget_increase", sessionId, increase: { ...increase } };
  }

  private parseCheckpointRecovery(command: Record<string, unknown>, sessionId: string): ExternalSessionCommand {
    if (typeof command.checkpointId !== "string" || !command.checkpointId
      || (command.decision !== "restore" && command.decision !== "keep")) throw this.invalidExternalCommand();
    return { type: "checkpoint_recovery", sessionId, checkpointId: command.checkpointId, decision: command.decision };
  }

  private parseReviewerWaiver(command: Record<string, unknown>, sessionId: string): ExternalSessionCommand {
    if (typeof command.reason !== "string" || !command.reason.trim() || command.reason.trim().length > 2_000
      || (command.checkpointId !== undefined
        && (typeof command.checkpointId !== "string" || !command.checkpointId.trim()))) throw this.invalidExternalCommand();
    return {
      type: "reviewer_waiver",
      sessionId,
      reason: command.reason,
      ...(typeof command.checkpointId === "string" ? { checkpointId: command.checkpointId } : {})
    };
  }

  private invalidExternalCommand(): Error {
    return Object.assign(new Error("The external session inbox accepts cancellation, budget increases, reviewer waivers, and user checkpoint recovery only."), {
      code: "invalid_external_command"
    });
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
