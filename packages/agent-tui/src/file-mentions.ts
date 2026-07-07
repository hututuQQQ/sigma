import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build"]);
const IGNORED_PREFIXES = [".agent/attempts"];

export interface ActiveFileMention {
  prefix: string;
  start: number;
  end: number;
}

export interface FileMentionSuggestion {
  path: string;
  score: number;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function ignored(relativePath: string, name: string): boolean {
  const normalized = normalizePath(relativePath);
  return IGNORED_DIRS.has(name) || IGNORED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

export function listWorkspaceFiles(workspacePath: string, maxFiles = 2500): string[] {
  const files: string[] = [];
  const walk = (directory: string, relative = ""): void => {
    if (files.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const name of entries.sort((a, b) => a.localeCompare(b, "en"))) {
      const childRelative = relative ? `${relative}/${name}` : name;
      if (ignored(childRelative, name)) continue;
      const fullPath = path.join(directory, name);
      let isDirectory = false;
      let isFile = false;
      try {
        const stat = statSync(fullPath);
        isDirectory = stat.isDirectory();
        isFile = stat.isFile();
      } catch {
        continue;
      }
      if (isDirectory) {
        walk(fullPath, childRelative);
      } else if (isFile) {
        files.push(normalizePath(childRelative));
        if (files.length >= maxFiles) return;
      }
    }
  };
  walk(workspacePath);
  return files;
}

export function activeFileMention(text: string, cursor: number): ActiveFileMention | null {
  const safeCursor = Math.min(Math.max(0, cursor), text.length);
  const beforeCursor = text.slice(0, safeCursor);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(beforeCursor);
  if (!match) return null;
  const prefix = match[1] ?? "";
  const atOffset = beforeCursor.lastIndexOf("@");
  if (atOffset < 0) return null;
  return { prefix, start: atOffset, end: safeCursor };
}

function fuzzyScore(candidate: string, prefix: string): number {
  const lowerCandidate = candidate.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (!lowerPrefix) return 10;
  if (lowerCandidate.startsWith(lowerPrefix)) return 100 - candidate.length / 1000;
  const segmentIndex = lowerCandidate.lastIndexOf(`/${lowerPrefix}`);
  if (segmentIndex >= 0) return 80 - candidate.length / 1000;
  if (lowerCandidate.includes(lowerPrefix)) return 60 - candidate.length / 1000;

  let searchIndex = 0;
  for (const char of lowerPrefix) {
    const found = lowerCandidate.indexOf(char, searchIndex);
    if (found < 0) return 0;
    searchIndex = found + 1;
  }
  return 30 - candidate.length / 1000;
}

export function fileMentionSuggestions(files: string[], prefix: string, limit = 20): FileMentionSuggestion[] {
  return files
    .map((file) => ({ path: file, score: fuzzyScore(file, prefix) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, "en"))
    .slice(0, limit);
}

export function insertFileMention(text: string, mention: ActiveFileMention, filePath: string): { text: string; cursor: number } {
  const replacement = `@${filePath}`;
  const nextText = `${text.slice(0, mention.start)}${replacement}${text.slice(mention.end)}`;
  return {
    text: nextText,
    cursor: mention.start + replacement.length
  };
}
