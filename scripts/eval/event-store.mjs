import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const STORE_LAYOUT_VERSION = 4;
const EVENT_SCHEMA_VERSION = 4;
const SNAPSHOT_SCHEMA_VERSION = 4;
const EVENT_TYPES = new Set([
  "session.created", "run.started", "run.suspended", "run.completed", "run.cancelled", "run.failed",
  "user.message", "user.steer", "user.follow_up", "model.started", "model.delta", "model.reasoning_delta",
  "model.completed", "model.failed", "tool.requested", "tool.approval_requested", "tool.approval_resolved",
  "tool.started", "tool.progress", "tool.completed", "tool.failed", "context.compacted", "child.spawned",
  "child.message", "child.completed", "diagnostic", "execution.planned", "execution.started", "execution.completed",
  "execution.failed", "process.spawned", "process.output", "process.exited", "process.lost", "evidence.recorded",
  "usage.recorded", "model.route_resolved", "model.route_failed", "profile.resolved", "customization.frozen",
  "skill.loaded", "hook.started", "hook.completed", "hook.failed", "plan.updated", "budget.reserved",
  "budget.reservation_bound", "budget.committed", "budget.released", "budget.exhausted", "budget.overrun",
  "budget.limit_increased", "checkpoint.created", "checkpoint.sealed", "checkpoint.restored",
  "checkpoint.recovery_resolved", "review.started", "review.completed", "review.waived"
]);
const AUTHORITIES = new Set(["system", "developer", "user", "project", "runtime", "tool"]);
let officialAssertAgentEventEnvelope = null;
try {
  const protocol = await import("../../packages/agent-protocol/dist/index.js");
  if (protocol.STORE_LAYOUT_VERSION !== STORE_LAYOUT_VERSION
    || protocol.EVENT_SCHEMA_VERSION !== EVENT_SCHEMA_VERSION
    || protocol.SNAPSHOT_SCHEMA_VERSION !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("Built agent-protocol versions do not match the V4 audit reader.");
  }
  officialAssertAgentEventEnvelope = protocol.assertAgentEventEnvelope;
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  // Audit remains usable before a build; the complete V4 envelope
  // boundary below still rejects unknown types, authorities, non-JSON payloads,
  // invalid identities, dates, and sequences. A normal built tree additionally
  // runs the production payload validator above.
}

function jsonValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => jsonValue(item, seen))
    : Object.values(value).every((item) => jsonValue(item, seen));
  seen.delete(value);
  return valid;
}

