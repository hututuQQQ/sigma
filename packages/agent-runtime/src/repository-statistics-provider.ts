import {
  collectRepositoryStatistics,
  formatRepositoryListEntry,
  formatRepositoryTextMatch,
  listRepositoryFiles,
  searchRepositoryText
} from "agent-context";
import type {
  RepositoryListRequest,
  RepositoryProviderResult,
  RepositoryTextSearchRequest
} from "agent-tools";

export async function repositoryListJsonLines(
  workspace: string,
  signal: AbortSignal,
  request: RepositoryListRequest
): Promise<RepositoryProviderResult> {
  const listing = await listRepositoryFiles(workspace, signal, request);
  const diagnostics = [
    `listing_complete=${listing.complete}`,
    `listing_truncated=${listing.truncated}`,
    `snapshot_files_observed=${listing.snapshotFiles}`,
    listing.complete
      ? `matched_entries=${listing.matchedEntriesObserved}`
      : `matched_entries_observed_at_least=${listing.matchedEntriesObserved}`,
    `listed_entries=${listing.listedEntries}`,
    `output_bytes=${listing.outputBytes}`,
    `output_byte_limit=${listing.scope.limits.maxOutputBytes}`,
    ...(!listing.complete ? ["listing_partial=true"] : []),
    ...(listing.limitsReached.snapshot ? ["listing_snapshot_truncated=true"] : []),
    ...(listing.limitsReached.deadline ? ["listing_deadline_exceeded=true"] : []),
    ...(listing.limitsReached.entries
      ? [`entry_limit=${listing.scope.limits.maxEntries}`] : []),
    ...(listing.limitsReached.outputBytes ? ["output_byte_limit_reached=true"] : []),
    ...(listing.omittedEntriesAtLeast > 0
      ? [`omitted_entries_at_least=${listing.omittedEntriesAtLeast}`] : [])
  ];
  return {
    output: listing.entries.map(formatRepositoryListEntry).join("\n"),
    diagnostics
  };
}

export async function repositoryStatisticsJson(
  workspace: string,
  signal: AbortSignal
): Promise<RepositoryProviderResult> {
  const statistics = await collectRepositoryStatistics(workspace, signal);
  return {
    output: JSON.stringify(statistics),
    diagnostics: statistics.complete ? [] : [
      "statistics_partial=true",
      ...(statistics.truncated ? ["statistics_truncated=true"] : []),
      ...(statistics.skippedSourceFiles > 0
        ? [`skipped_source_files=${statistics.skippedSourceFiles}`] : [])
    ]
  };
}

export async function repositoryTextSearchJsonLines(
  workspace: string,
  signal: AbortSignal,
  request: RepositoryTextSearchRequest,
  bounds: { deadline?: number } = {}
): Promise<RepositoryProviderResult> {
  const search = await searchRepositoryText(workspace, signal, { ...request, ...bounds });
  const diagnostics = search.complete ? [] : [
    "search_partial=true",
    ...(search.limitsReached.snapshot ? ["search_snapshot_truncated=true"] : []),
    ...(search.limitsReached.deadline ? ["search_deadline_exceeded=true"] : []),
    ...(search.limitsReached.totalBytes
      ? [`search_total_bytes_limit=${search.scope.limits.maxTotalBytes}`] : []),
    ...(search.limitsReached.outputBytes
      ? [`search_output_bytes_limit=${search.scope.limits.maxOutputBytes}`] : []),
    ...(search.limitsReached.matches
      ? [`result_limit=${search.scope.limits.maxMatches}`] : []),
    ...(search.skippedFiles > 0 ? [`skipped_files=${search.skippedFiles}`] : [])
  ];
  return {
    output: search.matches.map(formatRepositoryTextMatch).join("\n"),
    diagnostics
  };
}

export const repositoryRuntimeProviders = {
  repositoryList: repositoryListJsonLines,
  repositoryStatistics: repositoryStatisticsJson,
  repositoryTextSearch: repositoryTextSearchJsonLines
};
