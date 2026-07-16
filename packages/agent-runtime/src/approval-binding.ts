import { createHash } from "node:crypto";
import type { JsonValue, ModelToolCall, ToolCallPlan, ToolEffect } from "agent-protocol";

const toolEffects = new Set<ToolEffect>([
  "filesystem.read",
  "filesystem.write",
  "process.spawn",
  "process.spawn.readonly",
  "agent.spawn",
  "network",
  "validation",
  "outcome.propose",
  "outcome.request_input",
  "runtime.control",
  "checkpoint.restore",
  "repository.write",
  "destructive",
  "open_world"
]);

export interface ApprovalBinding {
  sessionId: string;
  runId: string;
  callId: string;
  planEffectsDigest: string;
}

export interface RecoveredApprovalMetadata {
  effects: ToolEffect[];
  binding?: ApprovalBinding;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : null;
}

export function parseToolEffects(value: unknown): ToolEffect[] | null {
  const values = strings(value);
  if (!values || new Set(values).size !== values.length
    || values.some((item) => !toolEffects.has(item as ToolEffect))) return null;
  return values as ToolEffect[];
}

function validPlanScalars(
  plan: Record<string, unknown>,
  checkpoint: Record<string, unknown> | null | undefined
): boolean {
  const validCheckpoint = checkpoint === undefined || Boolean(checkpoint
    && checkpoint.kind === "restore"
    && typeof checkpoint.checkpointId === "string"
    && checkpoint.checkpointId.length > 0);
  return (plan.network === "none" || plan.network === "full")
    && ["none", "pipe", "pty", "background"].includes(String(plan.processMode))
    && ["read_only", "replay_safe", "non_replayable"].includes(String(plan.idempotence))
    && validCheckpoint;
}

export function parseToolCallPlan(value: unknown): ToolCallPlan | null {
  const plan = record(value);
  if (!plan) return null;
  const exactEffects = parseToolEffects(plan.exactEffects);
  const readPaths = strings(plan.readPaths);
  const writePaths = strings(plan.writePaths);
  const checkpointScope = strings(plan.checkpointScope);
  const checkpoint = plan.checkpointAction === undefined ? undefined : record(plan.checkpointAction);
  if (!exactEffects || !readPaths || !writePaths || !checkpointScope
    || !validPlanScalars(plan, checkpoint)) return null;
  return {
    exactEffects,
    readPaths,
    writePaths,
    network: plan.network as ToolCallPlan["network"],
    processMode: plan.processMode as ToolCallPlan["processMode"],
    checkpointScope,
    ...(checkpoint ? {
      checkpointAction: { kind: "restore", checkpointId: checkpoint.checkpointId as string }
    } : {}),
    idempotence: plan.idempotence as ToolCallPlan["idempotence"]
  };
}

export function approvalEffectsForPlan(plan: ToolCallPlan): ToolEffect[] {
  const effects = [...plan.exactEffects];
  if (plan.network === "full" && !effects.includes("network")) effects.push("network");
  return effects;
}

function sorted(values: readonly string[]): string[] {
  return [...values].map((item) => item.normalize("NFC")).sort();
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("Approval authority contains an unpaired Unicode surrogate.");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("Approval authority contains an unpaired Unicode surrogate.");
    }
  }
}

function canonicalArray(value: unknown[], ancestors: Set<object>): string {
  const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
  if (keys.length !== value.length
    || keys.some((key, index) => typeof key !== "string" || key !== String(index))) {
    throw new TypeError("Approval authority contains a sparse or extended JSON array.");
  }
  return `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
}

function canonicalObject(value: object, ancestors: Set<object>): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Approval authority contains a non-plain JSON object.");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError("Approval authority contains a symbol-keyed JSON property.");
  }
  const entries = (keys as string[]).map((key) => {
    assertWellFormedUnicode(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("Approval authority contains a non-data JSON property.");
    }
    return [key, descriptor.value] as const;
  });
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, item]) =>
    `${JSON.stringify(key)}:${canonicalJson(item, ancestors)}`).join(",")}}`;
}

/** RFC 8785 JSON Canonicalization Scheme for the JSON data model. */
function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertWellFormedUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Approval authority contains a non-finite JSON number.");
    }
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object") {
    throw new TypeError(`Approval authority contains a non-JSON ${typeof value} value.`);
  }
  if (ancestors.has(value)) throw new TypeError("Approval authority contains a cyclic JSON value.");
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? canonicalArray(value, ancestors)
      : canonicalObject(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function canonicalApprovalAuthority(
  call: Pick<ModelToolCall, "id" | "name" | "arguments">,
  plan: ToolCallPlan,
  effects: readonly ToolEffect[]
): JsonValue {
  return {
    call: {
      id: call.id,
      name: call.name,
      arguments: call.arguments
    },
    effects: sorted(effects),
    plan: {
      exactEffects: sorted(plan.exactEffects),
      readPaths: sorted(plan.readPaths),
      writePaths: sorted(plan.writePaths),
      network: plan.network,
      processMode: plan.processMode,
      checkpointScope: sorted(plan.checkpointScope),
      checkpointAction: plan.checkpointAction
        ? { kind: plan.checkpointAction.kind, checkpointId: plan.checkpointAction.checkpointId }
        : null,
      idempotence: plan.idempotence
    }
  };
}

export function createApprovalBinding(
  sessionId: string,
  runId: string,
  call: Pick<ModelToolCall, "id" | "name" | "arguments">,
  plan: ToolCallPlan,
  effects: readonly ToolEffect[]
): ApprovalBinding {
  assertWellFormedUnicode(call.id);
  assertWellFormedUnicode(call.name);
  const source = canonicalJson(canonicalApprovalAuthority(call, plan, effects));
  return {
    sessionId,
    runId,
    callId: call.id,
    planEffectsDigest: createHash("sha256").update(source, "utf8").digest("hex")
  };
}

export function sameApprovalBinding(
  left: ApprovalBinding | undefined,
  right: ApprovalBinding
): boolean {
  return Boolean(left
    && left.sessionId === right.sessionId
    && left.runId === right.runId
    && left.callId === right.callId
    && left.planEffectsDigest === right.planEffectsDigest);
}
