import { createHash } from "node:crypto";
import type { ProcessExecutionPort } from "agent-platform";
import {
  runLeasedRepositoryGit,
  type RepositoryWorktreeTopology
} from "./repository-git-execution.js";
import type {
  RepositoryHeadRelationV2,
  RepositoryInspectionProbeV2,
  RepositoryInspectionV2,
  RepositoryRecoveryCandidateV2,
  RepositoryReflogEntryV2
} from "./repository-git-inspection-types.js";

const CAPTURE_BYTES = 512 * 1024;
const MAX_PROBE_LINES = 256;
const MAX_REFLOG_ENTRIES = 100;
const MAX_RECOVERY_CANDIDATES = 32;
const OID_PATTERN = /^[a-f0-9]{40,64}$/u;
type StableProbeKind = "head" | "symbolic_ref" | "status" | "refs" | "unreachable";

export function repositoryInspectionDigest(value: unknown): string {
  return createHash("sha256").update(
    typeof value === "string" ? value : JSON.stringify(value), "utf8"
  ).digest("hex");
}

function stableLines(kind: StableProbeKind, value: string): string[] {
  const accepted = value.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    const bounded = line.slice(0, 2_048);
    if (kind === "head") {
      const oid = bounded.trim().toLowerCase();
      return OID_PATTERN.test(oid) ? [oid] : [];
    }
    if (kind === "symbolic_ref") {
      const reference = bounded.trim();
      return /^refs\/[A-Za-z0-9._/-]+$/u.test(reference) ? [reference] : [];
    }
    if (kind === "status") return /^(?:# |[12u?!] )/u.test(bounded) ? [bounded] : [];
    if (kind === "refs") {
      const match = /^([a-f0-9]{40,64})\t(refs\/[^\r\n\t]+)\t(blob|commit|tag|tree)$/iu
        .exec(bounded);
      return match
        ? [`${match[1]!.toLowerCase()}\t${match[2]!}\t${match[3]!.toLowerCase()}`]
        : [];
    }
    const match = /^(?:dangling|unreachable)\s+(blob|commit|tag|tree)\s+([a-f0-9]{40,64})$/iu
      .exec(bounded);
    return match ? [`${match[1]!.toLowerCase()}\t${match[2]!.toLowerCase()}`] : [];
  });
  return [...new Set(accepted)].sort().slice(0, MAX_PROBE_LINES);
}

async function stableProbe(
  execution: ProcessExecutionPort,
  topology: RepositoryWorktreeTopology,
  kind: StableProbeKind,
  args: string[],
  signal: AbortSignal
): Promise<RepositoryInspectionProbeV2> {
  const output = await runLeasedRepositoryGit(execution, topology, args, signal, CAPTURE_BYTES);
  const ok = output.exitCode === 0 && !output.outputTruncated;
  const lines = ok ? stableLines(kind, output.stdout) : [];
  return {
    ok,
    exitCode: output.exitCode,
    ...(output.failure ? { failureCode: output.failure.code } : {}),
    outputTruncated: output.outputTruncated,
    digest: repositoryInspectionDigest(ok
      ? { kind, ok, lines }
      : { kind, ok, exitCode: output.exitCode, failureCode: output.failure?.code ?? null }),
    lines
  };
}

type ReflogProbe = RepositoryInspectionProbeV2;

async function reflogProbe(
  execution: ProcessExecutionPort,
  topology: RepositoryWorktreeTopology,
  date: "ordinal" | "raw",
  signal: AbortSignal
): Promise<ReflogProbe> {
  const output = await runLeasedRepositoryGit(execution, topology, [
    "reflog", "show", "--all", ...(date === "raw" ? ["--date=raw"] : []),
    "--format=%H%x09%gD%x09%gs", "-n", String(MAX_REFLOG_ENTRIES)
  ], signal, CAPTURE_BYTES);
  const ok = output.exitCode === 0 && !output.outputTruncated;
  // Git's newest-first reflog order is semantic and must never be sorted.
  const lines = ok
    ? output.stdout.split(/\r?\n/u).filter(Boolean)
      .slice(0, MAX_REFLOG_ENTRIES).map((line) => line.slice(0, 4_096))
    : [];
  return {
    ok,
    exitCode: output.exitCode,
    ...(output.failure ? { failureCode: output.failure.code } : {}),
    outputTruncated: output.outputTruncated,
    digest: repositoryInspectionDigest(ok
      ? { kind: `reflog_${date}`, ok, lines }
      : { kind: `reflog_${date}`, ok, exitCode: output.exitCode,
          failureCode: output.failure?.code ?? null }),
    lines
  };
}

