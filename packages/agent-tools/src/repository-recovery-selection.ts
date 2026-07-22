import type {
  RepositoryRecoverySelectionEvidenceV1
} from "agent-protocol";

export interface StoredRepositoryRecoverySelectionV1 {
  evidence: RepositoryRecoverySelectionEvidenceV1;
  repositoryRoot: string;
  selectedObject: string;
}

export interface RepositoryRecoverySelectionScope {
  sessionId: string;
  runId: string;
  goalEpoch: number;
  repositoryRoot: string;
  candidateId: string;
}

function invalidSelection(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Ephemeral capability store shared by the structured inspection and
 * transaction tools. Evidence identifiers are intentionally insufficient on
 * their own: every resolution rechecks session, run, goal epoch, repository,
 * and candidate bindings. A process restart loses the capability and therefore
 * fails closed until a fresh inspection is performed.
 */
export class RepositoryRecoverySelectionStore {
  private readonly records = new Map<string, StoredRepositoryRecoverySelectionV1>();

  record(value: StoredRepositoryRecoverySelectionV1): void {
    this.records.set(value.evidence.evidenceId, value);
  }

  resolve(
    evidenceId: string,
    scope: RepositoryRecoverySelectionScope
  ): StoredRepositoryRecoverySelectionV1 {
    const record = this.records.get(evidenceId);
    if (!record) {
      throw invalidSelection(
        "Repository recovery selection evidence is unknown, expired, or was not issued by this runtime.",
        "repository_recovery_selection_invalid"
      );
    }
    const evidence = record.evidence;
    const data = evidence.data;
    if (evidence.sessionId !== scope.sessionId || evidence.runId !== scope.runId
      || record.repositoryRoot !== scope.repositoryRoot
      || data.repositoryRoot !== "."
      || data.candidateId !== scope.candidateId
      || data.goalEpoch !== scope.goalEpoch) {
      throw invalidSelection(
        "Repository recovery selection evidence does not belong to the current run, goal, repository, or candidate.",
        "repository_recovery_selection_stale"
      );
    }
    return record;
  }
}