function assertV4EventEnvelope(event) {
  const valid = event && typeof event === "object" && !Array.isArray(event)
    && event.schemaVersion === EVENT_SCHEMA_VERSION
    && Number.isSafeInteger(event.seq) && event.seq >= 1
    && [event.eventId, event.sessionId, event.runId].every((item) => typeof item === "string" && item.length > 0)
    && validDate(event.occurredAt) && EVENT_TYPES.has(event.type) && AUTHORITIES.has(event.authority)
    && jsonValue(event.payload);
  if (!valid) throw new Error("Invalid AgentEventEnvelope V4.");
  officialAssertAgentEventEnvelope?.(event);
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/u;

function validateSessionId(sessionId) {
  if (!SAFE_ID.test(sessionId) || sessionId === "." || sessionId === ".." || sessionId.length > 128) {
    throw new Error(`Unsafe session identifier: ${sessionId}`);
  }
  return sessionId;
}

function sessionsDirectory(rootDir) {
  return path.join(path.resolve(rootDir), "stores", `v${STORE_LAYOUT_VERSION}`, "sessions");
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateMeta(value, sessionId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid V4 session metadata.");
  const valid = [
    value.schemaVersion === STORE_LAYOUT_VERSION,
    value.eventSchemaVersion === EVENT_SCHEMA_VERSION,
    value.snapshotSchemaVersion === SNAPSHOT_SCHEMA_VERSION,
    value.sessionId === sessionId,
    validDate(value.createdAt),
    validDate(value.updatedAt),
    Number.isSafeInteger(value.lastSeq) && value.lastSeq >= 0,
    Number.isSafeInteger(value.segment) && value.segment >= 1,
    Number.isSafeInteger(value.segmentEvents) && value.segmentEvents >= 0
  ].every(Boolean);
  if (!valid) throw new Error(`Invalid V4 session metadata for '${sessionId}'.`);
  return value;
}

function checksum(event) {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

function parseRecord(line, sessionId, expectedSeq, location) {
  let stored;
  try {
    stored = JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid JSON in V4 event record ${location}.`, { cause: error });
  }
  if (!stored || typeof stored !== "object" || typeof stored.checksum !== "string" || !stored.event) {
    throw new Error(`Invalid V4 event record envelope ${location}.`);
  }
  assertV4EventEnvelope(stored.event);
  if (stored.event.sessionId !== sessionId) throw new Error(`Foreign session event in ${location}.`);
  if (stored.event.seq !== expectedSeq) {
    throw new Error(`Event sequence discontinuity in ${location}: expected ${expectedSeq}, actual ${stored.event.seq}.`);
  }
  if (stored.checksum !== checksum(stored.event)) {
    throw new Error(`Event checksum mismatch at seq ${stored.event.seq} in ${location}.`);
  }
  return stored.event;
}

export async function resolveWorkspaceStateRoot(workspace, options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? os.homedir();
  const canonical = await realpath(path.resolve(workspace));
  const identity = platform === "win32" ? canonical.toLowerCase() : canonical;
  let stateHome;
  if (env.SIGMA_STATE_HOME) stateHome = path.resolve(env.SIGMA_STATE_HOME);
  else if (platform === "win32") stateHome = path.resolve(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Sigma", "State");
  else if (platform === "darwin") stateHome = path.resolve(home, "Library", "Application Support", "Sigma", "State");
  else stateHome = path.resolve(env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "sigma");
  const workspaceDigest = createHash("sha256").update(identity).digest("hex");
  return path.join(stateHome, "workspaces", workspaceDigest);
}

export async function listV4Sessions(rootDir) {
  const directory = sessionsDirectory(rootDir);
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
    try {
      const raw = await readFile(path.join(directory, entry.name, "meta.json"), "utf8");
      const meta = validateMeta(JSON.parse(raw), entry.name);
      sessions.push({ sessionId: meta.sessionId, createdAt: meta.createdAt, updatedAt: meta.updatedAt, lastSeq: meta.lastSeq });
    } catch {
      // A corrupt or non-V4 directory is not selectable. Explicit reads still fail loudly.
    }
  }
  return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function readV4Session(rootDir, inputSessionId) {
  const sessionId = validateSessionId(inputSessionId);
  const directory = path.join(sessionsDirectory(rootDir), sessionId);
  let meta;
  try {
    meta = validateMeta(JSON.parse(await readFile(path.join(directory, "meta.json"), "utf8")), sessionId);
  } catch (error) {
    throw new Error(`Cannot read valid V4 metadata for session '${sessionId}'.`, { cause: error });
  }
  const eventDirectory = path.join(directory, "events");
  const files = (await readdir(eventDirectory).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  })).filter((name) => /^\d{6}\.jsonl$/u.test(name)).sort();
  for (let index = 0; index < files.length; index += 1) {
    const segment = Number.parseInt(files[index].slice(0, 6), 10);
    if (segment !== index + 1) throw new Error(`V4 event segment discontinuity for '${sessionId}' at '${files[index]}'.`);
  }
  const events = [];
  let expectedSeq = 1;
  let lastSegmentEvents = 0;
  for (const file of files) {
    const content = await readFile(path.join(eventDirectory, file), "utf8");
    const lines = content.split("\n");
    let segmentEvents = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      const location = `'${file}' line ${index + 1}`;
      const event = parseRecord(line, sessionId, expectedSeq, location);
      events.push(event);
      expectedSeq += 1;
      segmentEvents += 1;
    }
    lastSegmentEvents = segmentEvents;
  }
  if (events.length !== meta.lastSeq) {
    throw new Error(`V4 metadata/event mismatch for '${sessionId}': meta=${meta.lastSeq}, events=${events.length}.`);
  }
  const lastSegment = files.length === 0 ? 1 : Number.parseInt(files.at(-1).slice(0, 6), 10);
  if (meta.segment !== lastSegment || meta.segmentEvents !== lastSegmentEvents) {
    throw new Error(`V4 segment metadata mismatch for '${sessionId}'.`);
  }
  return { meta, events };
}
