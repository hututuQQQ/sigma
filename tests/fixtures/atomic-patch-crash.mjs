import { writeFile } from "node:fs/promises";
import { applyUnifiedPatch } from "../../packages/agent-tools/dist/atomic-patch.js";

const [workspace, marker, phase, encodedPatch] = process.argv.slice(2);
if (!workspace || !marker || !phase || !encodedPatch) {
  throw new Error("atomic patch crash fixture requires workspace/marker/phase/patch");
}
const patch = Buffer.from(encodedPatch, "base64url").toString("utf8");
await applyUnifiedPatch(workspace, patch, {
  beforeMutation: async (operation) => {
    if (operation.direction !== "commit" || operation.phase !== phase) return;
    await writeFile(marker, phase, "utf8");
    process.kill(process.pid, "SIGKILL");
  }
});
