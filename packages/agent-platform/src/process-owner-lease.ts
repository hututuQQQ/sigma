import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { retryFilesystemOperation, unlinkWithRetry, type UnlinkFile } from "./filesystem-retry.js";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_STALE_MS,
  processMarker,
  processStatus,
  startOwnerHeartbeat
} from "./process-heartbeat.js";
import { legacyOwner, validOwner, type ProcessOwnerRecord } from "./process-owner-record.js";
export type { ProcessOwnerRecord } from "./process-owner-record.js";

export interface ProcessOwnerLeaseOptions {
  label: string;
  timeoutMs?: number;
  malformedStaleMs?: number;
  retryIntervalMs?: number;
  activeOwner?: "wait" | "reject";
  allowLegacyPid?: boolean;
  signal?: AbortSignal;
  unlinkFile?: UnlinkFile;
  heartbeatIntervalMs?: number;
  heartbeatStaleMs?: number;
}

export interface ProcessOwnerLease {
  readonly owner: ProcessOwnerRecord;
  release(): Promise<void>;
}

export type ProcessOwnerObservation =
  | { kind: "missing" }
  | { kind: "malformed"; ageMs: number; detail: string }
  | { kind: "valid"; ageMs: number; owner: ProcessOwnerRecord };

interface OwnerQueueTicket { release(): Promise<void>; }
interface QueueTicketEntry { filePath: string; number: bigint; token: string; }

const UNSUPPORTED_DIRECTORY_SYNC = new Set(["EPERM", "EINVAL", "ENOTSUP", "EISDIR"]);
const TRANSIENT_QUEUE_READ = new Set(["EPERM", "EACCES", "EBUSY"]);
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r").catch(() => null);
  try {
    await handle?.sync().catch((error: unknown) => {
      if (!UNSUPPORTED_DIRECTORY_SYNC.has(String((error as { code?: unknown }).code))) throw error;
    });
  } finally {
    await handle?.close();
  }
}

export async function inspectProcessOwner(
  filePath: string,
  allowLegacyPid = false
): Promise<ProcessOwnerObservation> {
  const info = await retryFilesystemOperation(async () => await stat(filePath), 250).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  });
  if (!info) return { kind: "missing" };
  const source = await retryFilesystemOperation(async () => await readFile(filePath, "utf8"), 250).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  });
  if (source === null) return { kind: "missing" };
  let owner: ProcessOwnerRecord | undefined;
  try { owner = validOwner(JSON.parse(source)); } catch { /* Report malformed content below. */ }
  owner ??= allowLegacyPid ? legacyOwner(source) : undefined;
  const ageMs = Math.max(0, Date.now() - info.mtimeMs);
  if (owner) return { kind: "valid", owner, ageMs };
  const detail = source.trim().length === 0 ? "empty" : source.trimEnd().endsWith("}") ? "invalid" : "truncated";
  return { kind: "malformed", ageMs, detail };
}

export function isProcessOwnerActive(
  observation: ProcessOwnerObservation,
  heartbeatStaleMs = DEFAULT_HEARTBEAT_STALE_MS
): boolean {
  if (observation.kind !== "valid") return false;
  const status = processStatus(observation.owner);
  if (status === "alive") return true;
  if (status === "dead") return false;
  return observation.ageMs < heartbeatStaleMs;
}

async function publishImmutable(filePath: string, contents: string): Promise<boolean> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, filePath);
    await syncDirectory(directory);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function publishOwner(filePath: string, owner: ProcessOwnerRecord): Promise<boolean> {
  return publishImmutable(filePath, `${JSON.stringify(owner)}\n`);
}

async function removeOwner(filePath: string, unlinkFile?: UnlinkFile): Promise<void> {
  await unlinkWithRetry(filePath, undefined, unlinkFile);
  await syncDirectory(path.dirname(filePath));
}

function queueDirectory(filePath: string): string {
  return `${filePath}.lease-queue`;
}

function parseQueueTicket(directory: string, name: string): QueueTicketEntry | undefined {
  const match = /^(\d+)-([0-9a-f-]+)\.ticket$/u.exec(name);
  if (!match?.[1] || !match[2]) return undefined;
  try {
    return { filePath: path.join(directory, name), number: BigInt(match[1]), token: match[2] };
  } catch {
    return undefined;
  }
}

async function queueEntryIsLive(
  filePath: string,
  malformedStaleMs: number,
  heartbeatStaleMs = DEFAULT_HEARTBEAT_STALE_MS
): Promise<boolean> {
  const observation = await inspectProcessOwner(filePath).catch((error: unknown) => {
    // Windows can briefly report a sharing violation between stat/read and an
    // unlink by another contender. Conservatively keep the entry for this
    // election pass; the bounded retry loop will observe its disappearance.
    if (TRANSIENT_QUEUE_READ.has(String((error as { code?: unknown }).code))) return null;
    throw error;
  });
  if (!observation) return true;
  if (observation.kind === "missing") return false;
  const stale = observation.kind === "valid"
    ? !isProcessOwnerActive(observation, heartbeatStaleMs)
    : observation.ageMs >= malformedStaleMs;
  if (!stale) return true;
  // Queue entry paths contain an unrepeatable UUID. Removing this exact path can
  // never delete a successor's ticket, unlike renaming a shared owner path.
  await unlinkWithRetry(filePath);
  return false;
}

