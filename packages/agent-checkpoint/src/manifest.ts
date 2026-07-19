import path from "node:path";
import type { CheckpointDelta, CheckpointEntry, CheckpointManifest } from "./types.js";

export function portable(relative: string): string {
  const normalized = relative.split(path.sep).join("/");
  return normalized === "" ? "." : normalized;
}

function entryIdentity(entry: CheckpointEntry): string {
  return JSON.stringify([
    entry.kind, entry.mode, entry.size, entry.digest ?? null, entry.linkTarget ?? null, entry.linkType ?? null,
    entry.rootIdentity ?? null
  ]);
}

function strictlyOrdered(entries: readonly CheckpointEntry[]): boolean {
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.path >= entries[index]!.path) return false;
  }
  return true;
}

function orderedDelta(before: CheckpointManifest, after: CheckpointManifest): CheckpointDelta {
  const result: CheckpointDelta = { added: [], modified: [], deleted: [] };
  let left = 0;
  let right = 0;
  while (left < before.entries.length || right < after.entries.length) {
    const previous = before.entries[left];
    const current = after.entries[right];
    if (!previous || (current && current.path < previous.path)) {
      result.added.push(current!.path);
      right += 1;
    } else if (!current || previous.path < current.path) {
      result.deleted.push(previous.path);
      left += 1;
    } else {
      if (entryIdentity(previous) !== entryIdentity(current)) result.modified.push(previous.path);
      left += 1;
      right += 1;
    }
  }
  return result;
}

export function checkpointDelta(before: CheckpointManifest, after: CheckpointManifest): CheckpointDelta {
  if (strictlyOrdered(before.entries) && strictlyOrdered(after.entries)) return orderedDelta(before, after);
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
