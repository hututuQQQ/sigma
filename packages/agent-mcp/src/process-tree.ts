import { spawn, type ChildProcess } from "node:child_process";

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", onClose);
      resolve(value);
    };
    const onClose = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once("close", onClose);
  });
}

async function signalTree(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
    } catch {
      try { child.kill(signal); } catch { /* process already exited */ }
    }
    return;
  }
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore"
    });
    killer.once("error", () => {
      try { child.kill(); } catch { /* process already exited */ }
      resolve();
    });
    killer.once("close", () => resolve());
  });
}

export function detachedProcessGroup(): boolean {
  return process.platform !== "win32";
}

export async function terminateProcessTree(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin?.end();
  if (await waitForExit(child, graceMs)) return;
  await signalTree(child, "SIGTERM");
  if (await waitForExit(child, graceMs)) return;
  await signalTree(child, "SIGKILL");
  await waitForExit(child, Math.min(graceMs, 250));
}
