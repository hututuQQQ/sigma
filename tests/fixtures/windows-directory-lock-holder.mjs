import { lockWindowsDirectories } from "../../packages/agent-platform/dist/index.js";

const target = process.argv[2];
if (!target) throw new Error("A directory path is required.");

await lockWindowsDirectories([target]);
process.stdout.write("ready\n");
setInterval(() => undefined, 1_000);
