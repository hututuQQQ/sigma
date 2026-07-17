import path from "node:path";
import type { JsonValue } from "agent-protocol";

export interface GitOperation { op: string; [key: string]: JsonValue }

export function gitInput(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("git_transaction arguments must be an object.");
  }
  return value;
}

export function gitOperations(value: JsonValue): GitOperation[] {
  const input = gitInput(value);
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    throw new Error("git_transaction requires operations.");
  }
  return input.operations.map((item) => {
    const operation = gitInput(item);
    if (typeof operation.op !== "string") throw new Error("Every Git operation requires op.");
    return operation as GitOperation;
  });
}

function text(operation: GitOperation, key: string, optional = false): string | undefined {
  const value = operation[key];
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new Error(`${operation.op}.${key} must be non-empty text.`);
  }
  return value;
}

function bool(operation: GitOperation, key: string): boolean {
  const value = operation[key];
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error(`${operation.op}.${key} must be boolean.`);
  return value;
}

function list(operation: GitOperation, key: string): string[] {
  const value = operation[key];
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== "string" || !item || item.includes("\0"))) {
    throw new Error(`${operation.op}.${key} must be a non-empty string array.`);
  }
  return value as string[];
}

function revision(value: string, label: string): string {
  if (value.startsWith("-") || /[\r\n\0]/u.test(value)) throw new Error(`${label} is not a safe revision.`);
  return value;
}

function safePathspec(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || path.isAbsolute(value) || /^[a-z]:/iu.test(value)
    || normalized.split("/").some((part) => part === ".."
      || part.toLowerCase() === ".git" || part.toLowerCase() === ".agent")) {
    throw new Error(`Unsafe Git pathspec '${value}'.`);
  }
  return normalized;
}

type OperationBuilder = (operation: GitOperation) => string[];

const builders: Readonly<Record<string, OperationBuilder>> = {
  add: (operation) => ["add", "--", ...list(operation, "paths").map(safePathspec)],
  restore: (operation) => {
    const source = text(operation, "source", true);
    const staged = bool(operation, "staged");
    const worktree = bool(operation, "worktree");
    return ["restore", ...(source ? [`--source=${revision(source, "restore.source")}`] : []),
      ...(staged ? ["--staged"] : []), ...(worktree || !staged ? ["--worktree"] : []),
      "--", ...list(operation, "paths").map(safePathspec)];
  },
  switch: (operation) => {
    const target = text(operation, "target", true);
    const create = text(operation, "create", true);
    const detach = bool(operation, "detach");
    if (create && detach) throw new Error("switch cannot combine create and detach.");
    if (!target && !create) throw new Error("switch requires target or create.");
    return ["switch", ...(detach ? ["--detach"] : []),
      ...(create ? ["-c", revision(create, "switch.create")] : []),
      ...(target ? [revision(target, "switch.target")] : [])];
  },
  commit: (operation) => ["commit", ...(bool(operation, "amend") ? ["--amend"] : []),
    "--no-verify", "-m", text(operation, "message")!],
  branch: (operation) => {
    const action = text(operation, "action")!;
    const name = revision(text(operation, "name")!, "branch.name");
    if (action === "delete") return ["branch", bool(operation, "force") ? "-D" : "-d", name];
    if (action === "move") return ["branch", bool(operation, "force") ? "-M" : "-m", name,
      revision(text(operation, "newName")!, "branch.newName")];
    if (action !== "create") throw new Error("branch.action must be create, move, or delete.");
    const start = text(operation, "startPoint", true);
    return ["branch", ...(bool(operation, "force") ? ["-f"] : []), name,
      ...(start ? [revision(start, "branch.startPoint")] : [])];
  },
  tag: (operation) => {
    const action = text(operation, "action")!;
    const name = revision(text(operation, "name")!, "tag.name");
    if (action === "delete") return ["tag", "-d", name];
    if (action !== "create" && action !== "move") throw new Error("tag.action must be create, move, or delete.");
    const target = text(operation, "target", true);
    return ["tag", ...(action === "move" ? ["-f"] : []), name,
      ...(target ? [revision(target, "tag.target")] : [])];
  },
  reset: (operation) => {
    const mode = text(operation, "mode")!;
    if (!["soft", "mixed", "hard"].includes(mode)) throw new Error("reset.mode must be soft, mixed, or hard.");
    return ["reset", `--${mode}`, revision(text(operation, "target")!, "reset.target")];
  },
  merge: (operation) => ["merge", "--no-edit", "--no-verify",
    ...(bool(operation, "noCommit") ? ["--no-commit"] : []),
    revision(text(operation, "target")!, "merge.target")],
  rebase: (operation) => {
    const upstream = revision(text(operation, "upstream")!, "rebase.upstream");
    const onto = text(operation, "onto", true);
    const branch = text(operation, "branch", true);
    return ["rebase", ...(onto ? ["--onto", revision(onto, "rebase.onto")] : []), upstream,
      ...(branch ? [revision(branch, "rebase.branch")] : [])];
  },
  cherry_pick: (operation) => ["cherry-pick",
    ...list(operation, "commits").map((item) => revision(item, "cherry_pick.commits"))],
  revert: (operation) => ["revert", "--no-edit",
    ...list(operation, "commits").map((item) => revision(item, "revert.commits"))],
  update_ref: (operation) => {
    const ref = text(operation, "ref")!;
    const oldValue = text(operation, "oldValue", true);
    if (ref !== "HEAD" && !/^refs\/[A-Za-z0-9._/-]+$/u.test(ref)) {
      throw new Error("update_ref.ref is not a safe ref.");
    }
    if (bool(operation, "delete")) return ["update-ref", "-d", ref,
      ...(oldValue ? [revision(oldValue, "update_ref.oldValue")] : [])];
    return ["update-ref", ref, revision(text(operation, "newValue")!, "update_ref.newValue"),
      ...(oldValue ? [revision(oldValue, "update_ref.oldValue")] : [])];
  },
  reflog_expire: (operation) => ["reflog", "expire",
    `--expire=${revision(text(operation, "expire", true) ?? "now", "reflog_expire.expire")}`,
    ...(bool(operation, "all") ? ["--all"] : [])],
  gc: (operation) => ["gc",
    `--prune=${revision(text(operation, "prune", true) ?? "now", "gc.prune")}`,
    ...(bool(operation, "aggressive") ? ["--aggressive"] : [])]
};

