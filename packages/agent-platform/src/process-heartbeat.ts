import { readFileSync } from "node:fs";
import { readFile, utimes } from "node:fs/promises";
import { performance } from "node:perf_hooks";

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 1_000;
export const DEFAULT_HEARTBEAT_STALE_MS = 5_000;
const NODE_PROCESS_MARKER = `node:${performance.timeOrigin}`;

function linuxProcessMarker(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const source = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = source.slice(source.lastIndexOf(")") + 1).trim().split(/\s+/u);
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return fields[19] ? `linux:${bootId}:${fields[19]}` : undefined;
  } catch {
    return undefined;
  }
}

export function processMarker(pid: number): string | undefined {
  return linuxProcessMarker(pid) ?? (pid === process.pid ? NODE_PROCESS_MARKER : undefined);
}

export function processStatus(owner: { pid: number; processMarker?: string }): "alive" | "dead" | "unknown" {
  try {
    process.kill(owner.pid, 0);
    const actualMarker = processMarker(owner.pid);
    if (!owner.processMarker || !actualMarker) return "unknown";
    return owner.processMarker === actualMarker ? "alive" : "dead";
  } catch (error) {
    return (error as { code?: unknown }).code === "ESRCH" ? "dead" : "unknown";
  }
}

export function startOwnerHeartbeat(filePath: string, instanceId: string, intervalMs: number): () => Promise<void> {
  let stopped = false;
  let pending = Promise.resolve();
  const beat = async (): Promise<void> => {
    const source = await readFile(filePath, "utf8").catch(() => "");
    try {
      const value = JSON.parse(source) as { instanceId?: unknown };
      if (value.instanceId !== instanceId) return;
      const now = new Date();
      await utimes(filePath, now, now).catch(() => undefined);
    } catch { /* A malformed or replaced owner must not be refreshed. */ }
  };
  const timer = setInterval(() => {
    if (stopped) return;
    pending = pending.then(beat, beat);
  }, Math.max(100, intervalMs));
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
  };
}
