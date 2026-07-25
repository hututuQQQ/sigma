export interface RepositoryInspectionProbe {
  ok: boolean;
  exitCode: number | null;
  failureCode?: string;
  outputTruncated: boolean;
  digest: string;
  lines: string[];
}

export interface RepositoryReflogEntry {
  object: string;
  ordinalSelector: string;
  rawSelector: string;
  ordinal: number;
  timestamp: number;
  timezoneOffset: string;
  action: string;
  subject: string;
  subjectTrusted: false;
}

export type RepositoryHeadRelation =
  | "same"
  | "ancestor_of_head"
  | "descendant_of_head"
  | "diverged"
  | "unknown";

export interface RepositoryRecoveryCandidate extends RepositoryReflogEntry {
  candidateId: string;
  relationToHead: RepositoryHeadRelation;
  /** Runtime-issued, freshness-bound capability used if the model selects this candidate. */
  selectionEvidenceId?: string;
}

export type RepositoryRecoverySelectionStatus =
  | { status: "none" }
  | { status: "unavailable"; reason: string }
  | { status: "model_choice_available"; candidateIds: string[] }
  | {
      status: "selected";
      candidateId: string;
      selectionEvidenceId: string;
      selectionKind: "unique";
    };

export interface RepositoryInspection {
  schemaVersion: 1;
  repositoryRoot: ".";
  topology: "worktree" | "linked_worktree" | "submodule";
  complete: boolean;
  head: string | null;
  symbolicRef: string | null;
  status: RepositoryInspectionProbe;
  refs: RepositoryInspectionProbe;
  reflog: RepositoryInspectionProbe & {
    aligned: boolean;
    entries: RepositoryReflogEntry[];
  };
  unreachable: RepositoryInspectionProbe;
  basisDigest: string;
  recoveryCandidates: RepositoryRecoveryCandidate[];
  selectionStatus: RepositoryRecoverySelectionStatus;
}
