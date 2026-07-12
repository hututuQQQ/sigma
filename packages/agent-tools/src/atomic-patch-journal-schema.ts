import { createHash } from "node:crypto";
import path from "node:path";
import { durableReplaceFile } from "agent-platform";
import { AtomicPatchError } from "./atomic-patch-parser.js";
import { safePatchRelative } from "./atomic-patch-preparation.js";
import type { PreparedPatchChange } from "./atomic-patch-types.js";

export type AtomicPatchJournalPhase = "preparing" | "prepared" | "applying" | "rolling_back" | "committed";

export interface AtomicPatchJournalOperation {
  changeIndex: number;
  source?: string;
  target?: string;
  sourceKind?: "file" | "symlink";
  sourceMode?: number;
  sourceDigest?: string;
  targetKind?: "file" | "symlink";
  targetMode?: number;
  targetDigest?: string;
  backupIntent: boolean;
  backupMoved: boolean;
  installIntent: boolean;
  installed: boolean;
}

export interface AtomicPatchJournalParent {
  relativePath: string;
  changeIndex: number;
  createIntent: boolean;
  created: boolean;
}

export interface AtomicPatchJournal {
  schemaVersion: 1;
  phase: AtomicPatchJournalPhase;
  operations: AtomicPatchJournalOperation[];
  parents: AtomicPatchJournalParent[];
}

export class AtomicPatchRecoveryError extends AtomicPatchError {
  readonly recoveryPath: string;

  constructor(message: string, recoveryPath: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AtomicPatchRecoveryError";
    this.recoveryPath = recoveryPath;
  }
}

export function patchJournalDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createPatchJournal(changes: readonly PreparedPatchChange[]): AtomicPatchJournal {
  return {
    schemaVersion: 1,
    phase: "preparing",
    parents: [],
    operations: changes.map((change, changeIndex) => ({
      changeIndex,
      ...(change.source ? {
        source: change.source,
        sourceKind: change.original.kind,
        sourceMode: change.original.mode & 0o7777,
        sourceDigest: patchJournalDigest(change.original.bytes)
      } : {}),
      ...(change.target ? {
        target: change.target,
        targetKind: change.kind!,
        targetMode: change.mode! & 0o7777,
        targetDigest: patchJournalDigest(Buffer.from(change.content!, "utf8"))
      } : {}),
      backupIntent: false,
      backupMoved: false,
      installIntent: false,
      installed: false
    }))
  };
}

export async function writePatchJournal(transactionPath: string, journal: AtomicPatchJournal): Promise<void> {
  await durableReplaceFile(
    path.join(transactionPath, "journal.json"),
    JSON.stringify(journal, null, 2),
    { mode: 0o600 }
  );
}

function safeRelative(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.includes("\\")) return false;
  try {
    return safePatchRelative(value) === value;
  } catch {
    return false;
  }
}

function boolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validEndpoint(
  pathValue: unknown,
  kind: unknown,
  mode: unknown,
  digestValue: unknown
): boolean {
  if (pathValue === undefined) return kind === undefined && mode === undefined && digestValue === undefined;
  return [
    safeRelative(pathValue),
    ["file", "symlink"].includes(String(kind)),
    Number.isSafeInteger(mode),
    validDigest(digestValue)
  ].every(Boolean);
}

function validOperation(value: unknown, indices: Set<number>): value is AtomicPatchJournalOperation {
  if (!value || typeof value !== "object") return false;
  const operation = value as Partial<AtomicPatchJournalOperation>;
  const index = operation.changeIndex;
  const valid = [
    Number.isSafeInteger(index),
    typeof index === "number" && index >= 0,
    typeof index === "number" && !indices.has(index),
    validEndpoint(operation.source, operation.sourceKind, operation.sourceMode, operation.sourceDigest),
    validEndpoint(operation.target, operation.targetKind, operation.targetMode, operation.targetDigest),
    Boolean(operation.source || operation.target),
    boolean(operation.backupIntent),
    boolean(operation.backupMoved),
    boolean(operation.installIntent),
    boolean(operation.installed)
  ].every(Boolean);
  if (valid) indices.add(index as number);
  return valid;
}

function validParent(value: unknown, indices: ReadonlySet<number>): value is AtomicPatchJournalParent {
  if (!value || typeof value !== "object") return false;
  const parent = value as Partial<AtomicPatchJournalParent>;
  return [
    safeRelative(parent.relativePath),
    Number.isSafeInteger(parent.changeIndex),
    typeof parent.changeIndex === "number" && indices.has(parent.changeIndex),
    boolean(parent.createIntent),
    boolean(parent.created)
  ].every(Boolean);
}

export function parsePatchJournal(value: unknown, transactionPath: string): AtomicPatchJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AtomicPatchRecoveryError("Atomic patch recovery journal is invalid.", transactionPath);
  }
  const candidate = value as Partial<AtomicPatchJournal>;
  if (candidate.schemaVersion !== 1
    || !["preparing", "prepared", "applying", "rolling_back", "committed"].includes(String(candidate.phase))
    || !Array.isArray(candidate.operations) || !Array.isArray(candidate.parents)) {
    throw new AtomicPatchRecoveryError("Atomic patch recovery journal has an unsupported schema.", transactionPath);
  }
  const indices = new Set<number>();
  if (!candidate.operations.every((operation) => validOperation(operation, indices))) {
    throw new AtomicPatchRecoveryError("Atomic patch recovery journal contains an invalid operation.", transactionPath);
  }
  if (!candidate.parents.every((parent) => validParent(parent, indices))) {
    throw new AtomicPatchRecoveryError("Atomic patch recovery journal contains an invalid parent operation.", transactionPath);
  }
  return candidate as AtomicPatchJournal;
}