async function queueTicketEntries(
  directory: string,
  malformedStaleMs: number,
  heartbeatStaleMs = DEFAULT_HEARTBEAT_STALE_MS
): Promise<{ blocked: boolean; tickets: QueueTicketEntry[] }> {
  const names = await readdir(directory);
  let blocked = false;
  const tickets: QueueTicketEntry[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".ticket"))) {
    const entry = parseQueueTicket(directory, name);
    const filePath = entry?.filePath ?? path.join(directory, name);
    if (!await queueEntryIsLive(filePath, malformedStaleMs, heartbeatStaleMs)) continue;
    if (entry) tickets.push(entry);
    else blocked = true;
  }
  tickets.sort((left, right) => left.number < right.number ? -1
    : left.number > right.number ? 1 : left.token.localeCompare(right.token));
  return { blocked, tickets };
}

async function queueHasChooser(
  directory: string,
  malformedStaleMs: number,
  heartbeatStaleMs = DEFAULT_HEARTBEAT_STALE_MS
): Promise<boolean> {
  const names = await readdir(directory);
  for (const name of names.filter((candidate) => candidate.endsWith(".choosing"))) {
    if (await queueEntryIsLive(path.join(directory, name), malformedStaleMs, heartbeatStaleMs)) return true;
  }
  return false;
}

function queueTimeout(options: ProcessOwnerLeaseOptions, filePath: string, timeoutMs: number): Error {
  return new Error(`Timed out waiting for ${options.label} lease queue '${filePath}' after ${timeoutMs}ms.`);
}

async function waitForQueueTurn(
  directory: string,
  ticketPath: string,
  filePath: string,
  options: ProcessOwnerLeaseOptions,
  deadline: number,
  timeoutMs: number
): Promise<void> {
  while (true) {
    options.signal?.throwIfAborted();
    const malformedStaleMs = options.malformedStaleMs ?? 5_000;
    const heartbeatStaleMs = options.heartbeatStaleMs ?? DEFAULT_HEARTBEAT_STALE_MS;
    const hasChooser = await queueHasChooser(directory, malformedStaleMs, heartbeatStaleMs);
    const snapshot = await queueTicketEntries(directory, malformedStaleMs, heartbeatStaleMs);
    if (!hasChooser && !snapshot.blocked && snapshot.tickets[0]?.filePath === ticketPath) return;
    if (Date.now() >= deadline) throw queueTimeout(options, filePath, timeoutMs);
    const delay = Math.min(options.retryIntervalMs ?? 25, Math.max(1, deadline - Date.now()));
    await waitForRetry(delay, options.signal);
  }
}

