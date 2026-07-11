import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ContextItem } from "agent-protocol";
import {
  resolveWorkspacePath,
  runProcess,
  selfContainedGitRoot,
  type ProcessExecutionPort
} from "agent-platform";
import { VersionedContextCache } from "./cache.js";
import { approximateTokens, lexicalScore } from "./unicode.js";

const ignored = new Set([".git", ".agent", "node_modules", "dist", "coverage"]);

interface RepositorySnapshot {
  files: string[];
  diff: string;
}

async function fallbackFiles(workspace: string, signal: AbortSignal, limit = 100_000): Promise<string[]> {
  const files: string[] = [];
  const queue = [""];
  while (queue.length > 0 && files.length < limit) {
    if (signal.aborted) throw signal.reason ?? new Error("Repository indexing cancelled.");
    const relative = queue.shift()!;
    const directory = await resolveWorkspacePath(workspace, relative || ".");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory() && !ignored.has(entry.name)) queue.push(child);
      else if (entry.isFile()) files.push(child.split(path.sep).join("/"));
      if (files.length >= limit) break;
    }
  }
  return files;
}

async function gitVersion(
  repositoryRoot: string,
  signal: AbortSignal,
  execution: ProcessExecutionPort
): Promise<string | null> {
  const [status, diff] = await Promise.all([
    runProcess({
      execution,
      executable: "git", args: ["status", "--porcelain=v1", "--branch"], cwd: repositoryRoot,
      timeoutMs: 30_000, maxOutputBytes: 2_000_000, signal
    }).catch(() => null),
    runProcess({
      execution,
      executable: "git", args: ["diff", "--no-ext-diff", "--binary", "--"], cwd: repositoryRoot,
      timeoutMs: 30_000, maxOutputBytes: 2_000_000, signal
    }).catch(() => null)
  ]);
  if (!status || status.exitCode !== 0) return null;
  return createHash("sha256").update(status.stdout).update(diff?.stdout ?? "").digest("hex");
}

async function loadGitSnapshot(
  repositoryRoot: string,
  signal: AbortSignal,
  execution: ProcessExecutionPort
): Promise<RepositorySnapshot> {
  const listing = await runProcess({
    execution,
    executable: "git", args: ["ls-files", "-co", "--exclude-standard", "-z"], cwd: repositoryRoot,
    timeoutMs: 30_000, maxOutputBytes: 16_000_000, signal
  });
  const diff = await runProcess({
    execution,
    executable: "git", args: ["diff", "--no-ext-diff", "--unified=2", "--"], cwd: repositoryRoot,
    timeoutMs: 30_000, maxOutputBytes: 200_000, signal
  });
  return {
    files: listing.stdout.split("\0").filter(Boolean).slice(0, 100_000),
    diff: diff.stdout.slice(0, 100_000)
  };
}

async function snippets(workspace: string, files: string[], query: string, signal: AbortSignal): Promise<string> {
  const pathCandidates = files
    .map((file) => ({ file, score: lexicalScore(query, file) }))
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
    .slice(0, 40);
  const matches: Array<{ file: string; score: number; excerpt: string }> = [];
  for (const candidate of pathCandidates) {
    if (signal.aborted) throw signal.reason ?? new Error("Repository retrieval cancelled.");
    const target = await resolveWorkspacePath(workspace, candidate.file);
    if (await stat(target).then((value) => value.size > 256_000, () => true)) continue;
    const content = await readFile(target, "utf8").catch(() => "");
    if (!content || content.includes("\0")) continue;
    const score = Math.max(candidate.score, lexicalScore(query, content));
    if (score > 0) matches.push({ file: candidate.file, score, excerpt: content.slice(0, 4_000) });
  }
  return matches.sort((left, right) => right.score - left.score).slice(0, 8)
    .map((item) => `--- ${item.file}\n${item.excerpt}`).join("\n");
}

export class RepositoryContextProvider {
  private readonly cache = new VersionedContextCache<RepositorySnapshot>();
  private readonly nonGitVersions = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly execution?: ProcessExecutionPort) {}

  async collect(workspace: string, query: string, signal: AbortSignal): Promise<ContextItem[]> {
    const resolved = path.resolve(workspace);
    const repositoryRoot = this.execution
      ? await selfContainedGitRoot(resolved, signal, this.execution) : null;
    const git = repositoryRoot && this.execution
      ? await gitVersion(repositoryRoot, signal, this.execution) : null;
    const cachedNonGit = this.nonGitVersions.get(resolved);
    const nonGitVersion = cachedNonGit && cachedNonGit.expiresAt > Date.now()
      ? cachedNonGit.value : `nongit:${Math.floor(Date.now() / 1_000)}`;
    if (!cachedNonGit || cachedNonGit.value !== nonGitVersion) {
      this.nonGitVersions.set(resolved, { value: nonGitVersion, expiresAt: Date.now() + 1_000 });
    }
    const version = git ?? nonGitVersion;
    let snapshot = this.cache.get(resolved, version);
    if (!snapshot) {
      snapshot = git === null || !repositoryRoot
        ? { files: await fallbackFiles(resolved, signal), diff: "" }
        : await loadGitSnapshot(repositoryRoot, signal, this.execution!);
      this.cache.set(resolved, version, snapshot);
    }
    const ranked = snapshot.files
      .map((file) => ({ file, score: lexicalScore(query, file) }))
      .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
      .slice(0, 200).map((item) => item.file);
    const excerpt = query.trim() ? await snippets(resolved, snapshot.files, query, signal) : "";
    const indexContent = [`Repository files (${snapshot.files.length}, top matches):`, ...ranked, excerpt].filter(Boolean).join("\n");
    const items: ContextItem[] = [{
      id: `repo:index:${version.length}:${snapshot.files.length}`,
      authority: "tool",
      provenance: "incremental repository index",
      content: indexContent,
      tokenCount: approximateTokens(indexContent),
      priority: 500
    }];
    if (snapshot.diff) items.push({
      id: `repo:diff:${version.length}`,
      authority: "tool",
      provenance: "current Git diff",
      content: snapshot.diff,
      tokenCount: approximateTokens(snapshot.diff),
      priority: 700
    });
    return items;
  }
}