export function gitOperationArgs(operation: GitOperation): string[] {
  const builder = builders[operation.op];
  if (!builder) throw new Error(`Unsupported Git operation '${operation.op}'.`);
  return builder(operation);
}

export function mutatesWorktree(operation: GitOperation): boolean {
  return ["restore", "switch", "reset", "merge", "rebase", "cherry_pick", "revert"].includes(operation.op);
}

export function isDestructiveGitOperation(operation: GitOperation): boolean {
  return ["reset", "rebase", "reflog_expire", "gc", "update_ref"].includes(operation.op)
    || (operation.op === "branch" && text(operation, "action") === "delete")
    || (operation.op === "tag" && text(operation, "action") === "delete");
}

const stringProperty = { type: "string", minLength: 1 } as const;
const booleanProperty = { type: "boolean" } as const;
const stringListProperty = {
  type: "array", minItems: 1, uniqueItems: true, items: stringProperty
} as const;

function operationObject(op: string, properties: Record<string, JsonValue>, required: string[] = []): JsonValue {
  return {
    type: "object", required: ["op", ...required],
    properties: { op: { const: op }, ...properties }, additionalProperties: false
  };
}

export const gitOperationSchema: JsonValue = { oneOf: [
  operationObject("add", { paths: stringListProperty }, ["paths"]),
  operationObject("restore", { paths: stringListProperty, source: stringProperty,
    staged: booleanProperty, worktree: booleanProperty }, ["paths"]),
  operationObject("switch", { target: stringProperty, create: stringProperty, detach: booleanProperty }),
  operationObject("commit", { message: stringProperty, amend: booleanProperty }, ["message"]),
  operationObject("branch", { action: { type: "string", enum: ["create", "move", "delete"] },
    name: stringProperty, newName: stringProperty, startPoint: stringProperty, force: booleanProperty }, ["action", "name"]),
  operationObject("tag", { action: { type: "string", enum: ["create", "move", "delete"] },
    name: stringProperty, target: stringProperty }, ["action", "name"]),
  operationObject("reset", { mode: { type: "string", enum: ["soft", "mixed", "hard"] },
    target: stringProperty }, ["mode", "target"]),
  operationObject("merge", { target: stringProperty, noCommit: booleanProperty }, ["target"]),
  operationObject("rebase", { upstream: stringProperty, onto: stringProperty, branch: stringProperty }, ["upstream"]),
  operationObject("cherry_pick", { commits: stringListProperty }, ["commits"]),
  operationObject("revert", { commits: stringListProperty }, ["commits"]),
  operationObject("update_ref", { ref: stringProperty, newValue: stringProperty,
    oldValue: stringProperty, delete: booleanProperty }, ["ref"]),
  operationObject("reflog_expire", { expire: stringProperty, all: booleanProperty }),
  operationObject("gc", { prune: stringProperty, aggressive: booleanProperty })
] };