interface ParsedOrdinalEntry {
  object: string; baseRef: string; ordinalSelector: string; ordinal: number;
  action: string; subject: string;
}

interface ParsedRawEntry {
  object: string; baseRef: string; rawSelector: string; timestamp: number;
  timezoneOffset: string; action: string; subject: string;
}

function lineFields(line: string): [string, string, string] | undefined {
  const first = line.indexOf("\t");
  const second = first < 0 ? -1 : line.indexOf("\t", first + 1);
  if (first < 1 || second < first + 2) return undefined;
  const object = line.slice(0, first).toLowerCase();
  if (!OID_PATTERN.test(object)) return undefined;
  return [object, line.slice(first + 1, second), line.slice(second + 1)];
}

function actionAndSubject(value: string): { action: string; subject: string } {
  const separator = value.indexOf(": ");
  return {
    action: (separator < 0 ? value : value.slice(0, separator)).slice(0, 128),
    subject: (separator < 0 ? "" : value.slice(separator + 2)).slice(0, 512)
  };
}

function ordinalEntry(line: string): ParsedOrdinalEntry | undefined {
  const fields = lineFields(line);
  if (!fields) return undefined;
  const selector = /^(.*)@\{(\d+)\}$/u.exec(fields[1]);
  if (!selector?.[1]) return undefined;
  const ordinal = Number(selector[2]);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) return undefined;
  return {
    object: fields[0], baseRef: selector[1], ordinalSelector: fields[1], ordinal,
    ...actionAndSubject(fields[2])
  };
}

function rawEntry(line: string): ParsedRawEntry | undefined {
  const fields = lineFields(line);
  if (!fields) return undefined;
  const selector = /^(.*)@\{(-?\d+) ([+-]\d{4})\}$/u.exec(fields[1]);
  if (!selector?.[1]) return undefined;
  const timestamp = Number(selector[2]);
  if (!Number.isSafeInteger(timestamp)) return undefined;
  return {
    object: fields[0], baseRef: selector[1], rawSelector: fields[1], timestamp,
    timezoneOffset: selector[3]!, ...actionAndSubject(fields[2])
  };
}

function alignedReflogEntries(
  ordinal: ReflogProbe,
  raw: ReflogProbe,
  ordinalAfter: ReflogProbe
): { aligned: boolean; entries: RepositoryReflogEntryV2[] } {
  if (!ordinal.ok || !raw.ok || !ordinalAfter.ok
    || ordinal.digest !== ordinalAfter.digest || ordinal.lines.length !== raw.lines.length) {
    return { aligned: false, entries: [] };
  }
  const entries: RepositoryReflogEntryV2[] = [];
  for (let index = 0; index < ordinal.lines.length; index += 1) {
    const left = ordinalEntry(ordinal.lines[index]!);
    const right = rawEntry(raw.lines[index]!);
    if (!left || !right || left.object !== right.object || left.baseRef !== right.baseRef
      || left.action !== right.action || left.subject !== right.subject) {
      return { aligned: false, entries: [] };
    }
    entries.push({
      object: left.object,
      ordinalSelector: left.ordinalSelector,
      rawSelector: right.rawSelector,
      ordinal: left.ordinal,
      timestamp: right.timestamp,
      timezoneOffset: right.timezoneOffset,
      action: left.action,
      subject: left.subject,
      subjectTrusted: false
    });
  }
  return { aligned: true, entries };
}

