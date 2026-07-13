import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CheckpointManager } from "../../packages/agent-checkpoint/dist/index.js";
import { createCheckpointManagerForTesting } from "../../packages/agent-checkpoint/dist/testing.js";

const [stateRoot, workspace, marker] = process.argv.slice(2);
if (!stateRoot || !workspace || !marker) throw new Error("checkpoint crash fixture requires state/workspace/marker paths");

await mkdir(path.join(workspace, ".git"), { recursive: true });
await writeFile(path.join(workspace, "target.txt"), "before", "utf8");
const manager = new CheckpointManager({ rootDir: stateRoot });
const checkpoint = await manager.create({
  sessionId: "session-verified-crash",
  runId: "run-verified-crash",
  workspacePath: workspace,
  scopePaths: ["target.txt"],
  baseSeq: 1
});
await writeFile(path.join(workspace, "target.txt"), "after", "utf8");
await manager.seal(checkpoint.sessionId, checkpoint.checkpointId);

const crashing = createCheckpointManagerForTesting({
  rootDir: stateRoot
}, async ({ point }) => {
    if (point !== "before_record") return;
    await writeFile(marker, "verified", "utf8");
    process.kill(process.pid, "SIGKILL");
});
await crashing.undoLatest(checkpoint.sessionId);
