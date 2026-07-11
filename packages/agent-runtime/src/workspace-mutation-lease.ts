import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireProcessOwnerLease } from "agent-platform";

export class WorkspaceMutationLease {
  async withLease<T>(workspacePath: string, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
    const workspace = await realpath(path.resolve(workspacePath));
    const digest = createHash("sha256").update(workspace).digest("hex");
    const lockPath = path.join(os.tmpdir(), "sigma-agent-worktrees", "writer-locks", `${digest}.lock`);
    const lease = await acquireProcessOwnerLease(lockPath, {
      pid: process.pid,
      instanceId: randomUUID(),
      startedAt: new Date().toISOString()
    }, {
      label: "cross-process workspace mutation lease",
      activeOwner: "wait",
      signal
    });
    try {
      return await action();
    } finally {
      await lease.release();
    }
  }
}