function parsedHead(probe: RepositoryInspectionProbeV2): string | null {
  const value = probe.ok ? probe.lines[0]?.trim().toLowerCase() : undefined;
  return value && OID_PATTERN.test(value) ? value : null;
}

export function repositoryInspectionBasisDigest(value: Pick<RepositoryInspectionV2,
  "head" | "symbolicRef" | "status" | "refs" | "reflog" | "unreachable" | "complete"
>): string {
  return repositoryInspectionDigest({
    schemaVersion: 2,
    complete: value.complete,
    head: value.head,
    symbolicRef: value.symbolicRef,
    statusDigest: value.status.digest,
    refsDigest: value.refs.digest,
    reflogDigest: value.reflog.digest,
    unreachableDigest: value.unreachable.digest,
    reflogAligned: value.reflog.aligned
  });
}

async function isAncestor(
  execution: ProcessExecutionPort,
  topology: RepositoryWorktreeTopology,
  older: string,
  newer: string,
  signal: AbortSignal
): Promise<boolean | undefined> {
  const output = await runLeasedRepositoryGit(
    execution, topology, ["merge-base", "--is-ancestor", older, newer], signal, 64 * 1024
  );
  if (output.outputTruncated) return undefined;
  if (output.exitCode === 0) return true;
  return output.exitCode === 1 ? false : undefined;
}

async function relationToHead(
  execution: ProcessExecutionPort,
  topology: RepositoryWorktreeTopology,
  candidate: string,
  head: string | null,
  signal: AbortSignal
): Promise<RepositoryHeadRelationV2> {
  if (!head) return "unknown";
  if (candidate === head) return "same";
  const [candidateAncestor, headAncestor] = await Promise.all([
    isAncestor(execution, topology, candidate, head, signal),
    isAncestor(execution, topology, head, candidate, signal)
  ]);
  if (candidateAncestor === undefined || headAncestor === undefined) return "unknown";
  if (candidateAncestor) return "ancestor_of_head";
  return headAncestor ? "descendant_of_head" : "diverged";
}

async function recoveryCandidates(
  execution: ProcessExecutionPort,
  topology: RepositoryWorktreeTopology,
  entries: readonly RepositoryReflogEntryV2[],
  unreachable: RepositoryInspectionProbeV2,
  head: string | null,
  basisDigest: string,
  signal: AbortSignal
): Promise<RepositoryRecoveryCandidateV2[]> {
  const unreachableCommits = new Set(unreachable.lines.flatMap((line) => {
    const [kind, object] = line.split("\t");
    return kind === "commit" && object ? [object] : [];
  }));
  const seen = new Set<string>();
  const selected = entries.filter((entry) => {
    if (!unreachableCommits.has(entry.object) || entry.object === head || seen.has(entry.object)) return false;
    seen.add(entry.object);
    return true;
  }).slice(0, MAX_RECOVERY_CANDIDATES);
  return await Promise.all(selected.map(async (entry) => ({
    ...entry,
    candidateId: repositoryInspectionDigest({
      schemaVersion: 2, basisDigest, object: entry.object,
      ordinalSelector: entry.ordinalSelector, rawSelector: entry.rawSelector,
      timestamp: entry.timestamp, action: entry.action
    }),
    relationToHead: await relationToHead(execution, topology, entry.object, head, signal)
  })));
}

interface RepositoryStateProbes {
  head: RepositoryInspectionProbeV2;
  symbolicRef: RepositoryInspectionProbeV2;
  status: RepositoryInspectionProbeV2;
  refs: RepositoryInspectionProbeV2;
}

async function repositoryStateProbes(
  execution: ProcessExecutionPort,
  topology: RepositoryWorktreeTopology,
  signal: AbortSignal
): Promise<RepositoryStateProbes> {
  const [head, symbolicRef, status, refs] = await Promise.all([
    stableProbe(execution, topology, "head", ["rev-parse", "--verify", "HEAD"], signal),
    stableProbe(execution, topology, "symbolic_ref", ["symbolic-ref", "-q", "HEAD"], signal),
    stableProbe(execution, topology, "status", [
      "status", "--porcelain=v2", "--branch", "--untracked-files=all"
    ], signal),
    stableProbe(execution, topology, "refs", [
      "for-each-ref", "--sort=refname", "--format=%(objectname)%09%(refname)%09%(objecttype)"
    ], signal)
  ]);
  return { head, symbolicRef, status, refs };
}

