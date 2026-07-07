import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isPathInside, resolveWorkspacePath, workspaceRelativePath } from "../policy.js";

const INSTRUCTION_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "SIGMA.md", ".agent/instructions.md"] as const;
const DEFAULT_PROJECT_DOC_MAX_BYTES = 32768;

export interface ProjectInstructionsOptions {
  workspacePath: string;
  workingDirectory?: string;
  maxBytes?: number;
  enabled?: boolean;
}

export interface LoadedProjectInstructions {
  content: string;
  sources: string[];
}

async function existingInstructionFile(dirPath: string): Promise<string | null> {
  for (const candidate of INSTRUCTION_CANDIDATES) {
    const filePath = path.join(dirPath, candidate);
    try {
      const info = await stat(filePath);
      if (info.isFile()) return filePath;
    } catch {
      // Missing instruction candidates are expected.
    }
  }
  return null;
}

function directoriesFromRoot(workspacePath: string, workingDirectory?: string): string[] {
  const workspace = path.resolve(workspacePath);
  if (!workingDirectory) return [workspace];
  const target = resolveWorkspacePath(workspace, workingDirectory);
  const dirs = [workspace];
  let current = workspace;
  for (const segment of path.relative(workspace, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    dirs.push(current);
  }
  return dirs;
}

export async function loadProjectInstructions(
  options: ProjectInstructionsOptions
): Promise<LoadedProjectInstructions> {
  if (options.enabled === false) return { content: "", sources: [] };
  const workspacePath = path.resolve(options.workspacePath);
  const maxBytes = Math.max(0, Math.floor(options.maxBytes ?? DEFAULT_PROJECT_DOC_MAX_BYTES));
  if (maxBytes === 0) return { content: "", sources: [] };

  const sections: string[] = [];
  const sources: string[] = [];
  let remainingBytes = maxBytes;

  for (const dir of directoriesFromRoot(workspacePath, options.workingDirectory)) {
    if (!isPathInside(workspacePath, dir)) continue;
    const filePath = await existingInstructionFile(dir);
    if (!filePath || !isPathInside(workspacePath, filePath)) continue;
    const buffer = await readFile(filePath);
    if (buffer.length === 0) continue;
    const slice = buffer.subarray(0, remainingBytes);
    const text = slice.toString("utf8").trim();
    if (!text) continue;
    const relative = workspaceRelativePath(workspacePath, filePath);
    sources.push(relative);
    sections.push(`--- ${relative} ---\n${text}`);
    remainingBytes -= slice.byteLength;
    if (remainingBytes <= 0) break;
  }

  return {
    content: sections.join("\n\n"),
    sources
  };
}

export function formatProjectInstructionsBlock(loaded: LoadedProjectInstructions): string {
  if (loaded.sources.length === 0 || !loaded.content) return "";
  return [
    "Project instructions loaded from:",
    loaded.sources.map((source) => `- ${source}`).join("\n"),
    "",
    loaded.content
  ].join("\n");
}

