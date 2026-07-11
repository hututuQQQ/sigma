import path from "node:path";
import type { CheckpointDelta, CheckpointEntry, CheckpointManifest } from "./types.js";

export function portable(relative: string): string {
  const normalized = relative.split(path.sep).join("/");
  return normalized === "" ? "." : normalized;
}

function entryIdentity(entry: CheckpointEntry): string {
  return JSON.stringify([entry.kind, entry.mode, entry.size, entry.digest ?? null, entry.linkTarget ?? null]);
}

export function checkpointDelta(before: CheckpointManifest, after: CheckpointManifest): CheckpointDelta {
  const left = new Map(before.entries.map((entry) => [entry.path, entry]));
  const right = new Map(after.entries.map((entry) => [entry.path, entry]));
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const previous = left.get(name);
    const current = right.get(name);
    if (!previous) added.push(name);
    else if (!current) deleted.push(name);
    else if (entryIdentity(previous) !== entryIdentity(current)) modified.push(name);
  }
  return { added, modified, deleted };
}
