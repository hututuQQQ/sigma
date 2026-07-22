import path from "node:path";
import type { ProcessExecutionPort, RuntimeEnvironment } from "agent-platform";
import type { RuntimeSession } from "./types.js";

export interface ManagedSessionLifecycleOptions {
  mode?: "disabled" | "required";
  network?: "none" | "loopback" | "full";
  runtimeEnvironment?: RuntimeEnvironment;
  execution?: ProcessExecutionPort;
}

/** Owns the runtime-only managed binding. Durable session state may refer to
 * broker facts, but it can never recreate or widen this capability. */
export class ManagedSessionLifecycle {
  constructor(private readonly options: ManagedSessionLifecycleOptions) {}

  async bind(session: RuntimeSession): Promise<void> {
    if ((this.options.mode ?? "disabled") !== "required") return;
    const binder = this.options.execution?.bindManagedSession;
    if (!binder) {
      throw Object.assign(new Error(
        "Managed environment is required, but the execution broker cannot bind this session."
      ), { code: "managed_environment_required_unavailable" });
    }
    const targetPath = this.options.runtimeEnvironment?.platform === "win32" ? path.win32 : path.posix;
    session.execution.managedSessionBinding = await binder.call(this.options.execution, {
      protocolVersion: 1,
      sessionId: session.identity.sessionId,
      workspace: session.identity.workspacePath,
      network: this.options.network ?? "none",
      protectedPaths: [
        targetPath.join(session.identity.workspacePath, ".git"),
        targetPath.join(session.identity.workspacePath, ".agent")
      ]
    }, { timeoutMs: 10_000 });
  }

  async release(sessionId: string): Promise<void> {
    await this.options.execution?.releaseScratchLease?.(
      sessionId, { timeoutMs: 5_000 }
    ).catch(() => undefined);
  }
}