function repositoryProbesStable(
  initial: RepositoryStateProbes,
  final: RepositoryStateProbes
): boolean {
  return initial.head.digest === final.head.digest
    && initial.symbolicRef.digest === final.symbolicRef.digest
    && initial.status.digest === final.status.digest
    && initial.refs.digest === final.refs.digest;
}

function inspectionComplete(
  initial: RepositoryStateProbes,
  unreachable: RepositoryInspectionProbeV2,
  reflogAligned: boolean,
  stable: boolean
): boolean {
  if (!stable || !reflogAligned) return false;
  if (!initial.head.ok || !initial.status.ok || !initial.refs.ok || !unreachable.ok) return false;
  return initial.symbolicRef.ok || initial.symbolicRef.exitCode === 1;
}

function reflogInspectionProbe(
  ordinal: RepositoryInspectionProbeV2,
  raw: RepositoryInspectionProbeV2,
  ordinalAfter: RepositoryInspectionProbeV2,
  aligned: ReturnType<typeof alignedReflogEntries>
) {
  return {
    ok: ordinal.ok && raw.ok && ordinalAfter.ok && aligned.aligned,
    exitCode: ordinal.exitCode,
    ...(ordinal.failureCode ? { failureCode: ordinal.failureCode } : {}),
    outputTruncated: ordinal.outputTruncated || raw.outputTruncated || ordinalAfter.outputTruncated,
    digest: repositoryInspectionDigest({
      ordinalDigest: ordinal.digest, rawDigest: raw.digest,
      ordinalAfterDigest: ordinalAfter.digest, aligned: aligned.aligned, entries: aligned.entries
    }),
    lines: ordinal.lines,
    aligned: aligned.aligned,
    entries: aligned.entries
  };
}

export async function collectRepositoryInspectionV2(
  execution: ProcessExecutionPort,
  topology: RepositoryWorktreeTopology,
  signal: AbortSignal
): Promise<RepositoryInspectionV2> {
  const initial = await repositoryStateProbes(execution, topology, signal);
  const ordinal = await reflogProbe(execution, topology, "ordinal", signal);
  const raw = await reflogProbe(execution, topology, "raw", signal);
  const ordinalAfter = await reflogProbe(execution, topology, "ordinal", signal);
  const unreachable = await stableProbe(execution, topology, "unreachable", [
    "fsck", "--no-reflogs", "--unreachable", "--no-progress"
  ], signal);
  const final = await repositoryStateProbes(execution, topology, signal);
  const aligned = alignedReflogEntries(ordinal, raw, ordinalAfter);
  const complete = inspectionComplete(
    initial, unreachable, aligned.aligned, repositoryProbesStable(initial, final)
  );
  const reflog = reflogInspectionProbe(ordinal, raw, ordinalAfter, aligned);
  const base: RepositoryInspectionV2 = {
    schemaVersion: 2,
    repositoryRoot: ".",
    topology: topology.kind === "bare" ? "worktree" : topology.kind,
    complete,
    head: parsedHead(initial.head),
    symbolicRef: initial.symbolicRef.ok ? initial.symbolicRef.lines[0] ?? null : null,
    status: initial.status,
    refs: initial.refs,
    reflog,
    unreachable,
    basisDigest: "",
    recoveryCandidates: [],
    selectionStatus: { status: "none" }
  };
  base.basisDigest = repositoryInspectionBasisDigest(base);
  base.recoveryCandidates = complete
    ? await recoveryCandidates(
        execution, topology, aligned.entries, unreachable, base.head, base.basisDigest, signal
      )
    : [];
  return base;
}