async function acquireOwnerQueueTicket(
  filePath: string,
  options: ProcessOwnerLeaseOptions,
  deadline: number,
  timeoutMs: number
): Promise<OwnerQueueTicket> {
  const directory = queueDirectory(filePath);
  await mkdir(directory, { recursive: true });
  const token = randomUUID();
  const queueOwner: ProcessOwnerRecord = {
    pid: process.pid,
    instanceId: token,
    startedAt: new Date().toISOString(),
    processMarker: processMarker(process.pid)
  };
  const choosingPath = path.join(directory, `${token}.choosing`);
  let ticketPath: string | undefined;
  let stopChoosingHeartbeat: (() => Promise<void>) | undefined;
  let stopHeartbeat: (() => Promise<void>) | undefined;
  try {
    if (!await publishOwner(choosingPath, queueOwner)) throw new Error("Owner lease queue token collision.");
    stopChoosingHeartbeat = startOwnerHeartbeat(
      choosingPath, token, options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    );
    const initial = await queueTicketEntries(
      directory,
      options.malformedStaleMs ?? 5_000,
      options.heartbeatStaleMs ?? DEFAULT_HEARTBEAT_STALE_MS
    );
    const nextNumber = (initial.tickets.at(-1)?.number ?? 0n) + 1n;
    ticketPath = path.join(directory, `${nextNumber.toString().padStart(20, "0")}-${token}.ticket`);
    if (!await publishOwner(ticketPath, queueOwner)) throw new Error("Owner lease queue ticket collision.");
    stopHeartbeat = startOwnerHeartbeat(ticketPath, token, options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
    await stopChoosingHeartbeat();
    await unlinkWithRetry(choosingPath, undefined, options.unlinkFile);
    await waitForQueueTurn(directory, ticketPath, filePath, options, deadline, timeoutMs);
  } catch (error) {
    await stopChoosingHeartbeat?.().catch(() => undefined);
    await stopHeartbeat?.().catch(() => undefined);
    await unlinkWithRetry(choosingPath, undefined, options.unlinkFile).catch(() => undefined);
    if (ticketPath) await unlinkWithRetry(ticketPath, undefined, options.unlinkFile).catch(() => undefined);
    throw error;
  }
  let releasePromise: Promise<void> | undefined;
  return {
    release: () => releasePromise ??= (async () => {
      await stopHeartbeat?.();
      await unlinkWithRetry(ticketPath!, undefined, options.unlinkFile);
      await syncDirectory(directory);
    })().catch((error: unknown) => {
      stopHeartbeat = startOwnerHeartbeat(
        ticketPath!, token, options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
      );
      releasePromise = undefined;
      throw error;
    })
  };
}

function observationMessage(observation: ProcessOwnerObservation): string {
  if (observation.kind === "missing") return "owner disappeared while waiting";
  if (observation.kind === "malformed") {
    return `${observation.detail} malformed owner, age=${Math.round(observation.ageMs)}ms`;
  }
  return `owner pid=${observation.owner.pid}, instance=${observation.owner.instanceId}, started=${observation.owner.startedAt}`;
}

function ownerIsStale(
  observation: ProcessOwnerObservation,
  malformedStaleMs: number,
  heartbeatStaleMs = DEFAULT_HEARTBEAT_STALE_MS
): boolean {
  return observation.kind === "valid" ? !isProcessOwnerActive(observation, heartbeatStaleMs)
    : observation.kind === "malformed" && observation.ageMs >= malformedStaleMs;
}

async function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("Owner lease acquisition was cancelled."));
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function ownerLease(
  filePath: string,
  publishedOwner: ProcessOwnerRecord,
  options: ProcessOwnerLeaseOptions
): ProcessOwnerLease {
  let releasePromise: Promise<void> | undefined;
  let stopHeartbeat = startOwnerHeartbeat(
    filePath,
    publishedOwner.instanceId,
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  );
  return {
    owner: publishedOwner,
    release: () => releasePromise ??= (async () => {
      await stopHeartbeat();
      const current = await inspectProcessOwner(filePath, options.allowLegacyPid);
      if (current.kind === "valid" && current.owner.instanceId === publishedOwner.instanceId) {
        await removeOwner(filePath, options.unlinkFile);
      }
    })().catch((error: unknown) => {
      stopHeartbeat = startOwnerHeartbeat(
        filePath,
        publishedOwner.instanceId,
        options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
      );
      releasePromise = undefined;
      throw error;
    })
  };
}

async function replaceStaleOwner(
  filePath: string,
  publishedOwner: ProcessOwnerRecord,
  options: ProcessOwnerLeaseOptions,
  deadline: number,
  timeoutMs: number,
  malformedStaleMs: number
): Promise<{ acquired: boolean; observation: ProcessOwnerObservation }> {
  const ticket = await acquireOwnerQueueTicket(filePath, options, deadline, timeoutMs);
  try {
    const observation = await inspectProcessOwner(filePath, options.allowLegacyPid);
    if (!ownerIsStale(observation, malformedStaleMs, options.heartbeatStaleMs)) return { acquired: false, observation };
    await removeOwner(filePath, options.unlinkFile);
    return { acquired: await publishOwner(filePath, publishedOwner), observation: { kind: "missing" } };
  } finally {
    await ticket.release();
  }
}

export async function acquireProcessOwnerLease(
  filePath: string,
  owner: ProcessOwnerRecord,
  options: ProcessOwnerLeaseOptions
): Promise<ProcessOwnerLease> {
  const publishedOwner = { ...owner, processMarker: processMarker(process.pid) };
  const timeoutMs = options.timeoutMs ?? 30_000;
  const malformedStaleMs = options.malformedStaleMs ?? 5_000;
  const retryIntervalMs = options.retryIntervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let lastObservation: ProcessOwnerObservation;
  while (true) {
    options.signal?.throwIfAborted();
    lastObservation = await inspectProcessOwner(filePath, options.allowLegacyPid);
    if (lastObservation.kind === "missing") {
      if (await publishOwner(filePath, publishedOwner)) {
        return ownerLease(filePath, publishedOwner, options);
      }
      continue;
    }
    if (ownerIsStale(lastObservation, malformedStaleMs, options.heartbeatStaleMs)) {
      const replacement = await replaceStaleOwner(
        filePath, publishedOwner, options, deadline, timeoutMs, malformedStaleMs
      );
      lastObservation = replacement.observation;
      if (replacement.acquired) return ownerLease(filePath, publishedOwner, options);
    }
    if (lastObservation.kind === "valid" && options.activeOwner === "reject") {
      throw new Error(`${options.label} is active (${observationMessage(lastObservation)}).`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${options.label} '${filePath}' after ${timeoutMs}ms (${observationMessage(lastObservation)}).`);
    }
    await waitForRetry(Math.min(retryIntervalMs, Math.max(1, deadline - Date.now())), options.signal);
  }
}
