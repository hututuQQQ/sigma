export interface RepositoryInspectionProbeV2 {
  ok: boolean;
  exitCode: number | null;
  failureCode?: string;
  outputTruncated: boolean;
  digest: string;
  lines: string[];
}

export interface RepositoryReflogEntryV2 {
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

export type RepositoryHeadRelationV2 =
  | "same"
  | "ancestor_of_head"
  | "descendant_of_head"
  | "diverged"
  | "unknown";

export interface RepositoryRecoveryCandidateV2 extends RepositoryReflogEntryV2 {
  candidateId: string;
  relationToHead: RepositoryHeadRelationV2;
  /** Runtime-issued, freshness-bound capability used if the model selects this candidate. */
  selectionEvidenceId?: string;
}

export type RepositoryRecoverySelectionStatusV2 =
  | { status: "none" }
  | { status: "unavailable"; reason: string }
  | { status: "model_choice_available"; candidateIds: string[] }
  | {
      status: "selected";
      candidateId: string;
      selectionEvidenceId: string;
      selectionKind: "unique";
    };

export interface RepositoryInspectionV2 {
  schemaVersion: 2;
  repositoryRoot: ".";
  topology: "worktree" | "linked_worktree" | "submodule";
  complete: boolean;
  head: string | null;
  symbolicRef: string | null;
  status: RepositoryInspectionProbeV2;
  refs: RepositoryInspectionProbeV2;
  reflog: RepositoryInspectionProbeV2 & {
    aligned: boolean;
    entries: RepositoryReflogEntryV2[];
  };
  unreachable: RepositoryInspectionProbeV2;
  basisDigest: string;
  recoveryCandidates: RepositoryRecoveryCandidateV2[];
  selectionStatus: RepositoryRecoverySelectionStatusV2;
}
