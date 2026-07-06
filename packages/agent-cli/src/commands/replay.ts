import { readFile } from "node:fs/promises";
import { parseArgs } from "../config.js";

export async function runReplayCommand(argv: string[]): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const tracePath = typeof flags["trace-jsonl"] === "string" ? flags["trace-jsonl"] : positionals[0];
  if (!tracePath) {
    process.stderr.write("replay requires --trace-jsonl <path> or a trace path positional.\n");
    return 1;
  }

  try {
    const text = await readFile(tracePath, "utf8");
    const counts = new Map<string, number>();
    let events = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as { type?: string };
      events += 1;
      counts.set(record.type ?? "unknown", (counts.get(record.type ?? "unknown") ?? 0) + 1);
    }

    process.stdout.write(`events=${events}\n`);
    for (const [type, count] of [...counts.entries()].sort()) {
      process.stdout.write(`${type}=${count}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
