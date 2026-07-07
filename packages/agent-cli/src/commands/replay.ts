import { readFile } from "node:fs/promises";
import { redactSecrets, type AgentEvent } from "agent-core";
import { parseArgs } from "../config.js";
import { formatAgentEvent } from "../stream-ui.js";

function eventFromRecord(record: unknown): AgentEvent | null {
  if (!record || typeof record !== "object") return null;
  const value = record as { type?: unknown; event?: unknown };
  if (value.type === "event" && value.event && typeof value.event === "object") {
    return value.event as AgentEvent;
  }
  if (typeof value.type === "string") return value as AgentEvent;
  return null;
}

export async function runReplayCommand(argv: string[]): Promise<number> {
  const { flags, positionals } = parseArgs(argv);
  const tracePath = typeof flags["trace-jsonl"] === "string" ? flags["trace-jsonl"] : positionals[0];
  const json = flags.json !== undefined;
  const timeline = flags.timeline !== undefined;
  if (!tracePath) {
    process.stderr.write("replay requires --trace-jsonl <path> or a trace path positional.\n");
    return 1;
  }

  try {
    const text = await readFile(tracePath, "utf8");
    const counts = new Map<string, number>();
    const timelineLines: string[] = [];
    let events = 0;
    for (const line of text.split(/\r?\n/)) {
      const normalizedLine = line.replace(/^\uFEFF/, "");
      if (!normalizedLine.trim()) continue;
      const record = JSON.parse(normalizedLine) as { type?: string };
      const event = eventFromRecord(record);
      events += 1;
      const type = event?.type ?? record.type ?? "unknown";
      counts.set(type, (counts.get(type) ?? 0) + 1);
      if (timeline && event) {
        const formatted = formatAgentEvent(event);
        if (formatted) timelineLines.push(formatted);
      }
    }

    const report = {
      tracePath,
      events,
      counts: Object.fromEntries([...counts.entries()].sort()),
      ...(timeline ? { timeline: timelineLines } : {})
    };
    if (json) {
      process.stdout.write(`${JSON.stringify(redactSecrets(report))}\n`);
      return 0;
    }

    process.stdout.write(`events=${events}\n`);
    for (const [type, count] of [...counts.entries()].sort()) {
      process.stdout.write(`${type}=${count}\n`);
    }
    if (timeline) {
      process.stdout.write("\nTimeline\n");
      for (const line of timelineLines) {
        process.stdout.write(`${line}\n`);
      }
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
